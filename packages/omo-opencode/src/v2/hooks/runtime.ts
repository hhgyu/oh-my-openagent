import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import { createFormatterStep } from "@oh-my-opencode/lsp-core/mutation/formatter"
import { resolveServerBinary } from "@oh-my-opencode/lsp-core/lsp/server-installation"
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import { createLspComponent, LspToolFailure } from "../tools/lsp"
import { createFormatterExecutor } from "./formatter-executor"
import { createMutationHooks, type MutationReport } from "./mutation"

export interface MutationRuntimeOptions {
  readonly enabled?: boolean
  readonly diagnosticsEnabled?: boolean
  readonly formatOnMutation?: OmoConfig["formatOnMutation"]
}
export interface MutationSummary {
  readonly sessionID: string
  readonly callID: string
  readonly tool: string
  readonly status: MutationReport["status"]
  readonly committed: boolean | "unknown"
  readonly paths: readonly string[]
  readonly reason?: string
}
type Host = Pick<Plugin.Context, "tool" | "permission" | "location" | "session">
type Execute = Info["execute"]
function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path
}
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
  })
}
function textContent(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : []
  if (!Array.isArray(value)) return []
  return value.flatMap((part) =>
    part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
  )
}
function decorate(original: Result, report: MutationReport): Result {
  const formatting = report.formatting as { content?: unknown } | undefined
  const extra = [...textContent(formatting?.content)]
  for (const diagnostic of report.diagnostics ?? []) {
    const value = diagnostic.result as { content?: unknown } | undefined
    const texts = textContent(value?.content)
    if (texts.length) extra.push(`\n\n(OmO) Post-edit diagnostics: ${diagnostic.file}\n${texts.join("\n")}`)
  }
  return {
    ...original,
    content:
      typeof original.content === "string"
        ? [original.content, ...extra].join("\n")
        : [...(original.content ?? []), ...extra.map((text) => ({ type: "text" as const, text }))],
    metadata: {
      ...original.metadata,
      omoMutation: { committed: report.committed, status: report.status, paths: [...report.paths] },
    },
  }
}

/** Complete explicit host composition. Internal service calls keep the original SDK authority;
 * they do not fabricate nested host transcript events or replay other plugins' hooks. */
