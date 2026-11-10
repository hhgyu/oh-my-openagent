import { AsyncLocalStorage } from "node:async_hooks"
import { homedir } from "node:os"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { ToolContext, Result } from "@opencode/plugin/promise/tool"
import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import {
  LspClient, LspManager, withLspClient, findWorkspaceRoot, effectiveExtension,
   filterDiagnosticsBySeverity, formatDiagnostic, formatLocation,
  formatDocumentSymbol, formatSymbolInfo, formatPrepareRenameResult, formatApplyResult,
  inferExtensionFromDirectory, collectFilesWithExtension, LspServerLookupError,
  planWorkspaceEdit, commitWorkspaceEditPlan,
  type ResolvedServer, type WorkspaceEdit, type WorkspaceMutationDelta, type Diagnostic,
} from "@oh-my-opencode/lsp-core"
import { runWithRequestContext, canonicalizeExistingOrNearestAncestor, isPathInside, type LspRequestContext } from "@oh-my-opencode/lsp-core/request-context"
import { findBunProjectRoot, resolveBunProjectCommand, runBunCommand } from "@oh-my-opencode/lsp-core/lsp/bun-project-checks"
import { parseBunCheckOutput, parseBunLintJson } from "@oh-my-opencode/lsp-core/lsp/bun-command-output"
import { DEFAULT_FORMATTING_OPTIONS } from "@oh-my-opencode/lsp-core/lsp/format-document"
import { normalizeTextEdits } from "@oh-my-opencode/lsp-core/lsp/workspace-edit-text"
import { lspSchemas, type LspToolName } from "./schemas"

export class LspToolFailure extends Error {
  override readonly name = "LspToolFailure"
  constructor(readonly code: "missing_dependency" | "invalid_path" | "workspace_edit_rejected" | "diagnostics_unavailable" | "disposed" | "reentrant_operation", message: string) { super(message) }
}

function workspaceQuery(query: string | undefined): string {
  if (query === undefined) throw new Error("query is required for workspace scope")
  return query
}

/** Reuses the neutral transport and document tracker. No call acquires core's auto-write
 * mutation lease: unsolicited server applyEdit is refused, including during initialization. */
export class RequestOnlyLspClient extends LspClient {
  async requestRename(filePath: string, line: number, character: number, newName: string, signal: AbortSignal): Promise<WorkspaceEdit | null> {
    await this.openFile(filePath)
    return this.sendRequest<WorkspaceEdit | null>("textDocument/rename", {
      textDocument: { uri: pathToFileURL(filePath).href }, position: { line: line - 1, character }, newName,
    }, { signal })
  }
}

export interface LspFormatResult {
  readonly details: {
    readonly status: "formatted" | "unchanged" | "unavailable"
    readonly reason?: string
    readonly message?: string
    readonly linesAdded: number
    readonly linesRemoved: number
    readonly changedFiles?: readonly string[]
    readonly delta?: WorkspaceMutationDelta
  }
}

export interface LspMutation {
  readonly tool: "lsp_rename" | "format"
  readonly context: ToolContext
  readonly changedFiles: readonly string[]
  readonly delta: WorkspaceMutationDelta
  readonly success: boolean
}
export interface LspRuntimeOptions {
  readonly directory: string
  readonly homeDirectory?: string
  readonly permission: Pick<PermissionDomain, "assert">
  /** The session/tool policy owner must reject read-only callers here; never infer identity. */
  readonly authorize: (context: ToolContext, operation: { readonly tool: LspToolName | "format"; readonly mutates: boolean; readonly path: string }) => void | Promise<void>
  /** Required sink for actual mutation facts, including partial commits. No formatter implied. */
  readonly onMutation: (event: LspMutation) => void | Promise<void>
  readonly clientFactory?: (root: string, server: ResolvedServer) => RequestOnlyLspClient
  readonly resolveServer?: (extension: string) => ResolvedServer
}

function awaitSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value) }, error => { signal.removeEventListener("abort", abort); reject(error) })
    if (signal.aborted) abort()
  })
}
function result(content: string, details: Record<string, unknown>, isError = false): Result {
  return { content, metadata: { ...details, isError } }
}

/** Windows LSP URIs often lowercase the drive. Core plans use exact root equality
 * while walking ancestors; preserve the owning root spelling before that walk. */
