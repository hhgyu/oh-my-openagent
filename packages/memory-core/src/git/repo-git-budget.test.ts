import { afterEach, describe, expect, it } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { removeTree } from "../../../../test-support/remove-tree"
import { installHooks } from "../memfs/hooks"
import { GitMemoryRepo, MemorySecretError, NoEffectiveChangesError, createNodeGitExec, type GitExec } from "./index"

// Every memory write pays one git process per call, which costs tens of ms on an idle host and hundreds on a
// loaded Windows one. These budgets pin the process count of the hot write path (performance contract).

const tempDirs: string[] = []
const author = { agentId: "agent", authorName: "Agent" }

afterEach(async () => {
  for (const dir of tempDirs.splice(0))
    await removeTree(dir, { maxRetries: 20, retryDelay: 250 }).catch(() => undefined)
})

async function tempDir(): Promise<string> {
  const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-git-budget-")))
  tempDirs.push(dir)
  return dir
}

function countingExec(traceFile?: string): { readonly exec: GitExec; readonly runs: string[][] } {
  const base = createNodeGitExec()
  const runs: string[][] = []
  return {
    runs,
    exec: {
      run(argv, options) {
        runs.push([...argv])
        if (traceFile === undefined) return base.run(argv, options)
        return base.run(argv, { ...options, env: { ...(options.env ?? process.env), GIT_TRACE2_EVENT: traceFile } })
      },
    },
  }
}

async function tracedStarts(traceFile: string): Promise<string[][]> {
  const text = await readFile(traceFile, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((line) => line.includes('"event":"start"'))
    .map((line) => (JSON.parse(line) as { argv: string[] }).argv)
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error("expected the operation to reject")
}

describe("GitMemoryRepo git process budget", () => {
  it("#given a fresh directory and edited notes #when init and commitWrite run #then each stays within its git process budget", async () => {
    // given
    const counting = countingExec()
    const repo = new GitMemoryRepo({ dir: await tempDir(), agentId: "agent", exec: counting.exec })

    // when
    await repo.init()
    const initRuns = counting.runs.length
    counting.runs.length = 0
    await writeFile(join(repo.dir, "one.md"), "one\n")
    await repo.commitWrite(["one.md"], "one", author)
    const singleRuns = counting.runs.length
    counting.runs.length = 0
    for (const name of ["a.md", "b.md", "c.md"]) await writeFile(join(repo.dir, name), `${name}\n`)
    await repo.commitWrite(["a.md", "b.md", "c.md"], "three", author)
    const multiRuns = counting.runs.length

    // then
    expect({ initRuns, singleRuns, multiRuns }).toEqual({ initRuns: 9, singleRuns: 4, multiRuns: 4 })
    expect(await repo.lsTree()).toEqual(["a.md", "b.md", "c.md", "one.md"])
    expect(await repo.show("HEAD", "b.md")).toBe("b.md\n")
  })

  it("#given the installed memory hooks #when a note is committed #then pre-commit lists the staged names once", async () => {
    // given
    const dir = await tempDir()
    const traceFile = join(await tempDir(), "trace2.json")
    const counting = countingExec(traceFile)
    const repo = new GitMemoryRepo({
      dir,
      agentId: "agent",
      exec: counting.exec,
      installHooks: (path) => void installHooks(path),
    })
    await repo.init()
    await writeFile(join(dir, "system.md"), "note\n")
    const before = (await tracedStarts(traceFile)).length

    // when
    await repo.commitWrite(["system.md"], "note", author)

    // then
    const listings = (await tracedStarts(traceFile))
      .slice(before)
      .filter((argv) => argv.includes("diff") && argv.includes("--name-only") && argv.includes("--cached"))
    expect(listings).toHaveLength(1)
  })

  it("#given a staged edit whose worktree copy went back to HEAD #when commitWrite runs #then it still reports no effective change", async () => {
    // given
    const dir = await tempDir()
    const repo = new GitMemoryRepo({ dir, agentId: "agent" })
    await repo.init({ seedFiles: [{ relativePath: "note.md", content: "same\n" }] })
    await writeFile(join(dir, "note.md"), "staged\n")
    await createNodeGitExec().run(["add", "note.md"], { cwd: dir, timeoutMs: 30_000 })
    await writeFile(join(dir, "note.md"), "same\n")

    // when
    const error = await rejectedError(repo.commitWrite(["note.md"], "noop", author))

    // then
    expect(error).toBeInstanceOf(NoEffectiveChangesError)
  })

  it("#given several staged notes with a secret in a later one #when commitWrite runs #then that note is refused by content", async () => {
    // given
    const dir = await tempDir()
    const repo = new GitMemoryRepo({ dir, agentId: "agent" })
    await repo.init({ seedFiles: [{ relativePath: "gone.md", content: "gone\n" }] })
    await writeFile(join(dir, "clean.md"), "clean\n")
    await writeFile(join(dir, "leak.md"), `token: ${"ghp_"}${"a".repeat(36)}\n`)
    await removeTree(join(dir, "gone.md"))

    // when
    const error = await rejectedError(repo.commitWrite(["gone.md", "clean.md", "leak.md"], "batch", author))

    // then
    expect(error).toBeInstanceOf(MemorySecretError)
    expect(error.message).toContain("leak.md")
  })
})
