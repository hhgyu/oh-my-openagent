import { describe, expect, test } from "bun:test"
import { CODEMODE_VERSION, CodemodeUnavailableError, createCodemodeLoader } from "./codemode-loader"

const EXPORTS: Record<string, Record<string, unknown>> = {
  "eval-tool.ts": { createEvalTool: () => ({}) },
  "session-manager.ts": { createCodemodeSessionManager: () => ({}) },
  "session-manager-proxy.ts": { SessionManagerProxy: class {} },
  "handle-registry.ts": { HandleRegistry: class {} },
  "detached-cell-manager.ts": { EvalDetachedCellManager: class {} },
  "settings.ts": { defaultCodemodeSettings: {}, resolveEnabledLanguages: () => ({}), resolveForegroundWindowSeconds: () => 1, resolveRunBudgetSeconds: () => 1, resolveHardLimitSeconds: () => 1, resolveMaxDetachedCells: () => 1 },
  "detect.ts": { getInterpreterAvailability: () => ({}), createInterpreterDetector: () => ({}) },
  "runtime-factory.ts": { enabledLanguagesFrom: () => ({}) },
  "runtime-info.ts": { jsRuntimeInfo: () => ({}), runtimesFromAvailability: () => ({}) },
  "kernel-registry.ts": { kernelRegistry: { list: () => [{ pid: 4242 }] } },
  "index.js": { kernelToolsStorage: { getStore: () => undefined } },
}

function fakeImport(log: string[], override?: (url: string) => Promise<Record<string, unknown>> | undefined) {
  return (url: string) => {
    log.push(url)
    const custom = override?.(url)
    if (custom) return custom
    const file = Object.keys(EXPORTS).find(name => url.endsWith(`/${name}`))
    return file ? Promise.resolve(EXPORTS[file] ?? {}) : Promise.reject(Error(`unexpected import ${url}`))
  }
}

const base = { resolveRoot: () => "/opt/codemode", readVersion: () => CODEMODE_VERSION, resolveSenpi: () => "/opt/senpi/dist/index.js" }

describe("codemode loader", () => {
  test("#given concurrent callers #when the package loads #then one import graph is shared and memoized", async () => {
    // given
    const log: string[] = []
    const loader = createCodemodeLoader({ ...base, importModule: fakeImport(log) })

    // when
    const [first, second] = await Promise.all([loader.load(), loader.load()])
    const third = await loader.load()

    // then
    expect(first).toBe(second)
    expect(third).toBe(first)
    expect(loader.loaded()).toBe(first)
    expect(log).toHaveLength(11)
    expect(log.every(url => url.startsWith("file:"))).toBe(true)
    expect(first.version).toBe(CODEMODE_VERSION)
    expect(first.kernelRegistry.list()).toEqual([{ pid: 4242 }])
  })

  test("#given an import that never settles #when the timeout passes #then the model reads an unavailable error and a retry joins the same import", async () => {
    // given
    const log: string[] = []
    const gate = Promise.withResolvers<Record<string, unknown>>()
    const loader = createCodemodeLoader({ ...base, timeoutMs: 20, importModule: fakeImport(log, url => url.endsWith("/eval-tool.ts") ? gate.promise : undefined) })

    // when
    const first = await loader.load().catch((error: unknown) => error)
    const retry = loader.load()
    gate.resolve(EXPORTS["eval-tool.ts"] ?? {})
    const loaded = await retry

    // then
    expect(first).toBeInstanceOf(CodemodeUnavailableError)
    expect((first as Error).message).toContain("did not finish loading")
    expect(log).toHaveLength(11)
    expect(loaded.version).toBe(CODEMODE_VERSION)
  })

  test("#given the package is not installed #when loading #then the error names the missing runtime dependency", async () => {
    // given
    const loader = createCodemodeLoader({ ...base, resolveRoot: () => { throw Error("Cannot find package") } })

    // when
    const error = await loader.load().catch((caught: unknown) => caught)

    // then
    expect(error).toBeInstanceOf(CodemodeUnavailableError)
    expect((error as Error).message).toContain("@code-yeongyu/senpi-codemode is not installed")
  })

  test("#given another codemode version #when loading #then it is refused instead of guessed at", async () => {
    // given
    const loader = createCodemodeLoader({ ...base, readVersion: () => "2099.1.1" })

    // when
    const error = await loader.load().catch((caught: unknown) => caught)

    // then
    expect((error as Error).message).toContain(`only ${CODEMODE_VERSION}`)
  })

  test("#given a failed import #when loading again #then the second call retries", async () => {
    // given
    const log: string[] = []
    let fail = true
    const loader = createCodemodeLoader({ ...base, importModule: fakeImport(log, url => url.endsWith("/detect.ts") && fail ? Promise.reject(Error("boom")) : undefined) })

    // when
    const error = await loader.load().catch((caught: unknown) => caught)
    fail = false
    const loaded = await loader.load()

    // then
    expect((error as Error).message).toContain("loading @code-yeongyu/senpi-codemode failed (boom)")
    expect(loaded.version).toBe(CODEMODE_VERSION)
  })

  test("#given a module without a required export #when loading #then the shape mismatch is reported", async () => {
    // given
    const loader = createCodemodeLoader({ ...base, importModule: fakeImport([], url => url.endsWith("/index.js") ? Promise.resolve({}) : undefined) })

    // when
    const error = await loader.load().catch((caught: unknown) => caught)

    // then
    expect((error as Error).message).toContain("kernelToolsStorage is missing")
  })
})