export function normalizeWorkspaceEditUris(edit: WorkspaceEdit, directory: string): WorkspaceEdit {
  directory = realpathSync(resolve(directory))
  const uri = (value: string): string => {
    const url = new URL(value)
    if (url.protocol !== "file:" || url.search || url.hash) throw new LspToolFailure("workspace_edit_rejected", `Unsupported edit URI: ${value}`)
    const path = fileURLToPath(url)
    const physical = canonicalizeExistingOrNearestAncestor(path)
    const normalized = isPathInside(directory, path) && isPathInside(directory, physical) ? resolve(directory, relative(directory, path)) : path
    return pathToFileURL(normalized).href
  }
  if (edit.changes) {
    const changes: NonNullable<WorkspaceEdit["changes"]> = {}
    for (const [path, edits] of Object.entries(edit.changes)) {
      const normalized = uri(path)
      if (Object.hasOwn(changes, normalized)) throw new LspToolFailure("workspace_edit_rejected", "Duplicate file aliases in workspace edit")
      changes[normalized] = edits
    }
    return { ...edit, changes }
  }
  if (edit.documentChanges) return { ...edit, documentChanges: edit.documentChanges.map(change => {
    if ("textDocument" in change) return { ...change, textDocument: { ...change.textDocument, uri: uri(change.textDocument.uri) } }
    if (change.kind === "rename") return { ...change, oldUri: uri(change.oldUri), newUri: uri(change.newUri) }
    return { ...change, uri: uri(change.uri) }
  }) }
  return edit
}
export function createLspRuntime(options: LspRuntimeOptions) {
  if (!options.authorize || !options.onMutation) throw new Error("LSP requires caller policy and mutation sink")
  const directory = realpathSync(resolve(options.directory))
  const home = resolve(options.homeDirectory ?? homedir())
  const context: LspRequestContext = {
    cwd: directory,
    projectConfigPaths: [join(directory, ".omo/lsp-client.json"), join(directory, ".opencode/lsp.json"), join(directory, ".omo/lsp.json")],
    userConfigPath: join(home, ".omo/lsp-client.json"), installDecisionsPath: join(home, ".omo/lsp-install-decisions.json"), capabilities: { installDecisionTool: false },
  }
  let manager: LspManager | undefined
  let disposed = false
  let disposal: Promise<void> | undefined
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  const operationScope = new AsyncLocalStorage<{ active: boolean }>()
  // Rename and reads share one queue: document synchronization cannot race another request.
  let tail: Promise<unknown> = Promise.resolve()
  const getManager = () => manager ??= new LspManager({ clientFactory: options.clientFactory ?? ((root, server) => new RequestOnlyLspClient(root, server)) })
  const canonical = (path: string) => canonicalizeExistingOrNearestAncestor(resolve(directory, path))
  async function permission(caller: ToolContext, action: string, resources: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted()
    await awaitSignal(options.permission.assert({ sessionID: caller.sessionID, agent: caller.agent, action, resources: [...new Set(resources)], source: { type: "tool", messageID: caller.messageID, id: caller.id } }), signal)
    signal.throwIfAborted()
  }
  async function grantRead(caller: ToolContext, paths: readonly string[], signal: AbortSignal) {
    const resources = paths.map(canonical)
    await permission(caller, "read", resources, signal)
  }
  async function locations(caller: ToolContext, values: readonly unknown[], signal: AbortSignal) {
    const paths: string[] = []
    for (const value of values) {
      if (!value || typeof value !== "object") continue
      const item = value as { uri?: string; targetUri?: string; location?: { uri: string } }
      const uri = item.targetUri ?? item.uri ?? item.location?.uri
      if (uri) {
        let path: string
        try { const url = new URL(uri); if (url.protocol !== "file:" || url.search || url.hash) throw Error(); path = fileURLToPath(url) }
        catch { throw new LspToolFailure("invalid_path", `Language server returned unsupported URI: ${uri}`) }
        paths.push(path)
      }
    }
    if (paths.length) await grantRead(caller, paths, signal)
  }
  async function withClient<T>(path: string, signal: AbortSignal, operation: string, fn: (client: RequestOnlyLspClient, root: string, file: string) => Promise<T>): Promise<T> {
    const owned = getManager()
    if (options.resolveServer) {
      const server = options.resolveServer(effectiveExtension(path))
      const root = findWorkspaceRoot(path)
      const client = await owned.getClient(root, server, signal)
      try { return await fn(client as RequestOnlyLspClient, root, path) }
      finally { owned.releaseClient(root, server.id) }
    }
    return withLspClient(path, (client, root, file) => fn(client as RequestOnlyLspClient, root, file), operation, { manager: owned, signal })
  }
  function queued<T>(caller: ToolContext, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new LspToolFailure("disposed", "LSP component disposed"))
    if (operationScope.getStore()?.active) return Promise.reject(new LspToolFailure("reentrant_operation", "Call LSP operations after the original execution settles, never inside its onMutation callback"))
    const signal = AbortSignal.any([caller.signal, lifetime.signal])
    const work = tail.catch(() => {}).then(() => runWithRequestContext(context, () => {
      const scope = { active: true }
      return operationScope.run(scope, async () => {
        try { signal.throwIfAborted(); return await operation(signal) }
        finally { scope.active = false }
      })
    }))
    tail = work
    active.add(work); void work.then(() => active.delete(work), () => active.delete(work))
    return awaitSignal(work, signal)
  }
  async function runFormat(filePath: string, caller: ToolContext, signal: AbortSignal): Promise<LspFormatResult> {
    const inputPath = lspSchemas.lsp_diagnostics.parse({ filePath }).filePath
    const path = canonical(inputPath)
    if (!isPathInside(directory, path)) throw new LspToolFailure("invalid_path", "Formatting must stay inside the owning workspace")
    await awaitSignal(Promise.resolve(options.authorize(caller, { tool: "format", mutates: true, path })), signal)
    await grantRead(caller, [path, findWorkspaceRoot(path)], signal)
    if (canonical(inputPath) !== path || !statSync(path).isFile()) throw new LspToolFailure("invalid_path", "Formatting requires a stable source file in the owning workspace")
    const stamp = () => { const stat = statSync(path); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":") }
    const beforeStamp = stamp()
    const before = readFileSync(path, "utf8")
    const unchangedSnapshot = () => {
      signal.throwIfAborted()
      if (canonical(inputPath) !== path || stamp() !== beforeStamp || readFileSync(path, "utf8") !== before) throw new LspToolFailure("workspace_edit_rejected", "File changed during LSP formatting; retry without overwriting the external edit")
    }
    unchangedSnapshot()
    let acquired = false
    try {
      return await withClient(path, signal, "format", async client => {
        acquired = true
        unchangedSnapshot()
        let edits: Awaited<ReturnType<LspClient["formatDocument"]>>
        try { edits = await client.formatDocument(path, DEFAULT_FORMATTING_OPTIONS, signal) }
        catch (error) {
          unchangedSnapshot()
          if (error && typeof error === "object" && "code" in error && error.code === -32601) return { details: { status: "unavailable", reason: "capability_not_advertised", linesAdded: 0, linesRemoved: 0 } }
          throw error
        }
        unchangedSnapshot()
        if (edits === null) return { details: { status: "unavailable", reason: "capability_not_advertised", linesAdded: 0, linesRemoved: 0 } }
        const normalized = normalizeTextEdits(before, edits, 0)
        if (normalized.text === before) return { details: { status: "unchanged", linesAdded: 0, linesRemoved: 0 } }
        const edit = normalizeWorkspaceEditUris({ changes: { [pathToFileURL(path).href]: [...normalized.edits] } }, directory)
        const planned = planWorkspaceEdit(edit, directory)
        if (!planned.success) throw new LspToolFailure("workspace_edit_rejected", planned.result.errors.join("\n"))
        await permission(caller, "edit", [path], signal)
        unchangedSnapshot()
        const committed = commitWorkspaceEditPlan(planned.plan, { signal })
        if (committed.delta.changedPaths.length) {
          // A format is an internal operation fact with the ORIGINAL caller, not a new tool trace.
          let observerFailed = false; let observerError: unknown
          try { await options.onMutation({ tool: "format", context: caller, changedFiles: committed.delta.changedPaths, delta: committed.delta, success: committed.result.success }) }
          catch (error) { observerFailed = true; observerError = error }
          let syncFailed = false; let syncError: unknown
          try { await client.openFile(path) }
          catch (error) { syncFailed = true; syncError = error }
          if (observerFailed) throw observerError
          if (syncFailed) throw syncError
        }
        if (!committed.result.success) throw new LspToolFailure("workspace_edit_rejected", committed.result.errors.join("\n"))
        signal.throwIfAborted()
        return { details: { status: "formatted", linesAdded: normalized.edits.reduce((count, edit) => count + edit.newText.split("\n").length, 0), linesRemoved: normalized.edits.reduce((count, edit) => count + edit.range.end.line - edit.range.start.line + 1, 0), changedFiles: committed.delta.changedPaths, delta: committed.delta } }
      })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (!acquired && error instanceof LspServerLookupError) {
        unchangedSnapshot()
        return { details: { status: "unavailable", reason: "missing_dependency", message: error.message, linesAdded: 0, linesRemoved: 0 } }
      }
      throw error
    }
  }
  async function bunDiagnostics(path: string, extension: string, severity: "error" | "warning" | "information" | "hint" | "all", caller: ToolContext, signal: AbortSignal): Promise<Result | undefined> {
    if (![".ts", ".tsx", ".mts", ".cts"].includes(extension) || !findBunProjectRoot(path, home)) return undefined
    // Even capability probes invoke a project-resolved executable, so permission comes first.
    await permission(caller, "shell", ["bun check", "bun lint"], signal)
    const bun = await resolveBunProjectCommand("check", path, { homeDir: home })
    signal.throwIfAborted()
    if (!bun) return undefined
    let run: Awaited<ReturnType<typeof runBunCommand>>
    try { run = await runBunCommand(bun, ["check", "--no-pretty", "."], path, signal) }
    catch (error) { if (signal.aborted) throw error; return undefined }
    const parsed = parseBunCheckOutput(run.stdout, path)
    if ((run.exitCode !== 0 && run.exitCode !== 1) || (run.exitCode === 1 && !parsed.length)) return undefined
    const commands = ["bun check"]
    let lintStatus: string | undefined
    const lint = await resolveBunProjectCommand("lint", path, { homeDir: home })
    signal.throwIfAborted()
    if (lint) {
      commands.push("bun lint")
      try {
        const output = await runBunCommand(lint, ["lint", "-f", "json", "."], path, signal)
        const diagnostics = output.exitCode === 0 || output.exitCode === 1 ? parseBunLintJson(output.stdout) : undefined
        if (diagnostics) { parsed.push(...diagnostics); lintStatus = "Lint: bun lint" }
        else lintStatus = `Lint: bun lint could not lint (exit ${output.exitCode ?? "signal"})`
      } catch (error) {
        if (signal.aborted) throw error
        lintStatus = `Lint: bun lint could not run: ${String(error)}`
      }
    }
    await grantRead(caller, parsed.map(item => item.file), signal)
    const diagnostics = parsed.filter(item => filterDiagnosticsBySeverity([item.diagnostic], severity).length)
    return result([`Directory: ${path}`, `Typecheck: bun check`, ...(lintStatus ? [lintStatus] : []), `Total diagnostics: ${diagnostics.length}`, ...diagnostics.slice(0, 200).map(item => `${item.file}: ${formatDiagnostic(item.diagnostic)}`)].join("\n"), { filePath: path, mode: "directory", severity, diagnostics, totalDiagnostics: diagnostics.length, truncated: diagnostics.length > 200, projectCommands: commands })
  }
  async function run(name: LspToolName, raw: unknown, caller: ToolContext, signal: AbortSignal): Promise<Result> {
    if (disposed) throw new LspToolFailure("disposed", "LSP component disposed")
    signal.throwIfAborted()
    const input = lspSchemas[name].parse(raw)
    const path = canonical(input.filePath)
    await awaitSignal(Promise.resolve(options.authorize(caller, { tool: name, mutates: name === "lsp_rename", path })), signal)
    await grantRead(caller, [path], signal)
    // Always grant the workspace read: LS resolves imports and symbols beyond the input file.
    await grantRead(caller, [findWorkspaceRoot(path)], signal)
    const stablePath = canonical(input.filePath)
    if (stablePath !== path) throw new LspToolFailure("invalid_path", "Input path changed during permission approval; retry")
    const base = { ...input, filePath: path }
    if (name === "lsp_diagnostics") {
      const severity = "severity" in input ? input.severity : "all"
      if (statSync(path).isDirectory()) {
        const extension = inferExtensionFromDirectory(path)
        if (!extension) return result(`No supported source files found in directory: ${path}`, { ...base, mode: "directory", diagnostics: [], totalDiagnostics: 0, truncated: false, errorKind: "no_files" }, true)
        const bun = await bunDiagnostics(path, extension, severity, caller, signal)
        if (bun) return bun
        const files = collectFilesWithExtension(path, extension, 51)
        await grantRead(caller, files, signal)
        const diagnostics: { file: string; diagnostic: Diagnostic }[] = []
        for (const file of files.slice(0, 50)) {
          signal.throwIfAborted()
          const output = await withClient(file, signal, "diagnostics", client => client.diagnostics(file, signal))
          if (output.transientError) throw new LspToolFailure("diagnostics_unavailable", output.transientError.message)
          diagnostics.push(...filterDiagnosticsBySeverity(output.items, severity).map(diagnostic => ({ file, diagnostic })))
        }
        return result([`Directory: ${path}`, `Files scanned: ${Math.min(files.length, 50)}${files.length > 50 ? " (capped at 50)" : ""}`, ...diagnostics.slice(0, 200).map(item => `${item.file}: ${formatDiagnostic(item.diagnostic)}`)].join("\n"), { ...base, mode: "directory", diagnostics, totalDiagnostics: diagnostics.length, truncated: diagnostics.length > 200 || files.length > 50 })
      }
      return withClient(path, signal, "diagnostics", async client => {
        const output = await client.diagnostics(path, signal)
        if (output.transientError) throw new LspToolFailure("diagnostics_unavailable", output.transientError.message)
        const diagnostics = filterDiagnosticsBySeverity(output.items, severity)
        return result(diagnostics.length ? `${diagnostics.length > 200 ? `Found ${diagnostics.length} diagnostics (showing first 200):\n` : ""}${diagnostics.slice(0, 200).map(formatDiagnostic).join("\n")}` : "No diagnostics found", { ...base, mode: "file", diagnostics: diagnostics.map(diagnostic => ({ file: path, diagnostic })), totalDiagnostics: diagnostics.length, truncated: diagnostics.length > 200 })
      })
    }
    if (statSync(path).isDirectory()) throw new LspToolFailure("invalid_path", "Use a source file; only lsp_diagnostics accepts directories")
    if (name === "lsp_symbols" && "scope" in input) {
      return withClient(path, signal, input.scope === "workspace" ? "workspaceSymbols" : "documentSymbols", async client => {
        const symbols = input.scope === "workspace" ? await client.workspaceSymbols(workspaceQuery(input.query), signal) : await client.documentSymbols(path, signal)
        await locations(caller, symbols, signal)
        const lines = symbols.slice(0, input.limit).map(symbol => "range" in symbol ? formatDocumentSymbol(symbol) : formatSymbolInfo(symbol))
        return result(symbols.length ? `${symbols.length > input.limit ? `Found ${symbols.length} symbols (showing first ${input.limit}):\n` : ""}${lines.join("\n")}` : "No symbols found", { ...base, symbols, totalSymbols: symbols.length, truncated: symbols.length > input.limit })
      })
    }
    if (!("line" in input)) throw new Error("Position required")
    if (name === "lsp_goto_definition" || name === "lsp_find_references") {
      return withClient(path, signal, name === "lsp_goto_definition" ? "definition" : "references", async client => {
        const output = name === "lsp_goto_definition" ? await client.definition(path, input.line, input.character, signal) : await client.references(path, input.line, input.character, "includeDeclaration" in input && typeof input.includeDeclaration === "boolean" ? input.includeDeclaration : true, signal)
        const values = output ? Array.isArray(output) ? output : [output] : []
        await locations(caller, values, signal)
        return result(values.length ? `${values.length > 200 ? `Found ${values.length} references (showing first 200):\n` : ""}${values.slice(0, 200).map(formatLocation).join("\n")}` : name === "lsp_goto_definition" ? "No definition found" : "No references found", { ...base, ...(name === "lsp_goto_definition" ? { locations: values } : { references: values, totalReferences: values.length, truncated: values.length > 200 }) })
      })
    }
    if (name === "lsp_prepare_rename") return withClient(path, signal, "prepareRename", async client => {
      const value = await client.prepareRename(path, input.line, input.character, signal)
      return result(formatPrepareRenameResult(value), { ...base, result: value })
    })
    if (!("newName" in input) || typeof input.newName !== "string") throw new Error("Rename newName required")
    if (!isPathInside(directory, path)) throw new LspToolFailure("invalid_path", "Rename must stay inside the owning workspace")
    const newName = input.newName
    return withClient(path, signal, "rename", async client => {
      const rawEdit = await client.requestRename(path, input.line, input.character, newName, signal)
      const edit = rawEdit && normalizeWorkspaceEditUris(rawEdit, directory)
      if (!edit) throw new LspToolFailure("workspace_edit_rejected", "Language server provided no rename edit")
      const planned = planWorkspaceEdit(edit, directory)
      if (!planned.success) throw new LspToolFailure("workspace_edit_rejected", planned.result.errors.join("\n"))
      // Planner snapshots include every descendant affected by resource operations.
      const resources = [...planned.plan.firstChangeByPath.keys()]
      for (const operation of planned.plan.operations) {
        if (operation.kind === "delete" || operation.kind === "rename") {
          const affected = operation.kind === "rename" ? operation.oldPath : operation.path
          const destination = operation.kind === "rename" ? operation.newPath : undefined
          for (const snapshotPath of planned.plan.snapshots.keys()) {
            if (destination && isPathInside(destination, snapshotPath)) resources.push(snapshotPath)
            if (isPathInside(affected, snapshotPath)) {
              resources.push(snapshotPath)
              if (destination) resources.push(resolve(destination, snapshotPath.slice(affected.length + 1)))
            }
          }
        }
      }
      for (const operation of planned.plan.operations) {
        if (operation.kind === "text" && operation.documentVersion !== null && client.getOpenDocumentVersion(operation.path) !== operation.documentVersion) throw new LspToolFailure("workspace_edit_rejected", "Rename document version changed; retry")
      }
      await permission(caller, "edit", resources.length ? resources : [path], signal)
      signal.throwIfAborted()
      // Canonical URI resolution and snapshots must still match after permission awaits.
      const rechecked = planWorkspaceEdit(edit, directory)
      if (!rechecked.success || rechecked.plan.fingerprint !== planned.plan.fingerprint || JSON.stringify([...rechecked.plan.snapshots]) !== JSON.stringify([...planned.plan.snapshots])) throw new LspToolFailure("workspace_edit_rejected", "Workspace changed during rename approval; retry")
      const committed = commitWorkspaceEditPlan(planned.plan, { signal })
      let syncError: string | undefined
      if (committed.delta.changedPaths.length) {
        // Required fact is emitted for actual partial writes, even when the operation reports failure.
        try { await options.onMutation({ tool: "lsp_rename", context: caller, changedFiles: committed.delta.changedPaths, delta: committed.delta, success: committed.result.success }) }
        catch (error) { syncError = `Mutation observer failed after commit: ${String(error)}` }
        for (const file of committed.delta.changedPaths) {
          if (existsSync(file) && statSync(file).isFile()) {
            try { await client.openFile(file) } catch (error) { syncError = `Document sync failed after commit: ${String(error)}` }
          }
        }
      }
      return result([formatApplyResult(committed.result), syncError].filter(Boolean).join("\n"), { ...base, apply: committed.result, edit, changedFiles: committed.delta.changedPaths, delta: committed.delta, ...(syncError ? { error: syncError } : {}) }, !committed.result.success || !!syncError)
    })
  }
  return {
    execute(name: LspToolName, input: unknown, caller: ToolContext): Promise<Result> {
      return queued(caller, async signal => {
        try { return await run(name, input, caller, signal) }
        catch (error) {
          if (signal.aborted) throw signal.reason
          if (error instanceof LspServerLookupError) throw new LspToolFailure("missing_dependency", error.message)
          throw error
        }
      })
    },
    /** Invoke only after the original tool execution has settled; onMutation is not a dispatch seam. */
    format(filePath: string, caller: ToolContext): Promise<LspFormatResult> {
      return queued(caller, signal => runFormat(filePath, caller, signal))
    },
    snapshot() { return manager?.getSnapshot() ?? [] },
    dispose(): Promise<void> {
      if (disposal) return disposal
      disposed = true; lifetime.abort(new LspToolFailure("disposed", "LSP component disposed"))
      disposal = (async () => { await Promise.allSettled([...active]); await manager?.stopAll() })()
      return disposal
    },
  }
}
