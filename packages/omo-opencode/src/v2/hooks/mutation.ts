import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import type { Info, Result, ToolContext, ToolDomain } from "@opencode/plugin/promise/tool"
import { canonicalizeExistingOrNearestAncestor, isPathInside } from "@oh-my-opencode/lsp-core/request-context"
import type { PostMutationEvent } from "@oh-my-opencode/lsp-core/mutation/post-mutation"

type Execute = Info["execute"]
export interface MutationFormatRequest {
  /** Normalized canonical event; the original host callback still receives its exact input. */
  readonly event: PostMutationEvent
  /** Surviving final paths only. Use these for the actual formatter invocation. */
  readonly files: readonly string[]
}
export interface MutationReport {
  readonly tool: string
  readonly status: "processed" | "skipped" | "postprocess-error"
  readonly committed: boolean | "unknown"
  readonly paths: readonly string[]
  readonly deleted: readonly string[]
  readonly reason?: string
  readonly phase?: "format" | "diagnostics" | "report" | "decorate"
  readonly formatting?: unknown
  readonly diagnostics?: readonly { readonly file: string; readonly result: unknown }[]
  /** Kept in caller custody; this library never logs or serializes raw errors. */
  readonly error?: unknown
}
export interface MutationHookOptions {
  readonly directory: string
  readonly authorize: (caller: ToolContext, operation: { readonly tool: string; readonly paths: readonly string[] }) => void | Promise<void>
  /** Bind Core formatter host ports to this caller; singleFlight must run work()
   * directly rather than share Native's global per-path authorization outcome. */
  readonly format: (request: MutationFormatRequest, caller: ToolContext) => Promise<{ readonly content?: unknown; readonly error?: string }>
  readonly diagnostics: (file: string, caller: ToolContext) => Promise<unknown>
  readonly report: (report: MutationReport, caller: ToolContext) => void | Promise<void>
  /** The production composer exposes actual format/diagnostic output here.
   * Without deliberate decoration, preserve the original host Result identity. */
  readonly decorate?: (result: Result, report: MutationReport, caller: ToolContext) => Result | Promise<Result>
  /** Only if ownership of persistent backend resources is delegated to this factory. */
  readonly disposePorts?: () => Promise<void>
}
export class MutationHookFailure extends Error {
  override readonly name = "MutationHookFailure"
  constructor(readonly code: "disposed" | "input_changed" | "formatter_required", message: string) { super(message) }
}

interface Plan { readonly event: PostMutationEvent; readonly paths: readonly string[]; readonly deleted: ReadonlySet<string>; readonly signature: string }
function record(input: unknown): input is Record<string, unknown> { return typeof input === "object" && input !== null && !Array.isArray(input) }
function plan(tool: string, input: unknown, directory: string): Plan | undefined {
  if (!record(input)) return undefined
  const paths = new Set<string>(), deleted = new Set<string>()
  const add = (path: string) => { const full = canonicalizeExistingOrNearestAncestor(resolve(directory, path)); paths.add(full); return full }
  let event: PostMutationEvent
  if (tool === "patch" || tool === "apply_patch") {
    const text = tool === "patch" ? input.patchText : input.input
    if (typeof text !== "string") return undefined
    let source: string | undefined
    for (const line of text.split(/\r?\n/)) {
      const match = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line)
      if (!match) continue
      const path = add(match[2].trim())
      if (match[1] === "Delete File") deleted.add(path)
      else if (match[1] === "Move to") { if (source) deleted.add(source); source = undefined; deleted.delete(path) }
      else { source = path; deleted.delete(path) }
    }
    event = { toolName: "apply_patch", input: { input: text } }
  } else if (tool === "write" || tool === "edit") {
    const path = input.path ?? input.filePath
    if (typeof path !== "string" || !path) return undefined
    add(path)
    event = { toolName: tool, input: { ...input } }
  } else return undefined
  if (!paths.size) return undefined
  return { event, paths: [...paths].sort(), deleted, signature: JSON.stringify(input) }
}
function key(path: string): string { return process.platform === "win32" ? path.toLowerCase() : path }

/** Explicit composition only. No root registration or unsupported LSP-rename scope claim.
 * Contexts derive only a lifetime signal and progress proxy from the genuine host caller;
 * session/message/call/agent authority is never fabricated. */