export function createMutationRuntime(options: MutationRuntimeOptions = {}) {
  let phase: "new" | "registering" | "active" | "closed" = "new"
  let cleanup: (() => Promise<void>) | undefined
  const summaries = new Map<string, MutationSummary>()
  let lspMutations = 0
  return {
    snapshot() {
      return {
        active: phase === "active",
        enabled: options.enabled !== false,
        lspMutations,
        reports: [...summaries.values()],
      }
    },
    async register(host: Host): Promise<() => Promise<void>> {
      if (phase !== "new") throw new Error("Mutation runtime already registered or closed")
      phase = "registering"
      if (options.enabled === false) {
        phase = "active"
        return async () => {
          phase = "closed"
        }
      }
      const root = realpathSync(host.location.directory)
      const rootInfo = statSync(root),
        rootIdentity = `${rootInfo.dev}:${rootInfo.ino}`
      const lifetime = new AbortController(),
        retired = new Error("Mutation runtime disposed")
      const calls = new Set<Promise<unknown>>()
      const missing = new Map<string, Set<string>>()
      let tail: Promise<void> = Promise.resolve()
      let workspaceRegistration: Awaited<ReturnType<typeof host.tool.transform>> | undefined
      let closeHooks: (() => Promise<void>) | undefined, closeLsp: (() => Promise<void>) | undefined
      function check(caller: ToolContext) {
        lifetime.signal.throwIfAborted()
        caller.signal.throwIfAborted()
        const info = statSync(root)
        if (
          pathKey(realpathSync(host.location.directory)) !== pathKey(root) ||
          `${info.dev}:${info.ino}` !== rootIdentity
        )
          throw new Error("Mutation runtime owner directory changed")
      }
      async function authorize(caller: ToolContext) {
        check(caller)
        const info = await withAbort(
          host.session.get({ sessionID: caller.sessionID }, { signal: caller.signal }),
          caller.signal,
        )
        check(caller)
        if (info.id !== caller.sessionID || pathKey(realpathSync(info.location.directory)) !== pathKey(root))
          throw new Error("Mutation caller belongs to another host location")
      }
      const executor = createFormatterExecutor({ directory: root, permission: host.permission, authorize })
      const lsp = createLspComponent({
        authorize,
        onMutation: async () => {
          lspMutations++
        },
      })
      function report(value: MutationReport, caller: ToolContext) {
        const key = `${caller.sessionID}:${caller.id}`
        summaries.set(key, {
          sessionID: caller.sessionID,
          callID: caller.id,
          tool: value.tool,
          status: value.status,
          committed: value.committed,
          paths: [...value.paths],
          ...(value.reason ? { reason: value.reason } : {}),
        })
        if (summaries.size > 128) {
          const oldest = summaries.keys().next()
          if (!oldest.done) summaries.delete(oldest.value)
        }
      }
      const hooks = createMutationHooks({
        directory: root,
        authorize,
        async format(request, caller) {
          if (!request.files.length || options.formatOnMutation?.mode === "off") return {}
          await authorize(caller)
          // File bytes are read by the common formatter before its daemon/CLI callback.
          await withAbort(
            host.permission.assert({
              sessionID: caller.sessionID,
              agent: caller.agent,
              action: "read",
              resources: [...request.files],
              source: { type: "tool", messageID: caller.messageID, id: caller.id },
            }),
            caller.signal,
          )
          check(caller)
          const formatter = createFormatterStep(
            {
              ...(options.formatOnMutation ? { config: options.formatOnMutation } : {}),
              markers: () => readdirSync(root),
              readMarker: (_cwd, marker) => {
                try {
                  return readFileSync(join(root, marker), "utf8")
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
                  throw error
                }
              },
              resolveBunFormat: (cwd) => executor.resolveBunFormat(cwd, caller),
              logger: {
                warn(message) {
                  let seen = missing.get(caller.sessionID)
                  if (!seen) {
                    seen = new Set()
                    missing.set(caller.sessionID, seen)
                  }
                  if (!seen.has(message)) {
                    seen.add(message)
                    console.warn(`[oh-my-openagent/v2] ${message}`)
                  }
                },
              },
            },
            (file) => lsp.format(file, caller),
            {
              runCli: (request) => executor.runCli(request, caller),
              isIgnored: (file) => executor.isIgnored(file, caller),
              resolveBinary: (command, cwd) => resolveServerBinary([command], cwd, { stopAt: root }),
              // The outer workspace gate serializes real mutations. Never share authority/results.
              singleFlight: async (_file, work) => work(),
              daemonError: (error) => {
                throw error
              },
            },
          )
          return formatter(
            { toolName: request.event.toolName, input: { paths: [...request.files] } },
            root,
            caller.sessionID,
          )
        },
        async diagnostics(file, caller) {
          if (options.diagnosticsEnabled === false) return { content: "" }
          await authorize(caller)
          try {
            return await lsp.diagnostics(file, caller)
          } catch (error) {
            if (!(error instanceof LspToolFailure) || error.code !== "missing_dependency") throw error
            const key = `diagnostics:${error.message}`
            let seen = missing.get(caller.sessionID)
            if (!seen) {
              seen = new Set()
              missing.set(caller.sessionID, seen)
            }
            if (seen.has(key)) return { content: "" }
            seen.add(key)
            return {
              content: `(OmO) Post-edit diagnostics unavailable: ${error.message}`,
              metadata: { unavailable: true },
            }
          }
        },
        report,
        decorate,
      })
      // A rename discovers its other files only after the server query. Until a shared
      // plan reservation exists, serialize owned workspace mutators including rename.
      const wrappers = new WeakSet<Execute>()
      const serial = (original: Execute): Execute => {
        const wrapped: Execute = (input, caller) => {
          const signal = AbortSignal.any([caller.signal, lifetime.signal])
          const derived: ToolContext = Object.freeze({
            ...caller,
            signal,
            progress: async (update: Parameters<ToolContext["progress"]>[0]) => {
              check(caller)
              signal.throwIfAborted()
              await caller.progress(update)
              signal.throwIfAborted()
            },
          })
          const prior = tail.catch(() => {})
          let release!: () => void
          const held = new Promise<void>((resolve) => {
            release = resolve
          })
          tail = prior.then(() => held)
          const work = (async () => {
            try {
              await withAbort(prior, signal)
              check(derived)
              await authorize(derived)
              return await original(input, derived)
            } finally {
              release()
            }
          })()
          calls.add(work)
          void work.then(
            () => calls.delete(work),
            () => calls.delete(work),
          )
          return work
        }
        wrappers.add(wrapped)
        return wrapped
      }
      let finishInstallation!: () => void
      let failInstallation!: (error: unknown) => void
      const installation = new Promise<void>((yes, no) => {
        finishInstallation = yes
        failInstallation = no
      })
      let disposal: Promise<void> | undefined
      cleanup = () => {
        if (disposal) return disposal
        phase = "closed"
        lifetime.abort(retired)
        disposal = (async () => {
          await installation.catch(() => {})
          const results = await Promise.allSettled([
            (async () => {
              if (workspaceRegistration) await workspaceRegistration.dispose()
            })(),
            (async () => {
              if (closeHooks) await closeHooks()
            })(),
            executor.dispose(),
            (async () => {
              if (closeLsp) await closeLsp()
            })(),
          ])
          await Promise.allSettled([...calls])
          missing.clear()
          const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
          if (failures.length)
            throw new AggregateError(
              failures.map((result) => result.reason),
              "Mutation runtime cleanup failed",
            )
        })()
        return disposal
      }
      void (async () => {
        const registeredLsp = await lsp.register(host)
        if (lifetime.signal.aborted) {
          await registeredLsp()
          throw retired
        }
        closeLsp = registeredLsp
        const registeredHooks = await hooks.register(host)
        if (lifetime.signal.aborted) {
          await registeredHooks()
          throw retired
        }
        closeHooks = registeredHooks
        const registeredWorkspace = await host.tool.transform((editor) => {
          for (const tool of editor.list()) {
            if (
              !["patch", "apply_patch", "write", "edit", "lsp_rename"].includes(tool.name) ||
              wrappers.has(tool.execute)
            )
              continue
            editor.update(tool.id, (current) => {
              if (!wrappers.has(current.execute)) current.execute = serial(current.execute)
            })
          }
        })
        if (lifetime.signal.aborted) {
          await registeredWorkspace.dispose()
          throw retired
        }
        workspaceRegistration = registeredWorkspace
        phase = "active"
      })().then(finishInstallation, failInstallation)
      try {
        await installation
        return cleanup
      } catch (error) {
        try {
          await cleanup()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Mutation runtime registration and rollback failed")
        }
        throw error
      }
    },
    async dispose() {
      if (cleanup) await cleanup()
      else phase = "closed"
    },
  }
}
