import { readSessionRole } from "@oh-my-opencode/senpi-task"
import { sweepOrphanedLspDaemonProxies, sweepStaleLspDaemonVersions } from "@oh-my-opencode/utils/process-sweep"

import type { ComponentContext, SenpiExtensionAPI } from "../../extension/types"
import { resolveSenpiDaemonRuntime } from "../lsp/daemon-runtime"

// Unconditional omo process hygiene for the senpi adapter (T16): fired on
// extension session start, mirroring the task component's session-start
// recovery chain event ("session_start"). No config keys — hygiene always
// runs and each family self-throttles via its stamp file inside the sweep
// functions. Mirrors the codex best-effort process-sweep pattern
// (packages/omo-codex/plugin/components/ — codex hook-sweep.ts).

export type OmoFamilySweep = (signal: AbortSignal) => Promise<unknown>

interface OmoFamilySweeps {
  readonly sweepLspProxies: (options: {
    readonly log?: (message: string) => void
    readonly signal?: AbortSignal
  }) => Promise<unknown>
  readonly sweepStaleLspDaemons: (options: {
    readonly currentVersion: string
    readonly log?: (message: string) => void
    readonly signal?: AbortSignal
  }) => Promise<unknown>
}

const DEFAULT_FAMILY_SWEEPS: OmoFamilySweeps = {
  sweepLspProxies: sweepOrphanedLspDaemonProxies,
  sweepStaleLspDaemons: sweepStaleLspDaemonVersions,
}

export interface SessionStartProcessSweepOptions {
  readonly env?: Record<string, string | undefined>
  readonly sweep?: OmoFamilySweep
  readonly resolveDaemonVersion?: (env: Record<string, string | undefined>) => string
  readonly familySweeps?: OmoFamilySweeps
}

export function wireSessionStartProcessSweep(
  pi: SenpiExtensionAPI,
  ctx: ComponentContext,
  options: SessionStartProcessSweepOptions = {},
): void {
  const env = options.env ?? process.env
  const resolveDaemonVersion =
    options.resolveDaemonVersion ?? ((runtimeEnv) => resolveSenpiDaemonRuntime(runtimeEnv).version)
  const sweep =
    options.sweep ??
    ((signal: AbortSignal) => {
      return sweepOmoFamiliesBestEffort(ctx, () => resolveDaemonVersion(env), signal, options.familySweeps)
    })
  const running = new Set<{ readonly controller: AbortController; readonly settled: Promise<void> }>()

  pi.on("session_start", () => {
    // Machine hygiene belongs to the process the USER launched. A task child - its own process, or
    // a session of the shared daemon - never sweeps: on the daemon it would sweep for every child.
    const role = readSessionRole(pi, env)
    if (role !== undefined) {
      ctx.logger.info("omo-senpi process sweep skipped: running as a senpi-task child session", { role })
      return undefined
    }
    const controller = new AbortController()
    const entry = { controller, settled: runSweepBestEffort(sweep, controller.signal, ctx) }
    running.add(entry)
    void entry.settled.then(() => running.delete(entry))
    return undefined
  })
  // The sweep spawns process enumerations (PowerShell on win32) that inherit this process's env. A
  // shutdown stops them and waits until they exited, so none outlives the extension it belonged to.
  pi.on("session_shutdown", async () => {
    const pending = [...running]
    for (const { controller } of pending) controller.abort()
    await Promise.all(pending.map(({ settled }) => settled))
  })
}

/** Never blocks the session-start chain and never rejects; settles once the sweep and its children are done. */
function runSweepBestEffort(sweep: OmoFamilySweep, signal: AbortSignal, ctx: ComponentContext): Promise<void> {
  try {
    return Promise.resolve()
      .then(() => sweep(signal))
      .then(
        () => undefined,
        (error: unknown) => {
          ctx.logger.warn("omo-senpi process sweep failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
  } catch (error) {
    ctx.logger.warn("omo-senpi process sweep failed to start", {
      error: error instanceof Error ? error.message : String(error),
    })
    return Promise.resolve()
  }
}

async function sweepOmoFamiliesBestEffort(
  ctx: ComponentContext,
  resolveLspDaemonVersion: () => string,
  signal: AbortSignal,
  sweeps: OmoFamilySweeps = DEFAULT_FAMILY_SWEEPS,
): Promise<void> {
  const log = (message: string): void => {
    ctx.logger.warn(message)
  }
  await Promise.all([
    bestEffort("lsp-daemon proxy sweep", log, () => sweeps.sweepLspProxies({ log, signal })),
    bestEffort("lsp-daemon stale-version sweep", log, () => {
      const currentVersion = resolveLspDaemonVersion()
      return sweeps.sweepStaleLspDaemons({ currentVersion, log, signal })
    }),
  ])
}

async function bestEffort(
  familyLabel: string,
  log: (message: string) => void,
  sweep: () => Promise<unknown>,
): Promise<void> {
  try {
    await sweep()
  } catch (error) {
    log(`${familyLabel} skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}
