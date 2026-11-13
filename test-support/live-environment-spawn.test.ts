import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { liveEnvironmentSpawnArguments } from "./live-environment-spawn"
import { isInside } from "./real-agent-dir-guard"

const PROBE =
  "console.log(JSON.stringify({agentDir: process.env.PI_CODING_AGENT_DIR ?? null, home: process.env.HOME ?? null, userProfile: process.env.USERPROFILE ?? null}))"

type ChildView = { agentDir: string | null; home: string | null; userProfile: string | null }

function hermeticView(): ChildView {
  return {
    agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    home: process.env.HOME ?? null,
    userProfile: process.env.USERPROFILE ?? null,
  }
}

function parse(stdout: Uint8Array | ArrayBuffer | string): ChildView {
  const text = typeof stdout === "string" ? stdout : new TextDecoder().decode(stdout)
  return JSON.parse(text.trim()) as ChildView
}

describe("live-environment spawn under the hermetic preload", () => {
  test("#given the hermetic home #when Bun.spawnSync starts a child without env #then the child sees the hermetic home and agent dir", () => {
    // when
    const child = Bun.spawnSync([process.execPath, "--eval", PROBE], { stdout: "pipe", stderr: "pipe" })

    // then
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0)
    expect(parse(child.stdout)).toEqual(hermeticView())
  })

  test("#given the hermetic home #when Bun.spawnSync takes a single options object without env #then the child sees the hermetic home", () => {
    // when
    const child = Bun.spawnSync({ cmd: [process.execPath, "--eval", PROBE], stdout: "pipe", stderr: "pipe" })

    // then
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0)
    expect(parse(child.stdout)).toEqual(hermeticView())
  })

  test("#given the hermetic home #when Bun.spawn starts a child without options #then the child sees the hermetic home", async () => {
    // when
    const child = Bun.spawn([process.execPath, "--eval", PROBE], { stdout: "pipe" })
    const stdout = await new Response(child.stdout).text()

    // then
    expect(await child.exited).toBe(0)
    expect(parse(stdout)).toEqual(hermeticView())
  })

  test("#given a call that names its own env #when Bun.spawnSync starts the child #then that env is kept unchanged", () => {
    // given
    const env = { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "" }

    // when
    const child = Bun.spawnSync([process.execPath, "--eval", PROBE], { stdout: "pipe", stderr: "pipe", env })

    // then
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0)
    expect(parse(child.stdout).agentDir).toBeNull()
  })
})

describe("liveEnvironmentSpawnArguments", () => {
  test("#given a command array and no options #when the arguments are filled #then the env is a copy of process.env", () => {
    // when
    const [command, options] = liveEnvironmentSpawnArguments([["bun"]])

    // then
    expect(command).toEqual(["bun"])
    expect(options).toEqual({ env: { ...process.env } })
  })

  test("#given options with an explicit env #when the arguments are filled #then the options object is passed through", () => {
    // given
    const options = { env: { ONLY: "1" }, stdout: "pipe" }

    // when
    const [, filled] = liveEnvironmentSpawnArguments([["bun"], options])

    // then
    expect(filled).toBe(options)
  })

  test("#given options whose env is undefined #when the arguments are filled #then the live env is filled in and other options kept", () => {
    // when
    const [filled] = liveEnvironmentSpawnArguments([{ cmd: ["bun"], env: undefined, cwd: "x" }])

    // then
    expect(filled).toEqual({ cmd: ["bun"], cwd: "x", env: { ...process.env } })
  })
})

describe("task records written by a test child (agent-home isolation)", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test("#given a child spawned without env #when it resolves a temp project's task store #then the store is inside the hermetic home", () => {
    // given
    const project = mkdtempSync(join(tmpdir(), "omo-agent-home-probe-"))
    dirs.push(project)
    const resolver = pathToFileURL(
      join(import.meta.dir, "..", "packages", "senpi-task", "src", "store", "project-state-directory.ts"),
    ).href
    const script = `const { resolveProjectStateDirectory } = await import(${JSON.stringify(resolver)}); console.log(resolveProjectStateDirectory(${JSON.stringify(project)}, "senpi-task"))`

    // when
    const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" })

    // then
    expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0)
    const home = process.env.HOME
    if (!home) throw new Error("the hermetic preload did not set HOME")
    expect(isInside(home, new TextDecoder().decode(child.stdout).trim())).toBe(true)
  })
})
