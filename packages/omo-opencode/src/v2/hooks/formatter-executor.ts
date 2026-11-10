import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { FormatterCliRequest, FormatterOutcome } from "@oh-my-opencode/lsp-core/mutation/formatter"
import { createSpawnCommand, killProcessTree } from "@oh-my-opencode/lsp-core/lsp/process"
import { resolveBunProjectCommand } from "@oh-my-opencode/lsp-core/lsp/bun-project-checks"
import { resolveServerBinary } from "@oh-my-opencode/lsp-core/lsp/server-installation"
import type { PermissionPort } from "../host/permission-adapters"

export interface FormatterOperation {
  readonly kind: "format" | "probe" | "inspect"
  readonly path: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly mutates: boolean
}
export interface FormatterExecutorOptions {
  readonly directory: string
  readonly permission: PermissionPort
  readonly authorize: (caller: ToolContext, operation: FormatterOperation) => void | Promise<void>
  /** Trusted dependency seam; the returned executable still requires caller shell approval. */
  readonly resolveBun?: (cwd: string) => string | null
}
export class FormatterExecutionError extends Error {
  override readonly name = "FormatterExecutionError"
  readonly mutationCommitted = true
  constructor(readonly code: "invalid_path" | "changed" | "spawn" | "exit" | "inspect" | "missing_dependency" | "timeout" | "disposed", message: string,
    readonly formatterMayHaveModified = false, readonly exitCode?: number | null) { super(message) }
}

function wait<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    work.then(value => { signal.removeEventListener("abort", abort); resolvePromise(value) }, error => { signal.removeEventListener("abort", abort); reject(error) })
    if (signal.aborted) abort()
  })
}
function identity(file: string): string {
  const value = statSync(file)
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
}
/** A stopped POSIX child runs detached as its own process group leader. Its `close` only proves the
 * leader exited, so wait (bounded) until no group member remains before reporting the stop. */
async function processGroupExit(pid: number | undefined): Promise<void> {
  if (process.platform === "win32" || pid === undefined) return
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(-pid, 0) } catch { return }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
}
function nodeIdentity(file: string): string { const value = statSync(file); return `${value.dev}:${value.ino}` }
function executableIdentity(file: string): string | undefined { try { return identity(file) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error } }
/** Neutral Bun discovery reads nearest package metadata and probes ancestor bin/marker
 * paths. Enumerate lexically: no existence/read probe is allowed before these grants. */