export function createMutationHooks(options: MutationHookOptions) {
  const directory = realpathSync(resolve(options.directory))
  const lifetime = new AbortController()
  const retired = new MutationHookFailure("disposed", "Mutation hooks have been disposed")
  const active = new Set<Promise<unknown>>()
  const tails = new Map<string, Promise<void>>()
  const owned = new WeakSet<Execute>()
  let registration: Promise<{ dispose(): Promise<void> }> | undefined
  let disposing: Promise<void> | undefined

  function check(caller: ToolContext) { if (caller.signal.aborted) throw caller.signal.reason; if (lifetime.signal.aborted) throw retired }
  function wait(work: Promise<void>, caller: ToolContext): Promise<void> {
    return new Promise((ok, fail) => {
      const abort = () => { caller.signal.removeEventListener("abort", abort); fail(caller.signal.reason) }
      caller.signal.addEventListener("abort", abort, { once: true })
      work.then(() => { caller.signal.removeEventListener("abort", abort); ok() }, fail)
      if (caller.signal.aborted) abort()
    })
  }
  function reserve(paths: readonly string[], caller: ToolContext) {
    const previous: Promise<void>[] = [], releases: (() => void)[] = []
    for (const path of [...new Set(paths.map(key))].sort()) {
      const before = tails.get(path) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      const tail = before.then(() => held)
      tails.set(path, tail); previous.push(before); releases.push(release)
      void tail.then(() => { if (tails.get(path) === tail) tails.delete(path) })
    }
    return { ready: wait(Promise.all(previous).then(() => {}), caller), release: () => { for (const release of releases) release() } }
  }
  const inside = (paths: readonly string[]) => paths.every(path => isPathInside(directory, path))

  function wrap(tool: string, original: Execute): Execute {
    const wrapped: Execute = (input: unknown, actual: ToolContext) => {
      const caller: ToolContext = Object.freeze({ ...actual, signal: AbortSignal.any([actual.signal, lifetime.signal]), progress: (update: Parameters<ToolContext["progress"]>[0]) => actual.progress(update) })
      const work = Promise.resolve().then(async () => {
        check(caller)
        const planned = (() => {
          try { return plan(tool, input, directory) }
          catch { return undefined } // Unsupported discovery preserves the original host mutation.
        })()
        const scoped = planned !== undefined && inside(planned.paths)
        const lock = reserve(planned?.paths ?? [], caller)
        try {
          await lock.ready; check(caller)
          if (scoped) {
            const current = plan(tool, input, directory)
            if (!current || current.signature !== planned.signature || current.paths.join("\0") !== planned.paths.join("\0")) throw new MutationHookFailure("input_changed", "Mutation input or physical paths changed while queued")
            await options.authorize(caller, { tool, paths: planned.paths }); check(caller)
            const authorized = plan(tool, input, directory)
            if (!authorized || authorized.signature !== planned.signature || authorized.paths.join("\0") !== planned.paths.join("\0")) throw new MutationHookFailure("input_changed", "Mutation input or physical paths changed during authorization")
          }
          const result = await original(input, caller)
          if (result.metadata?.isError === true) {
            await options.report({ tool, status: "skipped", committed: "unknown", paths: planned?.paths ?? [], deleted: [], reason: "host_returned_error" }, caller)
            return result
          }
          if (!scoped) {
            await options.report({ tool, status: "skipped", committed: true, paths: planned?.paths ?? [], deleted: [], reason: planned ? "outside_owned_location" : "unknown_mutation_paths" }, caller)
            return result
          }
          const deleted = [...planned.deleted]
          let phase: NonNullable<MutationReport["phase"]> = "format"
          let formatting: unknown
          const diagnostics: { file: string; result: unknown }[] = []
          try {
            check(caller)
            const physical = planned.paths.map(path => canonicalizeExistingOrNearestAncestor(path))
            if (!inside(physical) || physical.some((path, index) => path !== planned.paths[index])) {
              await options.report({ tool, status: "skipped", committed: true, paths: planned.paths, deleted, reason: "physical_paths_changed_after_mutation" }, caller)
              return result
            }
            const files = planned.paths.filter(path => !planned.deleted.has(path) && existsSync(path))
            if (files.length) {
              const outcome = await options.format({ event: planned.event, files }, caller)
              formatting = outcome
              if (outcome.error) throw new MutationHookFailure("formatter_required", outcome.error)
              check(caller); phase = "diagnostics"
              for (const file of files) { check(caller); diagnostics.push({ file, result: await options.diagnostics(file, caller) }) }
            }
            const processed: MutationReport = { tool, status: "processed", committed: true, paths: planned.paths, deleted, formatting, diagnostics }
            phase = "report"; check(caller); await options.report(processed, caller)
            phase = "decorate"; check(caller)
            const output = options.decorate ? await options.decorate(result, processed, caller) : result
            check(caller)
            return output
          } catch (error) {
            try { await options.report({ tool, status: "postprocess-error", committed: true, paths: planned.paths, deleted, phase, formatting, diagnostics, error }, caller) } catch { /* Preserve original denial/abort identity if its observer fails. */ }
            throw error
          }
        } finally { lock.release() }
      })
      active.add(work)
      void work.then(() => active.delete(work), () => active.delete(work))
      return work
    }
    owned.add(wrapped)
    return wrapped
  }

  async function dispose(): Promise<void> {
    if (!disposing) disposing = (async () => {
      lifetime.abort(retired)
      try { if (registration) await (await registration).dispose() }
      finally {
        try { await options.disposePorts?.() }
        finally { await Promise.allSettled([...active]) }
      }
    })()
    return disposing
  }
  return {
    async register(context: { readonly tool: Pick<ToolDomain, "transform"> }): Promise<() => Promise<void>> {
      if (lifetime.signal.aborted) throw retired
      if (!registration) registration = context.tool.transform(editor => {
        for (const tool of editor.list()) {
          if (!["patch", "apply_patch", "write", "edit", "lsp_rename"].includes(tool.name) || owned.has(tool.execute)) continue
          editor.update(tool.id, current => { if (!owned.has(current.execute)) current.execute = wrap(current.name, current.execute) })
        }
      })
      try { await registration } catch (error) { await dispose(); throw error }
      if (lifetime.signal.aborted) { await dispose(); throw retired }
      return dispose
    },
    dispose,
  }
}
