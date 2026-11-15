import { join } from "node:path"

// Bun keeps transpiled modules in a runtime transpiler cache it locates from the environment: an explicit
// BUN_RUNTIME_TRANSPILER_CACHE_PATH, else a directory under $XDG_CACHE_HOME or the home directory. The test
// preloads move XDG_CACHE_HOME and HOME into a fresh per-process temp tree, and every child a test starts
// inherits that, so each child bun found an empty cache and transpiled its whole import graph again: 2.3 to
// 4.4 s for the senpi-task operations graph on a Windows dev machine against 0.3 s warm, past the 5 s budget
// of the fresh-process tests on a loaded Windows runner. The cache holds content-addressed compiler output,
// not user state, so every test process and child shares one directory that outlives the run. A run that
// sets the variable before bun starts (CI does) also lets the test process itself fill that directory.
export const TEST_TRANSPILER_CACHE_DIRNAME = "omo-test-bun-transpiler-cache"

/** Pins the transpiler cache under `osTempDir` unless the environment already names one (including the disabling "0"). */
export function pinBunRuntimeTranspilerCache(env: Record<string, string | undefined>, osTempDir: string): void {
  if (env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== undefined) return
  env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = join(osTempDir, TEST_TRANSPILER_CACHE_DIRNAME)
}
