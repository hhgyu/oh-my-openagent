import { afterEach, describe, expect, test } from "bun:test"
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { createFormatterExecutor, FormatterExecutionError } from "./formatter-executor"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omo-format-test-")))
  roots.push(root)
  const file = join(root, "main.go")
  writeFileSync(file, "package main\nfunc main(){println(1)}\n")
  const controller = new AbortController()
  const caller = {
    sessionID: "session",
    agent: "agent",
    messageID: "message",
    id: "call",
    signal: controller.signal,
    progress: async () => {},
  } as unknown as ToolContext
  const grants: unknown[] = []
  const request = {
    filePath: file,
    cwd: root,
    binary: process.execPath,
    timeoutMs: 2000,
    formatter: {
      tool: "gofmt" as const,
      command: "gofmt",
      args: ["-e", "require('fs').appendFileSync(process.argv.at(-1),'// formatted\\n')"],
    },
  }
  return { root, file, caller, controller, grants, request }
}
function fixtureGofmt(root: string): string {
  const bin = join(root, "fixture-bin")
  mkdirSync(bin, { recursive: true })
  const entry = join(bin, "gofmt-fixture.cjs")
  writeFileSync(
    entry,
    "const fs=require('fs');const [flag,file,...rest]=process.argv.slice(2);if(flag!=='-w'||!file||rest.length)process.exit(2);const out='package main\\n\\nfunc main() { println(1) }\\n';if(fs.readFileSync(file,'utf8')!==out)fs.writeFileSync(file,out)\n",
  )
  if (process.platform === "win32") {
    const launcher = join(bin, "gofmt.cmd")
    writeFileSync(launcher, `@"${process.execPath}" "%~dp0gofmt-fixture.cjs" %*\r\n`)
    return launcher
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const launcher = join(bin, "gofmt")
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`)
  chmodSync(launcher, 0o755)
  return launcher
}
function localGit(root: string, script: string) {
  writeFileSync(join(root, "package.json"), "{}")
  const bin = join(root, "node_modules", ".bin")
  mkdirSync(bin, { recursive: true })
  const entry = join(bin, "git-fixture.cjs")
  writeFileSync(entry, script)
  if (process.platform === "win32")
    writeFileSync(join(bin, "git.cmd"), `@"${process.execPath}" "%~dp0git-fixture.cjs" %*\r\n`)
  else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const launcher = join(bin, "git")
    writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} "$@"\n`)
    chmodSync(launcher, 0o755)
  }
}
describe("formatter executor", () => {
  test("real subprocess formats bytes after genuine read/edit/shell grants", async () => {
    const f = fixture()
    const executor = createFormatterExecutor({
      directory: f.root,
      permission: {
        assert: async (request) => {
          f.grants.push(request)
        },
      },
      authorize: () => {},
    })
    try {
      expect(await executor.runCli(f.request, f.caller)).toEqual({ status: "formatted", added: 1, removed: 0 })
      expect(readFileSync(f.file, "utf8")).toContain("// formatted")
      expect((f.grants as { action: string }[]).map((grant) => grant.action)).toEqual(["read", "edit", "shell"])
      for (const grant of f.grants as Record<string, unknown>[]) {
        expect(grant.sessionID).toBe("session")
        expect(grant.source).toEqual({ type: "tool", messageID: "message", id: "call" })
      }
    } finally {
      await executor.dispose()
    }
  })
  test("plain approval rejection retains identity and no process starts", async () => {
    const f = fixture()
    const rejected = { userRejected: true }
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async () => {
          throw rejected
        },
      },
    })
    try {
      await expect(executor.runCli(f.request, f.caller)).rejects.toBe(rejected)
      expect(readFileSync(f.file, "utf8")).not.toContain("formatted")
    } finally {
      await executor.dispose()
    }
  })
  test("outside root and permission-await concurrent change refuse execution", async () => {
    const f = fixture()
    const other = fixture()
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async (request) => {
          if (request.action === "edit") writeFileSync(f.file, "external change")
        },
      },
    })
    try {
      await expect(executor.runCli(other.request, f.caller)).rejects.toThrow("outside")
      await expect(executor.runCli(f.request, f.caller)).rejects.toThrow("changed")
      expect(readFileSync(f.file, "utf8")).toBe("external change")
    } finally {
      await executor.dispose()
    }
  })
  test("failed formatter never overwrites partial or concurrent edits", async () => {
    const f = fixture()
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    try {
      const request = {
        ...f.request,
        formatter: {
          ...f.request.formatter,
          args: ["-e", "require('fs').writeFileSync(process.argv.at(-1),'partial formatter edit');process.exit(7)"],
        },
      }
      try {
        await executor.runCli(request, f.caller)
        throw Error("unexpected")
      } catch (error) {
        expect(error).toBeInstanceOf(FormatterExecutionError)
        expect((error as FormatterExecutionError).mutationCommitted).toBe(true)
        expect((error as FormatterExecutionError).formatterMayHaveModified).toBe(true)
        expect((error as FormatterExecutionError).exitCode).toBe(7)
      }
      expect(readFileSync(f.file, "utf8")).toBe("partial formatter edit")
    } finally {
      await executor.dispose()
    }
  })
  test("timeout kills owned process before its delayed write and disposal closes admission", async () => {
    const f = fixture()
    const marker = join(f.root, "late")
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    const request = {
      ...f.request,
      timeoutMs: 60,
      formatter: {
        ...f.request.formatter,
        args: [
          "-e",
          `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'leaked'),3000);setInterval(()=>{},1000)`,
        ],
      },
    }
    await expect(executor.runCli(request, f.caller)).rejects.toThrow("timed out")
    await executor.dispose()
    await expect(executor.runCli(f.request, f.caller)).rejects.toThrow("disposed")
    await new Promise((resolve) => setTimeout(resolve, 3100))
    expect(existsSync(marker)).toBe(false)
  })
  test("installed gofmt preserves Native argv and reports actual changed/unchanged bytes", async () => {
    // The installed gofmt when the runner has one; otherwise a fixture gofmt that refuses any argv but
    // Native `-w <file>` and writes gofmt's output, so the argv and byte assertions below always run.
    const f = fixture()
    const binary = Bun.which("gofmt") ?? fixtureGofmt(f.root)
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    try {
      const request = {
        ...f.request,
        binary: defined(binary),
        formatter: { tool: "gofmt" as const, command: "gofmt", args: ["-w"] },
      }
      expect((await executor.runCli(request, f.caller)).status).toBe("formatted")
      expect(readFileSync(f.file, "utf8")).toBe("package main\n\nfunc main() { println(1) }\n")
      expect(await executor.runCli(request, f.caller)).toEqual({ status: "unchanged", added: 0, removed: 0 })
    } finally {
      await executor.dispose()
    }
  })
  test("missing binary is distinct from numeric formatter failure", async () => {
    const f = fixture()
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    try {
      expect(await executor.runCli({ ...f.request, binary: join(f.root, "missing-executable") }, f.caller)).toEqual({
        status: "missing",
        added: 0,
        removed: 0,
      })
    } finally {
      await executor.dispose()
    }
  })
  test("caller policy and shell denial prevent any target process", async () => {
    const f = fixture()
    const denied = Error("READ_ONLY")
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {
        throw denied
      },
      permission: {
        assert: async () => {
          throw Error("must not request grant")
        },
      },
    })
    const shell = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async (grant) => {
          if (grant.action === "shell") throw denied
        },
      },
    })
    try {
      await expect(executor.runCli(f.request, f.caller)).rejects.toBe(denied)
      await expect(shell.runCli(f.request, f.caller)).rejects.toBe(denied)
      expect(readFileSync(f.file, "utf8")).not.toContain("formatted")
    } finally {
      await executor.dispose()
      await shell.dispose()
    }
  })
  test("abort while approval is pending preserves reason and late approval cannot start child", async () => {
    const f = fixture()
    let entered!: () => void
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async () => {
          entered()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        },
      },
    })
    const execution = executor.runCli(f.request, f.caller)
    await ready
    const interrupted = { interrupted: true }
    f.controller.abort(interrupted)
    await expect(execution).rejects.toBe(interrupted)
    release()
    await executor.dispose()
    expect(readFileSync(f.file, "utf8")).not.toContain("formatted")
  })
  test("mutable request is captured before approval and cannot swap formatter command", async () => {
    const f = fixture()
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async (grant) => {
          if (grant.action === "edit")
            f.request.formatter.args.splice(0, f.request.formatter.args.length, "-e", "process.exit(9)")
        },
      },
    })
    try {
      expect((await executor.runCli(f.request, f.caller)).status).toBe("formatted")
    } finally {
      await executor.dispose()
    }
  })
  test("same-file callers serialize but independently authorize with their genuine IDs", async () => {
    const f = fixture()
    const order: string[] = []
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: (caller) => {
        order.push(caller.sessionID)
      },
      permission: { assert: async () => {} },
    })
    const request = {
      ...f.request,
      formatter: {
        ...f.request.formatter,
        args: ["-e", "setTimeout(()=>require('fs').appendFileSync(process.argv.at(-1),'// serial\\n'),60)"],
      },
    }
    try {
      const first = executor.runCli(request, f.caller)
      const second = executor.runCli(request, {
        ...f.caller,
        sessionID: "other-session",
        id: "other-call",
      } as ToolContext)
      expect((await Promise.all([first, second])).map((outcome) => outcome.status)).toEqual(["formatted", "formatted"])
      expect(order).toEqual(["session", "other-session"])
      expect(readFileSync(f.file, "utf8").match(/serial/g)).toHaveLength(2)
    } finally {
      await executor.dispose()
    }
  })
  test("Bun feature probing is authorized for every caller without shared permission caching", async () => {
    const f = fixture()
    writeFileSync(join(f.root, "bun.lock"), "")
    const sessions: string[] = []
    const commands: string[] = []
    const executor = createFormatterExecutor({
      directory: f.root,
      resolveBun: () => process.execPath,
      authorize: () => {},
      permission: {
        assert: async (request) => {
          sessions.push(request.sessionID)
          if (request.action === "shell") commands.push(...request.resources)
        },
      },
    })
    try {
      await executor.resolveBunFormat(f.root, f.caller)
      await executor.resolveBunFormat(f.root, { ...f.caller, sessionID: "other-session" } as ToolContext)
      expect(sessions).toContain("session")
      expect(sessions).toContain("other-session")
      expect(commands.filter((command) => command.includes("format --help"))).toHaveLength(2)
      expect(commands.filter((command) => command.includes("format --write"))).toHaveLength(2)
    } finally {
      await executor.dispose()
    }
  })
  test("Bun --help denial propagates unchanged before running the selected binary", async () => {
    const f = fixture()
    writeFileSync(join(f.root, "bun.lock"), "")
    const rejected = { approval: "rejected" }
    const executor = createFormatterExecutor({
      directory: f.root,
      resolveBun: () => process.execPath,
      authorize: () => {},
      permission: {
        assert: async (grant) => {
          if (grant.action === "shell") throw rejected
        },
      },
    })
    try {
      await expect(executor.resolveBunFormat(f.root, f.caller)).rejects.toBe(rejected)
    } finally {
      await executor.dispose()
    }
  })
  test("dispose cancels an actual child and joins it before returning", async () => {
    const f = fixture()
    const started = join(f.root, "started")
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    const request = {
      ...f.request,
      formatter: {
        ...f.request.formatter,
        args: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(started)},String(process.pid));setInterval(()=>{},1000)`,
        ],
      },
    }
    const execution = executor.runCli(request, f.caller)
    // Wait for an observable child side effect, not a guessed process-start delay.
    for (let attempt = 0; attempt < 100 && !existsSync(started); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(existsSync(started)).toBe(true)
    const observed = execution.catch((error) => error)
    await executor.dispose()
    expect(await observed).toBeInstanceOf(FormatterExecutionError)
    const pid = Number(readFileSync(started, "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  })
  test("caller abort closes an actual child tree and preserves the original abort reason", async () => {
    const f = fixture()
    const started = join(f.root, "tree-started")
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    const script = `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});require('fs').writeFileSync(${JSON.stringify(started)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`
    const request = { ...f.request, formatter: { ...f.request.formatter, args: ["-e", script] } }
    const execution = executor.runCli(request, f.caller)
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(started); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(started)).toBe(true)
      const pids = JSON.parse(readFileSync(started, "utf8")) as number[]
      const reason = Error("HOST_INTERRUPTED")
      f.controller.abort(reason)
      await expect(execution).rejects.toBe(reason)
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await executor.dispose()
    }
  })
  test("denied ancestor metadata stops neutral resolver and probe before either can run", async () => {
    const f = fixture()
    writeFileSync(join(f.root, "bun.lock"), "")
    let resolutions = 0
    let shellGrants = 0
    const denied = { ancestorRead: "denied" }
    const ancestorManifest = join(dirname(f.root), "package.json")
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      resolveBun: () => {
        resolutions++
        return process.execPath
      },
      permission: {
        assert: async (request) => {
          if (request.action === "shell") shellGrants++
          if (request.action === "read" && request.resources.includes(ancestorManifest)) throw denied
        },
      },
    })
    try {
      await expect(executor.resolveBunFormat(f.root, f.caller)).rejects.toBe(denied)
      expect(resolutions).toBe(0)
      expect(shellGrants).toBe(0)
    } finally {
      await executor.dispose()
    }
  })
  test("ancestor metadata grants use precise paths and the same genuine source identity", async () => {
    const f = fixture()
    writeFileSync(join(f.root, "bun.lock"), "")
    writeFileSync(join(f.root, "package.json"), "{}")
    const grants: {
      action: string
      resources: readonly string[]
      sessionID: unknown
      agent: unknown
      source?: unknown
    }[] = []
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      resolveBun: () => null,
      permission: {
        assert: async (request) => {
          grants.push(request)
        },
      },
    })
    try {
      await executor.resolveBunFormat(f.root, f.caller)
      const ancestor = defined(grants.find((grant) => grant.resources.includes(join(dirname(f.root), "package.json"))))
      expect(ancestor).toBeDefined()
      expect(ancestor.action).toBe("read")
      let current = f.root
      for (;;) {
        expect(ancestor.resources).toContain(join(current, "package.json"))
        expect(ancestor.resources).toContain(join(current, "node_modules", ".bin"))
        expect(ancestor.resources).not.toContain(current)
        const parent = dirname(current)
        if (parent === current) break
        current = parent
      }
      expect(ancestor.sessionID).toBe(f.caller.sessionID)
      expect(ancestor.agent).toBe(f.caller.agent)
      expect(ancestor.source).toEqual({ type: "tool", messageID: f.caller.messageID, id: f.caller.id })
    } finally {
      await executor.dispose()
    }
  })
  test("git ignore inspection uses actual repo rules and exact caller permission source", async () => {
    const f = fixture()
    const git = defined(Bun.which("git"))
    expect(git).toBeTruthy()
    const init = spawnSync(git, ["init", "--quiet", f.root], { windowsHide: true, stdio: "ignore" })
    expect(init.status).toBe(0)
    writeFileSync(join(f.root, ".gitignore"), "ignored.go\n")
    const ignored = join(f.root, "ignored.go")
    writeFileSync(ignored, "package main\n")
    const operations: { kind: string; mutates: boolean }[] = []
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: (_caller, operation) => {
        operations.push(operation)
      },
      permission: {
        assert: async (request) => {
          f.grants.push(request)
        },
      },
    })
    try {
      expect(await executor.isIgnored(ignored, f.caller)).toBe(true)
      expect(await executor.isIgnored(f.file, f.caller)).toBe(false)
      expect(operations).toHaveLength(2)
      expect(operations.every((operation) => operation.kind === "inspect" && !operation.mutates)).toBe(true)
      for (const grant of f.grants as { sessionID: unknown; agent: unknown; source: unknown }[]) {
        expect(grant.sessionID).toBe(f.caller.sessionID)
        expect(grant.agent).toBe(f.caller.agent)
        expect(grant.source).toEqual({ type: "tool", messageID: f.caller.messageID, id: f.caller.id })
      }
    } finally {
      await executor.dispose()
    }
  })
  test("inspection shell rejection propagates without executing git", async () => {
    const f = fixture()
    const rejection = { shell: "rejected" }
    let shells = 0
    const marker = join(f.root, "git-executed")
    localGit(f.root, `require('fs').writeFileSync(${JSON.stringify(marker)},'executed');process.exit(0)`)
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async (request) => {
          if (request.action === "shell") {
            shells++
            throw rejection
          }
        },
      },
    })
    try {
      await expect(executor.isIgnored(f.file, f.caller)).rejects.toBe(rejection)
      expect(shells).toBe(1)
      expect(existsSync(marker)).toBe(false)
    } finally {
      await executor.dispose()
    }
  })
  test("ordinary non-repository git exit128 is explicit false, not a command failure", async () => {
    const f = fixture()
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    try {
      expect(await executor.isIgnored(f.file, f.caller)).toBe(false)
    } finally {
      await executor.dispose()
    }
  })
  test("inspection cancellation joins an actual command and preserves caller abort identity", async () => {
    const f = fixture()
    const marker = join(f.root, "inspection-pid")
    localGit(
      f.root,
      `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
    )
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: { assert: async () => {} },
    })
    const execution = executor.isIgnored(f.file, f.caller)
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 10))
      expect(existsSync(marker)).toBe(true)
      const pid = Number(readFileSync(marker, "utf8"))
      const reason = { stoppedInspection: true }
      f.controller.abort(reason)
      await expect(execution).rejects.toBe(reason)
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await executor.dispose()
    }
  })
  test("inspection refuses changed resources and reports nonstandard git failure truthfully", async () => {
    const f = fixture()
    localGit(f.root, "process.exit(9)")
    let change = true
    const executor = createFormatterExecutor({
      directory: f.root,
      authorize: () => {},
      permission: {
        assert: async (request) => {
          if (change && request.action === "shell") writeFileSync(f.file, "concurrent mutation")
        },
      },
    })
    try {
      await expect(executor.isIgnored(f.file, f.caller)).rejects.toThrow("changed")
      change = false
      try {
        await executor.isIgnored(f.file, f.caller)
        throw Error("unexpected")
      } catch (error) {
        expect(error).toBeInstanceOf(FormatterExecutionError)
        expect((error as FormatterExecutionError).code).toBe("inspect")
        expect((error as FormatterExecutionError).exitCode).toBe(9)
        expect((error as FormatterExecutionError).formatterMayHaveModified).toBe(false)
      }
    } finally {
      await executor.dispose()
    }
  })
})
