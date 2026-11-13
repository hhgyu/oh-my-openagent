import { describe, expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@code-yeongyu/senpi"
import { curatedReadonlyFormatter } from "../../../../utils/src/curated-readonly-presentation"

import {
  createCuratedReadonlyBashTool,
  CuratedReadonlyCommandError,
  executeCuratedReadonlyCommand,
  planCuratedReadonlyCommand,
} from "./curated-readonly-bash"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

async function executeFakeGitHub(endpoint: "bytes" | "error" | "lines" | "small"): Promise<string> {
  const tool = createCuratedReadonlyBashTool("/fixture", async () => {
    if (endpoint === "lines") return Array.from({ length: 2_501 }, (_, index) => `row ${index}`).join("\n")
    if (endpoint === "bytes") return "x".repeat(60_000)
    if (endpoint === "error") {
      throw new CuratedReadonlyCommandError(`Read-only gh request failed: ${"e".repeat(100_000)}`)
    }
    return "line one\nline two"
  })
  const result = await tool.execute("call-1", { program: "gh", args: ["api", endpoint] }, undefined)
  const [part] = result.content
  if (part?.type !== "text") throw new Error("expected a text tool result")
  return part.text
}

describe("createCuratedReadonlyBashTool", () => {
  test("#given output beyond the line limit #when the tool returns #then it keeps the head and reports truncation", async () => {
    const result = await executeFakeGitHub("lines")

    expect(result.startsWith("row 0\nrow 1\n")).toBe(true)
    expect(result).toContain("[truncated:")
    expect(result).not.toContain("row 2500")
    expect(result.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
  })

  test("#given output beyond the byte limit #when the tool returns #then it is bounded and reports truncation", async () => {
    const result = await executeFakeGitHub("bytes")

    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(result.startsWith("x".repeat(1_024))).toBe(true)
    expect(result).toContain("[truncated:")
  })

  test("#given failed output beyond the byte limit #when the tool rejects #then the diagnostic head is retained within budget", async () => {
    let message = ""
    try {
      await executeFakeGitHub("error")
    } catch (error) {
      if (!(error instanceof Error)) throw error
      message = error.message
    }

    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
    expect(message.startsWith(`Read-only gh request failed: ${"e".repeat(1_024)}`)).toBe(true)
    expect(message).toContain("[truncated:")
  })

  test("#given output within both limits #when the tool returns #then it stays byte-identical", async () => {
    expect(await executeFakeGitHub("small")).toBe("line one\nline two")
  })
})

test("explicit real formatter matches default Native success/error bytes and original error causes", async () => {
  for (const text of ["small\nresponse", "x".repeat(60000), "界😀".repeat(16000), Array(2501).fill("row").join("\n")]) {
    const original = new CuratedReadonlyCommandError(text)
    for (const failed of [false, true]) {
      const executor = async () => {
        if (failed) throw original
        return text
      }
      const defaultTool = createCuratedReadonlyBashTool("/fixture", executor)
      const explicitTool = createCuratedReadonlyBashTool("/fixture", executor, curatedReadonlyFormatter)
      const input = { program: "gh" as const, args: ["api", "endpoint"] }
      if (!failed)
        expect(await explicitTool.execute("id", input, undefined)).toEqual(
          await defaultTool.execute("id", input, undefined),
        )
      else {
        let defaultError: unknown, explicitError: unknown
        try {
          await defaultTool.execute("id", input, undefined)
        } catch (error) {
          defaultError = error
        }
        try {
          await explicitTool.execute("id", input, undefined)
        } catch (error) {
          explicitError = error
        }
        expect(defaultError).toBeInstanceOf(CuratedReadonlyCommandError)
        expect(explicitError).toBeInstanceOf(CuratedReadonlyCommandError)
        if (!(defaultError instanceof Error) || !(explicitError instanceof Error)) throw Error("Missing actual errors")
        expect(explicitError.message).toBe(defaultError.message)
        expect(explicitError.cause).toBe(original)
        expect(defaultError.cause).toBe(original)
      }
    }
  }
})

test("both presentation routes preserve arbitrary error and original cancellation signal identity", async () => {
  for (const formatter of [undefined, curatedReadonlyFormatter]) {
    const controller = new AbortController(),
      reason = Error("original cancellation")
    controller.abort(reason)
    let calls = 0
    const tool = createCuratedReadonlyBashTool(
      "/original-cwd",
      async (command, cwd, seconds, signal) => {
        calls++
        expect(command).toEqual({ program: "curl", args: ["--disable", "https://example.com"] })
        expect(cwd).toBe("/original-cwd")
        expect(seconds).toBe(7)
        expect(signal).toBe(controller.signal)
        throw present(signal).reason
      },
      formatter,
    )
    await expect(
      tool.execute("id", { program: "curl", args: ["https://example.com"], timeout_seconds: 7 }, controller.signal),
    ).rejects.toBe(reason)
    expect(calls).toBe(1)
  }
})

test("fresh default warms Native before planning; explicit formatter needs no Native but rejects same unsafe request", () => {
  const source = `
    let attempts=0, planned=0, executed=0;
    Bun.plugin({name:"native-warmup-tripwire",setup(build){build.onLoad({filter:/node_modules[\\\\/](?:\\.bun[\\\\/]@code-yeongyu\\+senpi|@code-yeongyu[\\\\/]senpi)/},()=>{attempts++;throw Error("NATIVE_WARMUP_MARKER")})}});
    const {createCuratedReadonlyBashTool,CuratedReadonlyCommandError}=await import(${JSON.stringify(new URL("./curated-readonly-bash.ts", import.meta.url).href)});
    const {curatedReadonlyFormatter}=await import(${JSON.stringify(new URL("../../../../utils/src/curated-readonly-presentation.ts", import.meta.url).href)});
    const input={program:"gh",get args(){planned++;return ["repo","clone","acme/repo"]}};
    let first,second;
    try{await createCuratedReadonlyBashTool("/fixture",async()=>{executed++;return "bad"}).execute("id",input,undefined)}catch(e){first=e}
    if(!String(first).includes("NATIVE_WARMUP_MARKER")||planned!==0||attempts!==1)throw Error("Default warmup/planning order changed");
    try{await createCuratedReadonlyBashTool("/fixture",async()=>{executed++;return "bad"},curatedReadonlyFormatter).execute("id",input,undefined)}catch(e){second=e}
    if(!(second instanceof CuratedReadonlyCommandError)||planned!==1||attempts!==1||executed!==0)throw Error("Explicit formatter bypassed command policy or loaded Native");
    console.log(JSON.stringify({defaultWarmupBeforePlan:true,explicitNoNative:true,unsafeExecutorCalls:executed}));
  `
  const child = Bun.spawnSync([process.execPath, "--eval", source], {
    env: process.env,
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  })
  if (child.exitCode !== 0) throw Error(child.stderr.toString())
  expect(child.exitCode).toBe(0)
  expect(child.stdout.toString()).toContain('"defaultWarmupBeforePlan":true')
  expect(child.stdout.toString()).toContain('"unsafeExecutorCalls":0')
})

describe("planCuratedReadonlyCommand", () => {
  test("#given read-only curl and GitHub requests #when planned #then direct executables are returned without a shell", () => {
    expect(planCuratedReadonlyCommand({ program: "curl", args: ["--silent", "https://example.com/docs"] })).toEqual({
      program: "curl",
      args: ["--disable", "--silent", "https://example.com/docs"],
    })
    expect(
      planCuratedReadonlyCommand({ program: "gh", args: ["search", "code", "createTaskEngine", "--limit", "5"] }),
    ).toEqual({
      program: "gh",
      args: ["search", "code", "createTaskEngine", "--limit", "5"],
    })
  })

  test("#given mutation-capable flags or commands #when planned #then every request is rejected", () => {
    const requests = [
      { program: "curl", args: ["--request", "POST", "https://example.com"] },
      { program: "curl", args: ["--output", "artifact", "https://example.com"] },
      { program: "curl", args: ["--data", "x=1", "https://example.com"] },
      { program: "gh", args: ["api", "repos/acme/repo", "--method", "DELETE"] },
      { program: "gh", args: ["repo", "clone", "acme/repo"] },
    ] as const

    for (const request of requests) {
      expect(() => planCuratedReadonlyCommand(request)).toThrow("read-only")
    }
  })
})

describe("executeCuratedReadonlyCommand", () => {
  test("#given the factory default executor #then the exported executor is the SAME original function", async () => {
    // given
    const operations = await import("../../tools/task/operations")
    // then
    expect(operations.executeCuratedReadonlyCommand).toBe(executeCuratedReadonlyCommand)
    expect(operations.createCuratedReadonlyBashTool).toBe(createCuratedReadonlyBashTool)
  })

  test("#given an observer #when the executable is missing #then it receives the original handle synchronously and the original error path rejects", async () => {
    // given
    const savedPath = process.env.PATH,
      savedWindowsPath = process.env.Path
    const empty = mkdtempSync(join(tmpdir(), "omo-curated-empty-path-"))
    process.env.PATH = empty
    if (savedWindowsPath !== undefined) process.env.Path = empty
    const observed: ChildProcess[] = []
    try {
      // when
      const pending = executeCuratedReadonlyCommand(
        { program: "gh", args: ["--version"] },
        empty,
        5,
        undefined,
        (child) => {
          observed.push(child)
        },
      )
      // then
      expect(observed).toHaveLength(1)
      expect(typeof present(observed[0]).once).toBe("function")
      await expect(pending).rejects.toBeInstanceOf(CuratedReadonlyCommandError)
      await new Promise<void>((resolve) => {
        const child = present(observed[0])
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) resolve()
        else child.once("close", () => resolve())
      })
    } finally {
      process.env.PATH = savedPath
      if (savedWindowsPath !== undefined) process.env.Path = savedWindowsPath
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test("#given an observer that throws #then the request rejects with that failure", async () => {
    // given
    const failure = Error("observer failed")
    const empty = mkdtempSync(join(tmpdir(), "omo-curated-observer-throw-"))
    let observed: ChildProcess | undefined
    try {
      // when
      const pending = executeCuratedReadonlyCommand(
        { program: "gh", args: ["--version"] },
        empty,
        5,
        undefined,
        (child) => {
          observed = child
          throw failure
        },
      )
      // then
      await expect(pending).rejects.toBe(failure)
    } finally {
      // The original callback still owns the spawned process; join its close before removing its cwd.
      const child = observed
      if (child && child.exitCode === null && child.signalCode === null && child.pid !== undefined)
        await new Promise<void>((resolve) => {
          child.once("close", () => resolve())
        })
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
