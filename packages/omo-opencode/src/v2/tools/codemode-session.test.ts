import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function fakeModules(log: string[], managerOptions: unknown[] = []) {
  class SessionManagerProxy {
    beginReplacement() {
      return 1
    }
    async replace() {
      log.push("replace")
      return true
    }
    async dispose() {
      log.push("proxy.dispose")
    }
  }
  class HandleRegistry {
    dispose() {
      log.push("handles.dispose")
    }
  }
  class EvalDetachedCellManager {
    async dispose() {
      log.push("cells.dispose")
    }
  }
  return {
    root: "/opt/codemode",
    version: "2026.11.5-1",
    defaultCodemodeSettings: { cellTimeoutSeconds: 30 },
    resolveEnabledLanguages: () => ({ js: true, py: false }),
    resolveForegroundWindowSeconds: () => 30,
    resolveRunBudgetSeconds: () => 60,
    resolveHardLimitSeconds: () => 600,
    resolveMaxDetachedCells: () => 4,
    getInterpreterAvailability: async () => ({}),
    createInterpreterDetector: () => ({}),
    enabledLanguagesFrom: () => ({ js: true, py: false }),
    jsRuntimeInfo: () => ({}),
    runtimesFromAvailability: () => ({}),
    createCodemodeSessionManager: async (options: unknown) => {
      managerOptions.push(options)
      return {
        async dispose() {
          log.push("raw.dispose")
        },
        bridgeEndpoint: () => ({ port: 4242, token: "secret" }),
      }
    },
    createEvalTool: (options: { settings: unknown }) => ({
      name: "eval",
      description: "d",
      parameters: {},
      settings: options.settings,
      execute: async () => ({ content: [] }),
    }),
    SessionManagerProxy,
    HandleRegistry,
    EvalDetachedCellManager,
    kernelToolsStorage: { getStore: () => undefined },
    kernelRegistry: { list: () => [] },
  } as unknown as import("./codemode-loader").CodemodeModules
}

describe("eval session runtime", () => {
  const stateRoot = mkdtempSync(join(tmpdir(), "omo-eval-runtime-"))
  afterAll(() => rmSync(stateRoot, { recursive: true, force: true }))
  const input = (signal: AbortSignal) => ({
    sessionID: "ses_1",
    cwd: "/project",
    stateDir: stateRoot,
    sandbox: true,
    ownedTools: [],
    signal,
  })

  test("#given a runtime #when it is disposed twice #then handles, cells and kernels go once each in that order, and settings carry the sandbox", async () => {
    // given
    const { createEvalSessionRuntime } = await import("./codemode-session")
    const log: string[] = []
    const runtime = await createEvalSessionRuntime(fakeModules(log), input(new AbortController().signal))

    // when
    await Promise.all([runtime.dispose(), runtime.dispose()])

    // then
    expect(log).toEqual(["replace", "handles.dispose", "cells.dispose", "proxy.dispose"])
    expect(runtime.bridgeEndpoint()).toEqual({ port: 4242 })
    expect((runtime.tool as unknown as { settings: { sandbox: unknown } }).settings.sandbox).toEqual({ enabled: true })
  })

  test("#given a session environment #when the runtime is created #then codemode's session manager receives it for every kernel", async () => {
    // given
    const { createEvalSessionRuntime } = await import("./codemode-session")
    const managerOptions: unknown[] = []
    const sessionEnv = { PI_SESSION_ID: "ses_1", PI_SESSION_CWD: "/project" }

    // when
    const runtime = await createEvalSessionRuntime(fakeModules([], managerOptions), {
      ...input(new AbortController().signal),
      sessionEnv,
    })

    // then
    expect(managerOptions).toEqual([expect.objectContaining({ sessionId: "ses_1", sessionEnv })])
    await runtime.dispose()
  })

  test("#given a creation aborted before the proxy owns the manager #when it unwinds #then the raw manager itself is disposed", async () => {
    // given
    const { createEvalSessionRuntime } = await import("./codemode-session")
    const log: string[] = []
    const controller = new AbortController()
    const modules = fakeModules(log)
    const create = modules.createCodemodeSessionManager as unknown as () => Promise<unknown>
    Object.assign(modules, {
      createCodemodeSessionManager: async () => {
        const raw = await create()
        controller.abort(Error("released"))
        return raw
      },
    })

    // when
    const error = await createEvalSessionRuntime(modules, input(controller.signal)).catch((caught: unknown) => caught)

    // then
    expect((error as Error).message).toBe("released")
    expect(log).toEqual(["raw.dispose"])
  })

  test("#given concurrent calls #when they run through exclusive #then they never overlap and an aborted waiter is skipped", async () => {
    // given
    const { createEvalSessionRuntime } = await import("./codemode-session")
    const runtime = await createEvalSessionRuntime(fakeModules([]), input(new AbortController().signal))
    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    const aborted = new AbortController()

    // when
    const first = runtime.exclusive(new AbortController().signal, async () => {
      order.push("first:start")
      await gate.promise
      order.push("first:end")
    })
    const skipped = runtime
      .exclusive(aborted.signal, async () => {
        order.push("skipped")
      })
      .catch((error: unknown) => error)
    const second = runtime.exclusive(new AbortController().signal, async () => {
      order.push("second")
    })
    aborted.abort(Error("gone"))
    gate.resolve()
    await Promise.all([first, second])

    // then
    expect(order).toEqual(["first:start", "first:end", "second"])
    expect(((await skipped) as Error).message).toBe("gone")
    await runtime.dispose()
  })

  test("#given owned kernel preludes #when the eval tool is built #then codemode gets the per-cell reader and the documented preludes", async () => {
    // given
    const { createEvalSessionRuntime } = await import("./codemode-session")
    const modules = fakeModules([])
    const seen: Record<string, unknown>[] = []
    Object.assign(modules, {
      createEvalTool: (options: Record<string, unknown>) => {
        seen.push(options)
        return { name: "eval", description: "d", parameters: {}, execute: async () => ({ content: [] }) }
      },
    })
    const computer = {
      javascript: "globalThis.computer = {}",
      python: "computer = None",
      documentation: "computer.*",
      exports: ["computer"],
    }
    let installed = [computer]

    // when
    const runtime = await createEvalSessionRuntime(modules, {
      ...input(new AbortController().signal),
      kernelPreludes: () => installed,
      promptKernelPreludes: [computer],
    })
    const options = seen[0] as { kernelPreludes?: () => unknown; promptKernelPreludes?: unknown }
    const first = options.kernelPreludes?.()
    installed = []
    const second = options.kernelPreludes?.()

    // then
    expect(first).toEqual([computer])
    expect(second).toEqual([])
    expect(options.promptKernelPreludes).toEqual([computer])
    await runtime.dispose()
  })
})
