import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import {
  collectVolumeSnapshotEvidence,
  publishVolumeSnapshotEvidence,
  type CollectorRun,
  type EvidenceFiles,
  type VolumeSnapshotEvidence,
  volumeSnapshotEvidencePath,
} from "./volume-snapshot-diagnostics"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const json = (row: Record<string, unknown>) => JSON.stringify(row)

// What the PowerShell collector prints: one JSON object per line, in whatever order the providers answered.
const COLLECTOR_STDOUT = [
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

const runner = (run: CollectorRun) => async () => run
const EMPTY: VolumeSnapshotEvidence = { windowMinutes: 10, events: [], providerErrors: [], vssvc: [], unparsed: [] }
const RECORD_BODY = `${JSON.stringify({ pid: 9008, processes: "the process table taken before the kill" }, null, 2)}\n`

async function timeoutRecord(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "volume-snapshot-record-"))
  roots.push(root)
  const path = join(root, "git-timeout-9008.json")
  await writeFile(path, RECORD_BODY)
  return path
}

async function published(recordPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(volumeSnapshotEvidencePath(recordPath), "utf8")) as Record<string, unknown>
}

/** The real files, with hooks that can stall or fail a write and observe each removal. */
function files(onWrite?: (path: string) => Promise<void> | void, onRemoved?: (path: string) => void): EvidenceFiles {
  return {
    write: async (path, data) => {
      await onWrite?.(path)
      await writeFile(path, data, { flag: "wx" })
    },
    rename: (from, to) => rename(from, to),
    remove: async (path) => {
      await rm(path, { force: true })
      onRemoved?.(path)
    },
  }
}

/** A deadline the test fires by hand. */
function manualDeadline() {
  let fire: (() => void) | undefined
  return {
    schedule: (callback: () => void) => {
      fire = callback
      return () => {
        fire = undefined
      }
    },
    fire: () => fire?.(),
    armed: () => fire !== undefined,
  }
}

