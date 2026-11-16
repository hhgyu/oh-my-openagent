import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { findBuildDrift } from "./verify-build-clean-tree"

function git(args: string[], cwd: string): void {
  execFileSync("git", ["-c", "user.name=omo", "-c", "user.email=omo@example.invalid", ...args], {
    cwd,
    stdio: "ignore",
  })
}

function committedRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "omo-build-clean-tree-"))
  git(["init", "-q"], root)
  git(["config", "core.autocrlf", "false"], root)
  writeFileSync(join(root, ".gitignore"), "dist/\n")
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), content)
  }
  git(["add", "."], root)
  git(["commit", "-q", "-m", "fixture"], root)
  return root
}

describe("findBuildDrift", () => {
  test("#given a build that rewrote only ignored output #when checked #then no drift is reported", () => {
    // given
    const root = committedRepo({ "runtime/sdk.js": "export const v = 1\n" })
    mkdirSync(join(root, "dist"))
    writeFileSync(join(root, "dist", "index.js"), "built\n")
    writeFileSync(join(root, "runtime", "sdk.js"), "export const v = 1\n")

    try {
      // when
      const drift = findBuildDrift(root)

      // then
      expect(drift).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a build that rewrote a committed bundle and emitted a new file #when checked #then both are reported", () => {
    // given
    const root = committedRepo({ "runtime/sdk.js": "export const v = 1\n" })
    writeFileSync(join(root, "runtime", "sdk.js"), "export const v = 2\n")
    writeFileSync(join(root, "runtime", "new-sidecar.js"), "export {}\n")

    try {
      // when
      const drift = findBuildDrift(root)

      // then
      expect(drift).toEqual([
        { status: " M", path: "runtime/sdk.js" },
        { status: "??", path: "runtime/new-sidecar.js" },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("#given a staged rename next to a modified file #when checked #then the rename source is not misread as an entry", () => {
    // given
    const root = committedRepo({ "a.json": "{}\n", "b.json": "[]\n" })
    renameSync(join(root, "a.json"), join(root, "c.json"))
    git(["add", "-A"], root)
    writeFileSync(join(root, "b.json"), "[1]\n")

    try {
      // when
      const drift = findBuildDrift(root)

      // then
      expect(drift).toEqual([
        { status: " M", path: "b.json" },
        { status: "R ", path: "c.json" },
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
