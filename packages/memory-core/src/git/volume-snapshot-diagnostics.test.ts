import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  appendVolumeSnapshotEvidence,
  collectVolumeSnapshotEvidence,
  type VolumeSnapshotEvidence,
} from "./volume-snapshot-diagnostics"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const json = (row: Record<string, unknown>) => JSON.stringify(row)

// What the PowerShell collector prints: one JSON object per line, in whatever order the providers answered.
const COLLECTOR_OUTPUT = [
  json({
    kind: "event",
    provider: "volsnap",
    log: "System",
    id: 25,
    level: "Error",
    timeUtc: "2026-11-26T00:02:30.0000000Z",
    message: "The shadow copies of volume C: were deleted",
  }),
  json({
    kind: "event",
    provider: "VSS",
    log: "Application",
    id: 8224,
    level: "Information",
    timeUtc: "2026-11-26T00:02:12.5000000Z",
    message: "The VSS service is starting",
  }),
  json({
    kind: "providerError",
    provider: "VSSVC",
    error: 'There is not an event provider on the localhost computer that matches "VSSVC".',
  }),
  json({ kind: "vssvc", pid: 4242, ppid: 600, createdUtc: "2026-11-26T00:02:12.0000000Z" }),
  "WARNING: something PowerShell printed that is not a record",
].join("\r\n")

const EMPTY: VolumeSnapshotEvidence = { windowMinutes: 10, events: [], providerErrors: [], vssvc: [], unparsed: [] }

async function timeoutRecord(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "volume-snapshot-record-"))
  roots.push(root)
  const path = join(root, "git-timeout-9008.json")
  await writeFile(path, `${JSON.stringify({ pid: 9008, processes: "the process table taken before the kill" })}\n`)
  return path
}

async function readRecord(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

describe("volume snapshot evidence collection", () => {
  test("#given collector output with events, a provider error and a VSSVC row #when parsed #then events are ordered by UTC time and the provider error stays isolated", async () => {
    // #when
    const evidence = await collectVolumeSnapshotEvidence(async () => COLLECTOR_OUTPUT)

    // #then
    expect(evidence.events.map((event) => [event.timeUtc, event.provider, event.id])).toEqual([
      ["2026-11-26T00:02:12.5000000Z", "VSS", 8224],
      ["2026-11-26T00:02:30.0000000Z", "volsnap", 25],
    ])
    expect(evidence.providerErrors).toEqual([
      { provider: "VSSVC", error: 'There is not an event provider on the localhost computer that matches "VSSVC".' },
    ])
    expect(evidence.vssvc).toEqual([{ pid: 4242, ppid: 600, createdUtc: "2026-11-26T00:02:12.0000000Z" }])
    expect(evidence.unparsed).toEqual(["WARNING: something PowerShell printed that is not a record"])
  })

  test("#given a runner that fails #when collected #then the failure propagates to the caller", async () => {
    // #when
    const outcome = await collectVolumeSnapshotEvidence(async () => {
      throw new Error("powershell missing")
    }).then(
      () => "collected",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    // #then
    expect(outcome).toBe("powershell missing")
  })
})

describe("volume snapshot evidence in a git timeout record", () => {
  test("#given a collected result #when appended #then the record keeps its process snapshot and gains the evidence", async () => {
    // #given
    const path = await timeoutRecord()
    const evidence = await collectVolumeSnapshotEvidence(async () => COLLECTOR_OUTPUT)

    // #when
    await appendVolumeSnapshotEvidence(path, { platform: "win32", collect: async () => evidence })

    // #then
    const record = await readRecord(path)
    expect(record["processes"]).toBe("the process table taken before the kill")
    expect(record["volumeShadowCopy"]).toMatchObject({ events: evidence.events, vssvc: evidence.vssvc })
  })

  test("#given a collector that throws #when appended #then the process snapshot is kept and the failure is marked", async () => {
    // #given
    const path = await timeoutRecord()

    // #when
    await appendVolumeSnapshotEvidence(path, {
      platform: "win32",
      collect: async () => {
        throw new Error("Get-WinEvent exploded")
      },
    })

    // #then
    const record = await readRecord(path)
    expect(record["processes"]).toBe("the process table taken before the kill")
    expect(record["volumeShadowCopyError"]).toBe("Get-WinEvent exploded")
    expect(Object.keys(record)).not.toContain("volumeShadowCopy")
  })

  test("#given a collector that outlives the deadline #when appended #then it settles at the deadline and a late result never writes", async () => {
    // #given
    const path = await timeoutRecord()
    const late = Promise.withResolvers<VolumeSnapshotEvidence>()
    const deadlineMs = 200

    // #when
    const startedAt = performance.now()
    await appendVolumeSnapshotEvidence(path, { platform: "win32", deadlineMs, collect: () => late.promise })
    const elapsedMs = performance.now() - startedAt
    late.resolve(EMPTY)
    for (let tick = 0; tick < 5; tick++) await Promise.resolve()

    // #then
    expect(elapsedMs).toBeGreaterThanOrEqual(deadlineMs - 5)
    expect(elapsedMs).toBeLessThan(deadlineMs + 1_000)
    const record = await readRecord(path)
    expect(record["processes"]).toBe("the process table taken before the kill")
    expect(record["volumeShadowCopyError"]).toBe(`not collected within ${deadlineMs} ms`)
    expect(Object.keys(record)).not.toContain("volumeShadowCopy")
  })

  test("#given a non-Windows platform #when appended #then nothing is collected and the record is untouched", async () => {
    // #given
    const path = await timeoutRecord()
    const before = await readFile(path, "utf8")
    let collected = false

    // #when
    await appendVolumeSnapshotEvidence(path, {
      platform: "linux",
      collect: async () => {
        collected = true
        return EMPTY
      },
    })

    // #then
    expect(collected).toBe(false)
    expect(await readFile(path, "utf8")).toBe(before)
  })
})

describe("volume snapshot evidence on a real Windows host", () => {
  test.skipIf(process.platform !== "win32")(
    "#given the real collector #when it runs #then every line parses, events carry UTC timestamps, and it settles within its deadline",
    async () => {
      // #when
      const startedAt = performance.now()
      const evidence = await collectVolumeSnapshotEvidence()
      const elapsedMs = performance.now() - startedAt

      // #then
      expect(evidence.unparsed).toEqual([])
      for (const event of evidence.events) expect(event.timeUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/)
      expect(evidence.providerErrors.length + evidence.events.length).toBeGreaterThan(0)
      expect(elapsedMs).toBeLessThan(10_000)
    },
  )

  test.skipIf(process.platform !== "win32")(
    "#given a deadline the collector cannot meet #when it runs #then it rejects at that deadline instead of waiting",
    async () => {
      // #when
      const startedAt = performance.now()
      const outcome = await collectVolumeSnapshotEvidence(undefined, 1).then(
        () => "collected",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )

      // #then
      expect(outcome).toBe("volume snapshot collector did not finish within 1 ms")
      expect(performance.now() - startedAt).toBeLessThan(2_000)
    },
  )
})
