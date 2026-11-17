import { readdirSync } from "node:fs"
import { join } from "node:path"

// memory-core is one serial Bun process of ~2550 s on windows-latest (run 44030668132, job
// 133861781753), while omo-opencode finishes in ~650 s. Splitting memory-core into balanced
// file sets puts its serial time on the runner's idle cores; each set is still one sequential
// Bun process with the root bunfig/preloads.
export const MEMORY_CORE_PARTITIONS = 3

// Windows seconds per file from that run for every file of 20 s or more. Any other file
// weighs the mean of the rest of the package (2.8 s), so new files need no entry here.
export const MEMORY_CORE_HEAVY_TEST_SECONDS: Readonly<Record<string, number>> = {
  "src/sync/engine/engine-fuzz.test.ts": 232,
  "src/sync/item/idempotence.r3.test.ts": 164,
  "src/memfs/hooks-provenance.test.ts": 155,
  "src/maintenance/memory-maintenance.test.ts": 87,
  "src/sync/engine/engine-review.test.ts": 81,
  "src/sync/engine/engine-oversized-peer.test.ts": 65,
  "src/sync/engine/engine-crash.test.ts": 64,
  "src/memfs/hooks.test.ts": 60,
  "src/sync/engine/engine-legacy-journal.test.ts": 50,
  "src/facts/queue-parked.test.ts": 49,
  "src/reflection/description-preflight.test.ts": 41,
  "src/reflection/completion-validation-secret.test.ts": 40,
  "src/reflection/completion-validation-partial.test.ts": 35,
  "src/git/repo-commit-times.test.ts": 30,
  "src/reflection/completion-validation-links.test.ts": 30,
  "src/soul/watermark.test.ts": 29,
  "src/memfs/hooks-secret-reference-values.test.ts": 29,
  "src/sync/space/adopt-preservation.test.ts": 29,
  "src/reflection/worktree.test.ts": 27,
  "src/facts/recovery.test.ts": 27,
  "src/recall/bm25-persist.test.ts": 27,
  "src/reflection/worktree-integration.test.ts": 26,
  "src/compile/cache-persist.test.ts": 24,
  "src/sync/space/adopt-deletion-gate.test.ts": 23,
  "src/facts/agreement-recovery.test.ts": 23,
  "src/sync/engine/engine-journaled-recovery.test.ts": 23,
  "src/sync/engine/engine-oversized-legacy.test.ts": 21,
  "src/sync/account/revoke-rotation.test.ts": 21,
  "src/agreements/notice-watermark.test.ts": 21,
  "src/tools/memory-legacy-header.test.ts": 20,
  "src/memfs/hooks-secret.test.ts": 20,
}
const DEFAULT_TEST_SECONDS = 2.8

// Bun's default test file names: <stem>.test|_test|.spec|_spec plus a JS/TS extension.
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist"])

export function discoverTestFiles(directory: string): string[] {
  const found: string[] = []
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name) && !entry.name.startsWith(".")) walk(path)
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        found.push(path)
      }
    }
  }
  walk("")
  return found.sort()
}

// Longest-processing-time split; deterministic, never yields an empty set.
export function partitionByWeight(
  files: readonly string[],
  weight: (file: string) => number,
  count: number,
): string[][] {
  const sets = Array.from({ length: count }, () => ({ total: 0, files: [] as string[] }))
  const heaviestFirst = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
  for (const file of heaviestFirst) {
    let lightest = sets[0]
    for (const set of sets) if (set.total < lightest.total) lightest = set
    lightest.total += weight(file)
    lightest.files.push(file)
  }
  return sets.filter((set) => set.files.length > 0).map((set) => set.files.sort())
}

export function memoryCoreWeight(file: string): number {
  return MEMORY_CORE_HEAVY_TEST_SECONDS[file] ?? DEFAULT_TEST_SECONDS
}