describe("volume snapshot evidence collection", () => {
  test("#given output with events, a provider error and a VSSVC row #when collected #then events are UTC-ordered and the provider error stays isolated", async () => {
    // #when
    const evidence = await collectVolumeSnapshotEvidence(runner({ stdout: COLLECTOR_STDOUT, stderr: "", exitCode: 0 }))

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

  test("#given a collector that exits nonzero with no stdout #when collected #then it fails with the exit code and stderr", async () => {
    // #when
    const failure = await collectVolumeSnapshotEvidence(
      runner({ stdout: "", stderr: "Get-WinEvent : Access is denied", exitCode: 1 }),
    ).catch((error: unknown) => error)

    // #then
    expect(failure).toMatchObject({
      name: "VolumeSnapshotCollectorError",
      exitCode: 1,
      stderr: "Get-WinEvent : Access is denied",
      partial: { events: [] },
    })
  })
})

describe("volume snapshot evidence publishing", () => {
  test("#given a collected result before the deadline #when published #then the sibling holds it and the record is byte-identical", async () => {
    // #given
    const path = await timeoutRecord()
    const deadline = manualDeadline()
    const evidence = await collectVolumeSnapshotEvidence(runner({ stdout: COLLECTOR_STDOUT, stderr: "", exitCode: 0 }))

    // #when
    await publishVolumeSnapshotEvidence(path, {
      platform: "win32",
      collect: async () => evidence,
      schedule: deadline.schedule,
    })

    // #then
    expect(await readFile(path, "utf8")).toBe(RECORD_BODY)
    expect(await published(path)).toMatchObject({
      volumeShadowCopy: { events: evidence.events, vssvc: evidence.vssvc },
    })
    expect(deadline.armed()).toBe(false)
    expect((await readdir(dirname(path))).sort()).toEqual([basename(path), basename(volumeSnapshotEvidencePath(path))])
  })

  test("#given a collector that exits nonzero #when published #then the sibling records the error with exit code and stderr", async () => {
    // #given
    const path = await timeoutRecord()
    const deadline = manualDeadline()

    // #when
    await publishVolumeSnapshotEvidence(path, {
      platform: "win32",
      collect: () =>
        collectVolumeSnapshotEvidence(runner({ stdout: "", stderr: "Get-WinEvent : Access is denied", exitCode: 1 })),
      schedule: deadline.schedule,
    })

    // #then
    expect(await readFile(path, "utf8")).toBe(RECORD_BODY)
    expect(await published(path)).toEqual({
      error: "volume snapshot collector exited 1",
      exitCode: 1,
      stderr: "Get-WinEvent : Access is denied",
      partial: EMPTY,
    })
  })

  test("#given a result whose write stalls past the deadline #when the deadline fires #then the timeout marker is published and the late result never is", async () => {
    // #given
    const path = await timeoutRecord()
    const deadline = manualDeadline()
    const stalled = Promise.withResolvers<void>()
    const staleTempRemoved = Promise.withResolvers<string>()
    let stalledTemp = ""
    let writes = 0
    const publishing = publishVolumeSnapshotEvidence(path, {
      platform: "win32",
      deadlineMs: 50,
      collect: async () => EMPTY,
      schedule: deadline.schedule,
      files: files(
        async (temp) => {
          writes += 1
          if (writes !== 1) return
          stalledTemp = temp
          await stalled.promise
        },
        (removed) => {
          if (removed === stalledTemp) staleTempRemoved.resolve(removed)
        },
      ),
    })
    while (writes === 0) await Promise.resolve()

    // #when
    deadline.fire()
    await publishing
    stalled.resolve()
    await staleTempRemoved.promise

    // #then
    expect(await readFile(path, "utf8")).toBe(RECORD_BODY)
    expect(await published(path)).toEqual({ error: "not collected within 50 ms" })
    expect((await readdir(dirname(path))).sort()).toEqual([basename(path), basename(volumeSnapshotEvidencePath(path))])
  })

  test("#given a collector still running at the deadline #when it finishes later #then its result is discarded without touching the disk", async () => {
    // #given
    const path = await timeoutRecord()
    const deadline = manualDeadline()
    const late = Promise.withResolvers<VolumeSnapshotEvidence>()
    const publishing = publishVolumeSnapshotEvidence(path, {
      platform: "win32",
      deadlineMs: 50,
      collect: () => late.promise,
      schedule: deadline.schedule,
    })

    // #when
    deadline.fire()
    await publishing
    late.resolve(EMPTY)
    for (let tick = 0; tick < 5; tick++) await Promise.resolve()

    // #then
    expect(await published(path)).toEqual({ error: "not collected within 50 ms" })
    expect((await readdir(dirname(path))).sort()).toEqual([basename(path), basename(volumeSnapshotEvidencePath(path))])
  })

  test("#given the evidence write fails #when published #then the record is byte-identical and no partial sibling exists", async () => {
    // #given
    const path = await timeoutRecord()
    const deadline = manualDeadline()

    // #when
    await publishVolumeSnapshotEvidence(path, {
      platform: "win32",
      collect: async () => EMPTY,
      schedule: deadline.schedule,
      files: files(() => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      }),
    })

    // #then
    expect(await readFile(path, "utf8")).toBe(RECORD_BODY)
    expect(await readdir(dirname(path))).toEqual([basename(path)])
    expect(deadline.armed()).toBe(false)
  })

  test("#given a non-Windows platform #when published #then nothing is collected or written", async () => {
    // #given
    const path = await timeoutRecord()
    let collected = false

    // #when
    await publishVolumeSnapshotEvidence(path, {
      platform: "linux",
      collect: async () => {
        collected = true
        return EMPTY
      },
    })

    // #then
    expect(collected).toBe(false)
    expect(await readdir(dirname(path))).toEqual([basename(path)])
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
