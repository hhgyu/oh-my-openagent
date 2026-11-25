import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const HOOKS_DIR = join(REPO_ROOT, ".githooks")
const INSTALLER = join(REPO_ROOT, "script", "agent", "install-git-hooks.sh")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function gitEnv(root: string, path = process.env.PATH ?? ""): Record<string, string> {
  const globalConfig = join(root, "global.gitconfig")
  if (!existsSync(globalConfig)) writeFileSync(globalConfig, "")
  // Windows exposes the variable as `Path`; keeping it next to `PATH` leaves the child an unfiltered copy.
  const inherited = Object.fromEntries(
    Object.entries(process.env as Record<string, string>).filter(([key]) => key.toUpperCase() !== "PATH"),
  )
  return {
    ...inherited,
    PATH: path,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Hook test",
    GIT_AUTHOR_EMAIL: "hook@example.invalid",
    GIT_COMMITTER_NAME: "Hook test",
    GIT_COMMITTER_EMAIL: "hook@example.invalid",
  }
}

function tempRepo(): { readonly repo: string; readonly root: string; readonly git: (...args: string[]) => string } {
  const root = mkdtempSync(join(tmpdir(), "omo-git-hooks-"))
  roots.push(root)
  const repo = join(root, "repo")
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: repo,
      env: gitEnv(root),
      stdout: "pipe",
      stderr: "pipe",
    })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }
  git("init", "-q")
  writeFileSync(join(repo, "bunfig.toml"), "[fmt]\nprintWidth = 120\nsemi = false\n")
  return { repo, root, git }
}

function commit(repo: string, root: string, path?: string): { readonly exitCode: number; readonly stderr: string } {
  const result = Bun.spawnSync({
    cmd: ["git", "commit", "-q", "-m", "change"],
    cwd: repo,
    env: gitEnv(root, path),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: result.exitCode, stderr: result.stderr.toString() }
}

function runInstaller(repo: string, root: string): { readonly exitCode: number; readonly stdout: string } {
  const bash = Bun.which("bash")
  if (bash === null) throw new Error("bash not found")
  mkdirSync(join(repo, "script", "agent"), { recursive: true })
  copyFileSync(INSTALLER, join(repo, "script", "agent", "install-git-hooks.sh"))
  const result = Bun.spawnSync({
    cmd: [bash, "script/agent/install-git-hooks.sh"],
    cwd: repo,
    env: gitEnv(root),
    stdout: "pipe",
    stderr: "pipe",
  })
  return { exitCode: result.exitCode, stdout: result.stdout.toString() + result.stderr.toString() }
}

const pathWithoutBun = (): string =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && !["bun", "bun.exe"].some((name) => existsSync(join(entry, name))))
    .join(delimiter)

describe("pre-commit format hook", () => {
  test("#given an unformatted staged file #when committing #then the commit is refused and names the file", () => {
    // given
    const { repo, root, git } = tempRepo()
    git("config", "core.hooksPath", HOOKS_DIR.replaceAll("\\", "/"))
    writeFileSync(join(repo, "a.ts"), "export const a = {b:1,   c:2}\n")
    git("add", "a.ts")

    // when
    const result = commit(repo, root)

    // then
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("a.ts")
    expect(result.stderr).toContain("bun run fmt")
    expect(git("rev-list", "--all", "--count")).toBe("0")
  })

  test("#given the staged blob is formatted but the working file is not #when committing #then the commit succeeds", () => {
    // given
    const { repo, root, git } = tempRepo()
    git("config", "core.hooksPath", HOOKS_DIR.replaceAll("\\", "/"))
    writeFileSync(join(repo, "a.ts"), "export const a = { b: 1, c: 2 }\n")
    git("add", "a.ts")
    writeFileSync(join(repo, "a.ts"), "export const a = {b:1,   c:2}\n")

    // when
    const result = commit(repo, root)

    // then
    expect(result.exitCode, result.stderr).toBe(0)
    expect(git("rev-list", "--all", "--count")).toBe("1")
  })

  test("#given bun is not on PATH #when committing an unformatted file #then the hook warns and lets it through", () => {
    // given
    const { repo, root, git } = tempRepo()
    git("config", "core.hooksPath", HOOKS_DIR.replaceAll("\\", "/"))
    writeFileSync(join(repo, "a.ts"), "export const a = {b:1,   c:2}\n")
    git("add", "a.ts")

    // when
    const result = commit(repo, root, pathWithoutBun())

    // then
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stderr).toContain("bun not found")
  })
})

describe("install-git-hooks.sh", () => {
  test("#given no hooks path and no own hooks #when installing #then core.hooksPath becomes .githooks", () => {
    // given
    const { repo, root, git } = tempRepo()

    // when
    const result = runInstaller(repo, root)

    // then
    expect(result.exitCode, result.stdout).toBe(0)
    expect(git("config", "--get", "core.hooksPath")).toBe(".githooks")
  })

  test("#given a different hooks path #when installing #then it is kept and a warning is printed", () => {
    // given
    const { repo, root, git } = tempRepo()
    git("config", "core.hooksPath", "my-hooks")

    // when
    const result = runInstaller(repo, root)

    // then
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("WARN")
    expect(git("config", "--get", "core.hooksPath")).toBe("my-hooks")
  })

  test("#given an own hook in .git/hooks #when installing #then core.hooksPath stays unset", () => {
    // given
    const { repo, root, git } = tempRepo()
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 0\n")

    // when
    const result = runInstaller(repo, root)

    // then
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("pre-push")
    const unset = Bun.spawnSync({ cmd: ["git", "config", "--get", "core.hooksPath"], cwd: repo, env: gitEnv(root) })
    expect(unset.exitCode).toBe(1)
  })
})
