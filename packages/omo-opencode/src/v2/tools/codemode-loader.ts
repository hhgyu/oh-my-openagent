// Lazy loader for `@code-yeongyu/senpi-codemode`, the runtime behind the Native `eval` tool. It runs
// inside the codemode worker only (codemode-worker-runtime.ts), never on OpenCode's main thread.
// The package resolves its worker entries and kernel preludes next to its own modules, so it is imported
// from the INSTALLED package and never bundled (bundling breaks asset resolution and makes Bun auto-install
// quickjs-wasi): it is a V2 build external, and every import takes a computed file URL. Settings are built
// by the caller: nothing here reads `~/.senpi/agent/codemode.json`.

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const CODEMODE_PACKAGE = "@code-yeongyu/senpi-codemode"
/** The only version these structural types were checked against; any other is refused, never guessed at. */
export const CODEMODE_VERSION = "2026.11.5-1"
const DEFAULT_CODEMODE_LOAD_TIMEOUT_MS = 120_000 // the S9c spike's slowest in-host import took about 20 s

type Fn = (...args: never[]) => unknown
type Ctor = abstract new (...args: never[]) => unknown

/** Structural slice of codemode V2 uses, typed loosely: never type-imported; the version pin guards drift. */
export interface CodemodeModules {
  readonly root: string
  readonly version: string
  readonly createEvalTool: Fn
  readonly createCodemodeSessionManager: Fn
  readonly SessionManagerProxy: Ctor
  readonly HandleRegistry: Ctor
  readonly EvalDetachedCellManager: Ctor
  readonly defaultCodemodeSettings: Record<string, unknown>
  readonly resolveEnabledLanguages: Fn
  readonly resolveForegroundWindowSeconds: Fn
  readonly resolveRunBudgetSeconds: Fn
  readonly resolveHardLimitSeconds: Fn
  readonly resolveMaxDetachedCells: Fn
  readonly getInterpreterAvailability: Fn
  readonly createInterpreterDetector: Fn
  readonly enabledLanguagesFrom: Fn
  readonly jsRuntimeInfo: Fn
  readonly runtimesFromAvailability: Fn
  /** codemode's OWN senpi copy: the JS kernel publishes the live cell capability on this storage,
   * which is a different instance from any senpi code bundled into V2. */
  readonly kernelToolsStorage: { getStore(): unknown }
  /** Thread-wide kernel registry; its listings carry the pid of each subprocess kernel (py/rb/jl). */
  readonly kernelRegistry: { list(): readonly unknown[] }
}

/** Model-visible refusal: the message is what the model reads when `eval` cannot run. */
export class CodemodeUnavailableError extends Error {
  override readonly name = "CodemodeUnavailableError"
}

type ImportModule = (url: string) => Promise<Record<string, unknown>>

export interface CodemodeLoaderOptions {
  /** Absolute package root of the installed codemode; defaults to Bun resolution from this module. */
  readonly resolveRoot?: () => string
  readonly importModule?: ImportModule
  readonly readVersion?: (root: string) => string
  /** Entry of the senpi copy codemode itself resolves; defaults to Bun resolution from the package. */
  readonly resolveSenpi?: (root: string) => string
  readonly timeoutMs?: number
}

export interface CodemodeLoader {
  /** Memoized: concurrent and later callers share one import; a failed import is retried next call. */
  load(): Promise<CodemodeModules>
  /** The loaded modules, or undefined while loading, after a failure, or before the first call. */
  loaded(): CodemodeModules | undefined
}

const SOURCES = {
  evalTool: "src/tool/eval-tool.ts",
  sessionManager: "src/extension/session-manager.ts",
  proxy: "src/extension/session-manager-proxy.ts",
  handles: "src/handles/handle-registry.ts",
  cells: "src/tool/detached-cell-manager.ts",
  settings: "src/config/settings.ts",
  detect: "src/interpreters/detect.ts",
  runtimeFactory: "src/extension/runtime-factory.ts",
  runtimeInfo: "src/extension/runtime-info.ts",
  kernels: "src/extension/kernel-registry.ts",
} as const

function packageDirectory(entry: string, name: string): string {
  let directory = dirname(entry)
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as { name?: unknown }
      if (manifest.name === name) return directory
    } catch {
      /* No readable manifest here: keep walking up. */
    }
    const parent = dirname(directory)
    if (parent === directory) throw Error(`${name} package root not found above ${entry}`)
    directory = parent
  }
}

/** The published root package depends on codemode directly. A development checkout whose install
 * predates that dependency still reaches the copy the installed senpi depends on. */
function resolveCodemodeRoot(from: string = import.meta.dir): string {
  try {
    return dirname(Bun.resolveSync(`${CODEMODE_PACKAGE}/package.json`, from))
  } catch (direct) {
    try {
      const senpi = packageDirectory(Bun.resolveSync("@code-yeongyu/senpi", from), "@code-yeongyu/senpi")
      return dirname(Bun.resolveSync(`${CODEMODE_PACKAGE}/package.json`, senpi))
    } catch {
      throw direct
    }
  }
}

function readInstalledVersion(root: string): string {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }
  return typeof manifest.version === "string" ? manifest.version : "unknown"
}

function pick<T>(module: Record<string, unknown>, name: string, kind: "function" | "object"): T {
  const value = module[name]
  if (typeof value !== kind || value === null)
    throw Error(`${CODEMODE_PACKAGE} export ${name} is missing or not a ${kind}`)
  return value as T
}

