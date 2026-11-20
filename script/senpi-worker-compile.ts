import { existsSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, sep, join } from "node:path"

const SENPI_COMPILE_ENTRIES = [
  // Older pinned engines do not have a shared-session worker.
  {
    define: "SENPI_RPC_SESSION_WORKER_ENTRY",
    path: "node_modules/@code-yeongyu/senpi/dist/modes/rpc/session-worker.js",
  },
  // The kill guard's judge, imported by URL from codemode kernels (senpi#5358); absent before 2026.11.2-3.
  { define: "SENPI_KILL_GUARD_ENTRY", path: "node_modules/@code-yeongyu/senpi/dist/core/kill-guard/index.js" },
] as const

/**
 * `--bytecode` stores the precompiled bytecode of the bundled graph, so a launch skips parsing it (#13440): a boot
 * took 880 ms p50 on Linux x64 and 214 ms on darwin-arm64 before, 202 ms and 33 ms after. Depth 1 compiles only the
 * outermost function level ahead of time; it keeps nearly all of the gain at about half the size of full depth, which
 * cannot fit the budget because the senpi worker entries in the same compile get bytecode too. ESM output is required:
 * the entry awaits at the top level.
 */
export const BYTECODE_COMPILE_ARGS = ["--bytecode", "--format=esm", "--bytecode-depth=1"] as const

/** Bun entry names are relative to --root, not to the relocated executable's cwd. */
export function senpiWorkerCompileArgs(repoRoot: string): string[] {
  const entries = SENPI_COMPILE_ENTRIES.flatMap(({ define, path }) => {
    const candidate = join(repoRoot, path)
    return existsSync(candidate) ? [{ define, entry: realpathSync(candidate) }] : []
  })
  if (entries.length === 0) return []
  let root = realpathSync(repoRoot)
  // Bun embeds the physical entry name, including .bun store paths. Linked
  // development engines outside the repo need a root containing every entry.
  const escapesRoot = (): boolean => entries.some(({ entry }) => relative(root, entry).startsWith(`..${sep}`))
  while (escapesRoot()) root = dirname(root)
  const args = [`--root=${root}`]
  for (const { define, entry } of entries) {
    const name = relative(root, entry)
    if (isAbsolute(name)) throw new Error("The wrapper and engine entries must share a filesystem root")
    args.push(`--define=${define}=${JSON.stringify(`./${name.split(sep).join("/")}`)}`)
  }
  return [...args, ...entries.map(({ entry }) => entry)]
}
