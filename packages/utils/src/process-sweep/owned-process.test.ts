import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { sweepOrphanedLspDaemonProxies } from "./sweeper"
import { OWNED_PROCESS_STOP_BOUND_MS, runOwnedProcess } from "./owned-process"
import { aliveAfter, createWedgedTrees } from "./wedged-tree.test-support"

const trees = createWedgedTrees()
const homes: string[] = []

afterEach(() => {
  trees.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe("owned process cancellation", () => {
  it(
    "#given an owned command that ignores SIGTERM and started a descendant #when aborted #then it settles within the bound and neither process survives",
    async () => {
      // given
      const { command, args, pids: started } = trees.tree()
      const controller = new AbortController()
      const run = runOwnedProcess(command, args, { signal: controller.signal })
      const settled = run.then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      )
      const pids = await started()

      // when
      const abortedAt = Date.now()
      controller.abort()
      const outcome = await settled

      // then
      expect(outcome).toBe("AbortError")
      expect(Date.now() - abortedAt).toBeLessThan(OWNED_PROCESS_STOP_BOUND_MS)
      expect(await aliveAfter([pids.child, pids.descendant], 2_000)).toEqual([])
    },
    { timeout: 30_000 },
  )

  it(
    "#given a sweep whose termination runs a wedged owned tree #when the sweep is aborted #then it settles within the bound, writes no stamp and leaves no owned process",
    async () => {
      // given
      const { command, args, pids: started } = trees.tree()
      const homeDir = mkdtempSync(join(tmpdir(), "owned-process-sweep-"))
      homes.push(homeDir)
      const controller = new AbortController()
      const sweep = sweepOrphanedLspDaemonProxies({
        force: true,
        graceMs: 0,
        homeDir,
        ownedRoots: ["/tmp/omo-plugin"],
        platform: "linux",
        signal: controller.signal,
        processProvider: async () => [
          { command: "node /tmp/omo-plugin/components/lsp-daemon/dist/cli.js mcp", pid: 401, ppid: 1 },
        ],
        killer: {
          isAlive: () => true,
          kill: async () => undefined,
          terminate: (_pid, signal) =>
            runOwnedProcess(command, args, signal === undefined ? {} : { signal }).then(() => undefined),
        },
      })
      const pids = await started()

      // when
      const abortedAt = Date.now()
      controller.abort()
      const result = await sweep

      // then
      expect(result.action).toBe("failed")
      expect(Date.now() - abortedAt).toBeLessThan(OWNED_PROCESS_STOP_BOUND_MS)
      expect(existsSync(result.stampFile)).toBe(false)
      expect(await aliveAfter([pids.child, pids.descendant], 2_000)).toEqual([])
    },
    { timeout: 30_000 },
  )

  it("#given a termination step that ignores the abort entirely #when the sweep is aborted #then the sweep still settles within its stop bound", async () => {
    // given
    const homeDir = mkdtempSync(join(tmpdir(), "owned-process-hung-"))
    homes.push(homeDir)
    const controller = new AbortController()
    const terminateCalled = Promise.withResolvers<void>()
    const sweep = sweepOrphanedLspDaemonProxies({
      force: true,
      graceMs: 0,
      homeDir,
      ownedRoots: ["/tmp/omo-plugin"],
      platform: "linux",
      signal: controller.signal,
      stopBoundMs: 200,
      processProvider: async () => [
        { command: "node /tmp/omo-plugin/components/lsp-daemon/dist/cli.js mcp", pid: 401, ppid: 1 },
      ],
      killer: {
        isAlive: () => true,
        kill: async () => undefined,
        terminate: () => {
          terminateCalled.resolve()
          return new Promise<void>(() => {})
        },
      },
    })
    await terminateCalled.promise

    // when
    const abortedAt = Date.now()
    controller.abort()
    const result = await sweep

    // then
    expect(result.action).toBe("failed")
    expect(Date.now() - abortedAt).toBeLessThan(2_000)
  })
})