/** The peer senpi resolved FROM codemode is the very instance its kernels publish the capability on. */
function resolveCodemodeSenpi(root: string): string {
  return Bun.resolveSync("@code-yeongyu/senpi", join(root, "src"))
}

async function importCodemode(
  root: string,
  importModule: ImportModule,
  version: string,
  senpiEntry: string,
): Promise<CodemodeModules> {
  const url = (path: string) => pathToFileURL(join(root, path)).href
  const [
    evalTool,
    sessionManager,
    proxy,
    handles,
    cells,
    settings,
    detect,
    runtimeFactory,
    runtimeInfo,
    kernels,
    senpi,
  ] = await Promise.all([
    ...Object.values(SOURCES).map((path) => importModule(url(path))),
    importModule(pathToFileURL(senpiEntry).href),
  ])
  const storage = pick<{ getStore?: unknown }>(senpi, "kernelToolsStorage", "object")
  if (typeof storage.getStore !== "function") throw Error("@code-yeongyu/senpi kernelToolsStorage has no getStore")
  const registry = pick<{ list?: unknown }>(kernels ?? {}, "kernelRegistry", "object")
  if (typeof registry.list !== "function") throw Error(`${CODEMODE_PACKAGE} kernelRegistry has no list`)
  return Object.freeze({
    root,
    version,
    createEvalTool: pick<Fn>(evalTool, "createEvalTool", "function"),
    createCodemodeSessionManager: pick<Fn>(sessionManager, "createCodemodeSessionManager", "function"),
    SessionManagerProxy: pick<Ctor>(proxy, "SessionManagerProxy", "function"),
    HandleRegistry: pick<Ctor>(handles, "HandleRegistry", "function"),
    EvalDetachedCellManager: pick<Ctor>(cells, "EvalDetachedCellManager", "function"),
    defaultCodemodeSettings: pick<Record<string, unknown>>(settings, "defaultCodemodeSettings", "object"),
    resolveEnabledLanguages: pick<Fn>(settings, "resolveEnabledLanguages", "function"),
    resolveForegroundWindowSeconds: pick<Fn>(settings, "resolveForegroundWindowSeconds", "function"),
    resolveRunBudgetSeconds: pick<Fn>(settings, "resolveRunBudgetSeconds", "function"),
    resolveHardLimitSeconds: pick<Fn>(settings, "resolveHardLimitSeconds", "function"),
    resolveMaxDetachedCells: pick<Fn>(settings, "resolveMaxDetachedCells", "function"),
    getInterpreterAvailability: pick<Fn>(detect, "getInterpreterAvailability", "function"),
    createInterpreterDetector: pick<Fn>(detect, "createInterpreterDetector", "function"),
    enabledLanguagesFrom: pick<Fn>(runtimeFactory, "enabledLanguagesFrom", "function"),
    jsRuntimeInfo: pick<Fn>(runtimeInfo, "jsRuntimeInfo", "function"),
    runtimesFromAvailability: pick<Fn>(runtimeInfo, "runtimesFromAvailability", "function"),
    kernelToolsStorage: storage as { getStore(): unknown },
    kernelRegistry: registry as { list(): readonly unknown[] },
  })
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function createCodemodeLoader(options: CodemodeLoaderOptions = {}): CodemodeLoader {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CODEMODE_LOAD_TIMEOUT_MS
  const importModule = options.importModule ?? ((url: string) => import(url) as Promise<Record<string, unknown>>)
  let inner: Promise<CodemodeModules> | undefined
  let modules: CodemodeModules | undefined

  // One underlying import per success: a timed-out caller leaves it running, and the next call joins
  // it instead of starting a second module graph.
  function start(): Promise<CodemodeModules> {
    inner ??= (async () => {
      let root: string
      try {
        root = (options.resolveRoot ?? resolveCodemodeRoot)()
      } catch (error) {
        throw new CodemodeUnavailableError(
          `eval is unavailable: ${CODEMODE_PACKAGE} is not installed next to oh-my-openagent (${describe(error)}). Reinstall the plugin so its runtime dependency is present.`,
        )
      }
      const version = (options.readVersion ?? readInstalledVersion)(root)
      if (version !== CODEMODE_VERSION) {
        throw new CodemodeUnavailableError(
          `eval is unavailable: ${CODEMODE_PACKAGE} ${version} is installed, but this plugin supports only ${CODEMODE_VERSION}.`,
        )
      }
      try {
        return await importCodemode(root, importModule, version, (options.resolveSenpi ?? resolveCodemodeSenpi)(root))
      } catch (error) {
        throw new CodemodeUnavailableError(
          `eval is unavailable: loading ${CODEMODE_PACKAGE} failed (${describe(error)}).`,
        )
      }
    })().then(
      (value) => {
        modules = value
        return value
      },
      (error: unknown) => {
        inner = undefined
        throw error
      },
    )
    return inner
  }

  return {
    loaded: () => modules,
    load() {
      if (modules) return Promise.resolve(modules)
      const pending = start()
      return new Promise<CodemodeModules>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new CodemodeUnavailableError(
                `eval is unavailable: ${CODEMODE_PACKAGE} did not finish loading within ${Math.round(timeoutMs / 1000)} s. Try again; the load continues in the background.`,
              ),
            ),
          timeoutMs,
        )
        timer.unref?.()
        pending.then(
          (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          (error: unknown) => {
            clearTimeout(timer)
            reject(error)
          },
        )
      })
    },
  }
}