function bunDiscoveryResources(cwd: string): readonly string[] {
  const metadata = ["package.json", "bun.lock", "bun.lockb", "bunfig.toml", ".git", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
    "pyproject.toml", "ty.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile", "pyrightconfig.json", "ruff.toml", ".ruff.toml",
    "Gemfile", "Gemfile.lock", "go.mod", "go.sum", "go.work", "node_modules/.bin", ".venv/bin", ".venv/Scripts", "venv/bin", "venv/Scripts", ".env/bin", ".env/Scripts", "vendor/bundle/bin", "bin"]
  const resources = new Set<string>()
  let directory = cwd
  for (;;) {
    for (const name of metadata) resources.add(join(directory, name))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const extensions = [".tsx", ".ts", ".jsx", ".cts", ".cjs", ".js", ".mjs", ".mts"]
  resources.add(join(cwd, "format"))
  resources.add(join(cwd, "format", "package.json"))
  for (const extension of extensions) {
    resources.add(join(cwd, `format${extension}`))
    resources.add(join(cwd, "format", `index${extension}`))
  }
  return [...resources]
}
function inside(root: string, target: string) {
  const rel = relative(root, target)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
}

export function createFormatterExecutor(options: FormatterExecutorOptions) {
  if (!isAbsolute(options.directory)) throw new FormatterExecutionError("invalid_path", "Formatter directory must be absolute")
  const root = realpathSync(options.directory)
  const rootIdentity = nodeIdentity(root)
  const lifetime = new AbortController()
  const queues = new Map<string, Promise<unknown>>()
  const active = new Set<Promise<unknown>>()
  let closed = false
  let disposal: Promise<void> | undefined
  function check(signal: AbortSignal) {
    signal.throwIfAborted()
    if (closed) throw new FormatterExecutionError("disposed", "Formatter executor disposed")
    if (realpathSync(options.directory) !== root || nodeIdentity(root) !== rootIdentity) throw new FormatterExecutionError("changed", "Formatter owner directory changed")
  }
  function scope(value: string, cwd = root): string {
    const result = realpathSync(resolve(cwd, value))
    if (!inside(root, result)) throw new FormatterExecutionError("invalid_path", "Formatter path outside owning directory")
    return result
  }
  function capture(caller: ToolContext) {
    if (closed) throw new FormatterExecutionError("disposed", "Formatter executor disposed")
    const signal = AbortSignal.any([caller.signal, lifetime.signal])
    const context: ToolContext = Object.freeze({ ...caller, signal })
    check(signal)
    return context
  }
  function own<T>(work: () => Promise<T>): Promise<T> {
    const operation = Promise.resolve().then(work)
    active.add(operation)
    void operation.then(() => active.delete(operation), () => active.delete(operation))
    return operation
  }
  async function grant(caller: ToolContext, action: string, resources: readonly string[]) {
    check(caller.signal)
    await wait(options.permission.assert({ sessionID: caller.sessionID, agent: caller.agent, action, resources: [...resources],
      source: { type: "tool", messageID: caller.messageID, id: caller.id } }), caller.signal)
    check(caller.signal)
  }
  async function authorize(caller: ToolContext, operation: FormatterOperation) {
    check(caller.signal)
    await wait(Promise.resolve(options.authorize(caller, Object.freeze(operation))), caller.signal)
    check(caller.signal)
  }
  async function child(command: readonly string[], cwd: string, timeoutMs: number, caller: ToolContext, mode: "format" | "inspect" = "format"): Promise<number | "missing"> {
    check(caller.signal)
    const prepared = createSpawnCommand([...command])
    return new Promise((resolvePromise, reject) => {
      let processHandle: ReturnType<typeof spawn>
      try { processHandle = spawn(prepared.command, prepared.args, { cwd, shell: prepared.shell, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") resolvePromise("missing"); else reject(mode === "inspect" ? error : new FormatterExecutionError("spawn", "Formatter could not start; original mutation remains committed")); return }
      let stopped: unknown
      let failed: unknown
      let timer: ReturnType<typeof setTimeout> | undefined
      const stop = (reason: unknown) => { if (stopped !== undefined) return; stopped = reason; killProcessTree(processHandle, "SIGKILL") }
      const abort = () => stop(caller.signal.reason)
      const cleanup = () => { if (timer) clearTimeout(timer); caller.signal.removeEventListener("abort", abort) }
      processHandle.once("error", error => { failed = error })
      processHandle.once("close", code => {
        cleanup()
        if (stopped !== undefined) { const reason = stopped; void processGroupExit(processHandle.pid).then(() => reject(reason)) }
        else if (failed) { if ((failed as NodeJS.ErrnoException).code === "ENOENT") resolvePromise("missing"); else reject(mode === "inspect" ? failed : new FormatterExecutionError("spawn", "Formatter could not start; original mutation remains committed")) }
        else resolvePromise(code ?? 1)
      })
      caller.signal.addEventListener("abort", abort, { once: true })
      timer = setTimeout(() => stop(new FormatterExecutionError("timeout", mode === "inspect" ? "Git ignore inspection timed out; original mutation remains committed" : "Formatter timed out; original mutation is committed and formatter may have partially edited the file", mode !== "inspect")), timeoutMs)
      if (caller.signal.aborted) abort()
    })
  }
  function runCli(request: FormatterCliRequest, genuineCaller: ToolContext): Promise<FormatterOutcome> {
    return own(async () => {
      const caller = capture(genuineCaller)
      // Capture all mutable input before an approval await; callers cannot swap the command later.
      const cwd = scope(request.cwd)
      const file = scope(request.filePath, cwd)
      if (!statSync(file).isFile() || !isAbsolute(request.binary) || !Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) throw new FormatterExecutionError("invalid_path", "Invalid formatter file, binary or timeout")
      const binary = request.binary
      const command = Object.freeze([binary, ...request.formatter.args, file])
      const timeoutMs = request.timeoutMs
      const pending = queues.get(file) ?? Promise.resolve()
      const work = (async () => {
        await wait(pending.catch(() => {}), caller.signal)
        check(caller.signal)
        const originalIdentity = identity(file)
        const directoryIdentity = nodeIdentity(cwd)
        const binaryIdentity = executableIdentity(binary)
        const unchanged = (before?: Buffer) => {
          check(caller.signal)
          if (scope(file) !== file || nodeIdentity(cwd) !== directoryIdentity || identity(file) !== originalIdentity ||
            executableIdentity(binary) !== binaryIdentity || (before && !readFileSync(file).equals(before))) {
            throw new FormatterExecutionError("changed", "Formatter input or executable changed during authorization")
          }
        }
        await authorize(caller, { kind: "format", path: file, cwd, command, mutates: true })
        unchanged()
        await grant(caller, "read", [file])
        unchanged()
        const before = readFileSync(file)
        await grant(caller, "edit", [file]); unchanged(before)
        await grant(caller, "shell", [command.join(" ")]); unchanged(before)
        const exit = await child(command, cwd, timeoutMs, caller)
        check(caller.signal)
        if (exit === "missing") return { status: "missing", added: 0, removed: 0 } as const
        if (exit !== 0) throw new FormatterExecutionError("exit", "Formatter failed; original mutation is committed and formatter may have partially edited the file", true, exit)
        // Never roll back: external edits during formatter execution must not be overwritten.
        let after: Buffer
        try {
          if (scope(file) !== file) throw new Error("changed resource")
          after = readFileSync(file)
        } catch { throw new FormatterExecutionError("changed", "Formatted resource changed or became unreadable; original mutation remains committed and formatter may have partially edited it", true) }
        if (after.equals(before)) return { status: "unchanged", added: 0, removed: 0 } as const
        const lines = after.toString("utf8").split("\n").length - before.toString("utf8").split("\n").length
        return { status: "formatted", added: Math.max(0, lines), removed: Math.max(0, -lines) } as const
      })()
      queues.set(file, work)
      try { return await work } finally { if (queues.get(file) === work) queues.delete(file) }
    })
  }
  function resolveBunFormat(cwdInput: string, genuineCaller: ToolContext): Promise<string | undefined> {
    return own(async () => {
      const caller = capture(genuineCaller)
      const cwd = scope(cwdInput)
      const cwdIdentity = nodeIdentity(cwd)
      await authorize(caller, { kind: "probe", path: cwd, cwd, command: Object.freeze(["bun", "format", "--help"]), mutates: true })
      await grant(caller, "read", [cwd])
      await grant(caller, "read", bunDiscoveryResources(cwd))
      if (scope(cwdInput) !== cwd || nodeIdentity(cwd) !== cwdIdentity) throw new FormatterExecutionError("changed", "Bun project directory changed during authorization")
      return resolveBunProjectCommand("format", cwd, { homeDir: dirname(root), resolveBun: options.resolveBun ?? (directory => resolveServerBinary(["bun"], directory)),
        hasCommand: async (binary: string) => {
          if (!isAbsolute(binary)) throw new FormatterExecutionError("invalid_path", "Bun probe requires an absolute executable")
          const executableIdentity = identity(binary)
          const scratch = join(tmpdir(), `omo-v2-format-probe-${randomUUID()}`)
          const probe = join(scratch, "probe.ts")
          const help = Object.freeze([binary, "format", "--help"])
          const format = Object.freeze([binary, "format", "--write", "probe.ts"])
          await authorize(caller, { kind: "probe", path: cwd, cwd: scratch, command: help, mutates: true })
          await grant(caller, "read", [scratch])
          await grant(caller, "edit", [scratch])
          await grant(caller, "shell", [help.join(" ")])
          await grant(caller, "shell", [format.join(" ")])
          check(caller.signal)
          if (identity(binary) !== executableIdentity || scope(cwdInput) !== cwd || nodeIdentity(cwd) !== cwdIdentity) throw new FormatterExecutionError("changed", "Bun executable or project directory changed during authorization")
          mkdirSync(scratch)
          const canonicalScratch = realpathSync(scratch)
          try {
            if (await child(help, scratch, 3000, caller) !== 0) return false
            writeFileSync(probe, "const a=1\n")
            if (await child(format, scratch, 3000, caller) !== 0) return false
            if (realpathSync(scratch) !== canonicalScratch || realpathSync(probe) !== join(canonicalScratch, "probe.ts")) throw new FormatterExecutionError("changed", "Bun probe changed its owned resource", true)
            return readFileSync(probe, "utf8") !== "const a=1\n"
          } finally { rmSync(scratch, { recursive: true, force: true }) }
        },
      })
    })
  }
  function isIgnored(filePath: string, genuineCaller: ToolContext): Promise<boolean> {
    return own(async () => {
      const caller = capture(genuineCaller)
      const file = scope(filePath)
      const pending = queues.get(file) ?? Promise.resolve()
      const work = (async () => {
        await wait(pending.catch(() => {}), caller.signal)
        check(caller.signal)
        const snapshot = identity(file)
        const fence = () => {
          check(caller.signal)
          if (scope(filePath) !== file || identity(file) !== snapshot) throw new FormatterExecutionError("changed", "Git inspection resource changed during authorization")
        }
        await authorize(caller, { kind: "inspect", path: file, cwd: root, command: Object.freeze(["git", "check-ignore", "-q", "--", relative(root, file)]), mutates: false })
        fence()
        await grant(caller, "read", [root, file, join(root, ".git"), join(root, ".gitignore"), ...bunDiscoveryResources(root)])
        fence()
        const binary = resolveServerBinary(["git"], root, { stopAt: root })
        if (!binary) throw new FormatterExecutionError("missing_dependency", "Git is unavailable for ignore inspection; original mutation remains committed")
        const binarySnapshot = executableIdentity(binary)
        const command = Object.freeze([binary, "check-ignore", "-q", "--", relative(root, file)])
        await grant(caller, "shell", [command.join(" ")])
        fence()
        if (executableIdentity(binary) !== binarySnapshot) throw new FormatterExecutionError("changed", "Git executable changed during authorization")
        const exit = await child(command, root, 3000, caller, "inspect")
        check(caller.signal)
        if (exit === "missing") throw new FormatterExecutionError("missing_dependency", "Git could not start for ignore inspection; original mutation remains committed")
        if (exit === 0) return true
        if (exit === 1 || exit === 128) return false
        throw new FormatterExecutionError("inspect", "Git ignore inspection failed; original mutation remains committed", false, exit)
      })()
      queues.set(file, work)
      try { return await work } finally { if (queues.get(file) === work) queues.delete(file) }
    })
  }
  return {
    runCli, resolveBunFormat, isIgnored,
    dispose(): Promise<void> {
      if (!disposal) {
        closed = true
        lifetime.abort(new FormatterExecutionError("disposed", "Formatter executor disposed", true))
        disposal = Promise.allSettled([...active]).then(() => {})
      }
      return disposal
    },
  }
}
