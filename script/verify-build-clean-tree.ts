#!/usr/bin/env bun
// Every generated artifact the repository commits (Senpi bundles, Codex hook manifests, native
// generated modules, JSON Schemas, installer entrypoints) is rewritten by `bun run build`. A
// per-file freshness check only covers the files someone remembered to list, so CI runs this
// after the build: any tracked file the build changed, or any untracked file it produced, means a
// committed artifact no longer matches its sources and fails the job.
import { spawnSync } from "node:child_process"

export type BuildDriftEntry = { readonly status: string; readonly path: string }

export function findBuildDrift(cwd: string): BuildDriftEntry[] {
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git status failed in ${cwd}: ${result.stderr.trim()}`)
  const records = result.stdout.split("\0")
  const entries: BuildDriftEntry[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (record === undefined || record.length < 4) continue
    const status = record.slice(0, 2)
    entries.push({ status, path: record.slice(3) })
    // A rename or copy record carries its source path as the next NUL-separated field.
    if (status.includes("R") || status.includes("C")) index++
  }
  return entries
}

if (import.meta.main) {
  const drift = findBuildDrift(process.cwd())
  if (drift.length > 0) {
    console.error("::error::`bun run build` changed committed files; regenerate them and commit the result:")
    for (const entry of drift) console.error(`  ${entry.status} ${entry.path}`)
    spawnSync("git", ["--no-pager", "diff", "--stat"], { stdio: "inherit" })
    process.exit(1)
  }
  console.log("build left every tracked file unchanged and produced no untracked files")
}
