import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolContext, Info } from "@opencode/plugin/promise/tool"
import { createLspComponent } from "./index"
import { createLspRuntime, RequestOnlyLspClient, normalizeWorkspaceEditUris, type LspMutation } from "./runtime"
import type { PermissionDomain } from "@opencode/plugin/promise/permission"
import { lspSchemas, LSP_TOOL_NAMES } from "./schemas"
import { LspServerLookupError } from "@oh-my-opencode/lsp-core"
import type { WorkspaceEdit, ResolvedServer, TextEdit, FormattingOptions } from "@oh-my-opencode/lsp-core"

type PermissionInput = Parameters<PermissionDomain["assert"]>[0]
type LspHost = Parameters<ReturnType<typeof createLspComponent>["register"]>[0]
type ToolAdder = (editor: { add: (tool: Info) => void }) => void
const server: ResolvedServer = { id: "fixture", command: ["fixture"], extensions: [".ts"], priority: 0 }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "v2-lsp-unit-")))
  const a = join(root, "a.ts"),
    b = join(root, "b.ts")
  writeFileSync(a, "const original = 1\n")
  writeFileSync(b, "original\n")
  let starts = 0,
    stops = 0,
    requests = 0,
    formats = 0,
    syncs = 0
  let formatWork: (file: string, signal?: AbortSignal) => Promise<TextEdit[] | null> = async () => [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 18 } }, newText: "const original = 2;" },
  ]
  const events: LspMutation[] = []
  const permissions: PermissionInput[] = []
  let reject: unknown
  let authorizationReject: unknown
  let edit: WorkspaceEdit = {
    changes: {
      [pathToFileURL(a).href]: [
        { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } }, newText: "renamed" },
      ],
      [pathToFileURL(b).href]: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "renamed" },
      ],
    },
  }
  class Client extends RequestOnlyLspClient {
    override async start() {
      starts++
    }
    override async initialize() {}
    override isAlive() {
      return true
    }
    override async stop() {
      stops++
    }
    override async openFile() {
      syncs++
    }
    override getOpenDocumentVersion() {
      return undefined
    }
    override async requestRename() {
      requests++
      return edit
    }
    override async formatDocument(file: string, _options: FormattingOptions, signal?: AbortSignal) {
      formats++
      return formatWork(file, signal)
    }
    override async definition() {
      requests++
      return { uri: pathToFileURL(b).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } }
    }
    override async references() {
      return []
    }
    override async documentSymbols() {
      return []
    }
    override async prepareRename() {
      return { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } }
    }
    override async diagnostics() {
      return { items: [] }
    }
  }
  const controller = new AbortController()
  const caller = {
    sessionID: "real-caller",
    agent: "readonly-or-writer",
    messageID: "message",
    id: "call",
    signal: controller.signal,
    progress: async () => {},
  } as unknown as ToolContext
  const options = {
    directory: root,
    homeDirectory: root,
    permission: {
      assert: async (input: PermissionInput) => {
        permissions.push(input)
        if (reject) throw reject
      },
    },
    authorize: async () => {
      if (authorizationReject) throw authorizationReject
    },
    onMutation: async (event: LspMutation) => {
      events.push(event)
    },
    resolveServer: () => server,
    clientFactory: (r: string, s: ResolvedServer) => new Client(r, s),
  }
  const runtime = createLspRuntime(options)
  return {
    root,
    a,
    b,
    runtime,
    caller,
    options,
    controller,
    events,
    permissions,
    setEdit: (e: WorkspaceEdit) => {
      edit = e
    },
    setFormat: (fn: typeof formatWork) => {
      formatWork = fn
    },
    deny: (e: unknown) => {
      reject = e
    },
    denyCaller: (e: unknown) => {
      authorizationReject = e
    },
    counts: () => ({ starts, stops, requests, formats, syncs }),
    cleanup: async () => {
      await runtime.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}
describe("Native six-tool LSP OpenCode adapter", () => {
  test("exact six portable schemas preserve Native indexing/defaults and reject forged fields", () => {
    expect(LSP_TOOL_NAMES).toHaveLength(6)
    expect(lspSchemas.lsp_find_references.parse({ filePath: "a.ts", line: 1, character: 0 }).includeDeclaration).toBe(
      true,
    )
    expect(lspSchemas.lsp_diagnostics.parse({ filePath: "." }).severity).toBe("all")
    expect(lspSchemas.lsp_symbols.parse({ filePath: "a.ts", scope: "document", limit: 900 }).limit).toBe(200)
    expect(() => lspSchemas.lsp_symbols.parse({ filePath: "a.ts", scope: "workspace" })).toThrow()
    for (const line of [0, -1, 1.5])
      expect(() => lspSchemas.lsp_goto_definition.parse({ filePath: "a.ts", line, character: 0 })).toThrow()
    expect(() =>
      lspSchemas.lsp_rename.parse({ filePath: "a.ts", line: 1, character: 0, newName: "x", sessionID: "forged" }),
    ).toThrow()
  })
  test("disabled is genuinely unregistered; enabled factory registers all six and unregisters", async () => {
    const f = fixture()
    let transforms = 0
    let dispose = 0
    const tools: Info[] = []
    const host = {
      location: { directory: f.root },
      permission: f.options.permission,
      tool: {
        transform: async (fn: ToolAdder) => {
          transforms++
          fn({ add: (t: Info) => tools.push(t) })
          return {
            dispose: async () => {
              dispose++
            },
          }
        },
      },
    } as unknown as LspHost
    try {
      const off = await createLspComponent({ ...f.options, enabled: false }).register(host)
      expect(transforms).toBe(0)
      await off()
      const close = await createLspComponent(f.options).register(host)
      expect(tools.map((t) => t.name)).toEqual([...LSP_TOOL_NAMES])
      expect(f.counts().starts).toBe(0)
      await close()
      expect(dispose).toBe(1)
    } finally {
      await f.cleanup()
    }
  })
  test("denied input read preserves plain rejection and starts no server", async () => {
    const f = fixture()
    const rejection = { reason: "user rejected" }
    f.deny(rejection)
    try {
      try {
        await f.runtime.execute("lsp_goto_definition", { filePath: "a.ts", line: 1, character: 6 }, f.caller)
        throw Error("unexpected success")
      } catch (e) {
        expect(e).toBe(rejection)
      }
      expect(f.counts().starts).toBe(0)
    } finally {
      await f.cleanup()
    }
  })
  test("all rename edit resources approved before any write; exact mutation fact and caller", async () => {
    const f = fixture()
    try {
      const result = await f.runtime.execute(
        "lsp_rename",
        { filePath: "a.ts", line: 1, character: 6, newName: "renamed" },
        f.caller,
      )
      expect(readFileSync(f.a, "utf8")).toContain("renamed")
      expect(readFileSync(f.b, "utf8")).toContain("renamed")
      expect(
        f.permissions
          .filter((p) => p.action === "edit")
          .flatMap((p) => p.resources)
          .sort(),
      ).toEqual([f.a, f.b].sort())
      expect(f.events).toHaveLength(1)
      expect([...defined(f.events[0]).changedFiles].sort()).toEqual([f.a, f.b].sort())
      expect(defined(f.events[0]).context).toBe(f.caller)
      expect(result.metadata?.isError).toBe(false)
    } finally {
      await f.cleanup()
    }
  })
  test("readonly caller cannot request rename even with allowed host permissions", async () => {
    const f = fixture()
    const reason = Error("readonly")
    f.denyCaller(reason)
    try {
      await expect(
        f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller),
      ).rejects.toBe(reason)
      expect(f.counts().requests).toBe(0)
      expect(readFileSync(f.a, "utf8")).toContain("original")
    } finally {
      await f.cleanup()
    }
  })
  test("second resource denial leaves every file unchanged and emits no mutation", async () => {
    const f = fixture()
    const reason = Error("deny second edit")
    f.options.permission.assert = async (input: PermissionInput) => {
      f.permissions.push(input)
      if (input.action === "edit" && input.resources.includes(f.b)) throw reason
    }
    try {
      await expect(
        f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller),
      ).rejects.toBe(reason)
      expect(readFileSync(f.a, "utf8")).toContain("original")
      expect(readFileSync(f.b, "utf8")).toBe("original\n")
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("external edits rejected; symlink escape never writes target", async () => {
    const f = fixture()
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "v2-lsp-outside-")))
    const target = join(outside, "escape.ts")
    writeFileSync(target, "original\n")
    const bad = (p: string): WorkspaceEdit => ({
      changes: {
        [pathToFileURL(p).href]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "BAD" },
        ],
      },
    })
    try {
      f.setEdit(bad(target))
      await expect(
        f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller),
      ).rejects.toThrow("outside workspace")
      symlinkSync(outside, join(f.root, "linked"), process.platform === "win32" ? "junction" : "dir")
      f.setEdit(bad(join(f.root, "linked/escape.ts")))
      await expect(
        f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller),
      ).rejects.toThrow("outside workspace")
      expect(readFileSync(target, "utf8")).toBe("original\n")
    } finally {
      await f.cleanup()
      rmSync(outside, { recursive: true, force: true })
    }
  })
  test("cancellation during approval rejects immediately and cannot write on late approval", async () => {
    const f = fixture()
    let approved: (() => void) | undefined
    let reached: (() => void) | undefined
    const pending = new Promise<void>((r) => {
      reached = r
    })
    f.options.permission.assert = async (input: PermissionInput) => {
      if (input.action === "edit") {
        defined(reached)()
        await new Promise<void>((r) => {
          approved = r
        })
      }
    }
    try {
      const call = f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller)
      await pending
      const reason = Error("caller cancelled")
      f.controller.abort(reason)
      await expect(call).rejects.toBe(reason)
      defined(approved)()
      await new Promise((r) => setTimeout(r, 10))
      expect(readFileSync(f.a, "utf8")).toContain("original")
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("navigation requires grants for returned external locations and disposal is final", async () => {
    const f = fixture()
    try {
      await f.runtime.execute("lsp_goto_definition", { filePath: "a.ts", line: 1, character: 6 }, f.caller)
      expect(f.permissions.flatMap((p) => p.resources)).toContain(f.b)
      await f.runtime.dispose()
      expect(f.counts().stops).toBe(1)
      await expect(
        f.runtime.execute("lsp_goto_definition", { filePath: "a.ts", line: 1, character: 6 }, f.caller),
      ).rejects.toThrow("disposed")
    } finally {
      await f.cleanup()
    }
  })
  test("resource rename requires source, destination and descendant grants before moving", async () => {
    const f = fixture()
    const source = join(f.root, "folder"),
      destination = join(f.root, "moved")
    mkdirSync(source)
    writeFileSync(join(source, "child.ts"), "original\n")
    f.setEdit({
      documentChanges: [
        { kind: "rename", oldUri: pathToFileURL(source).href, newUri: pathToFileURL(destination).href },
      ],
    })
    try {
      await f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller)
      const resources = f.permissions.filter((p) => p.action === "edit").flatMap((p) => p.resources)
      expect(resources).toContain(source)
      expect(resources).toContain(destination)
      expect(resources).toContain(join(source, "child.ts"))
      expect(resources).toContain(join(destination, "child.ts"))
      expect(readFileSync(join(destination, "child.ts"), "utf8")).toBe("original\n")
    } finally {
      await f.cleanup()
    }
  })
  test("workspace changes while awaiting permissions abort all planned writes", async () => {
    const f = fixture()
    f.options.permission.assert = async (input: PermissionInput) => {
      if (input.action === "edit") writeFileSync(f.b, "concurrent change\n")
    }
    try {
      await expect(
        f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller),
      ).rejects.toThrow("Workspace changed")
      expect(readFileSync(f.a, "utf8")).toContain("original")
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("failed mutation observer reports committed files rather than pretending no edit", async () => {
    const f = fixture()
    f.options.onMutation = async () => {
      throw Error("observer offline")
    }
    try {
      const result = await f.runtime.execute(
        "lsp_rename",
        { filePath: "a.ts", line: 1, character: 6, newName: "x" },
        f.caller,
      )
      expect(result.metadata?.isError).toBe(true)
      expect(result.metadata?.changedFiles).toEqual([f.a, f.b])
      expect(readFileSync(f.a, "utf8")).toContain("renamed")
    } finally {
      await f.cleanup()
    }
  })
  test("cancelling one queued caller never cancels another caller or leaks permission identity", async () => {
    const f = fixture()
    const stopped = new AbortController()
    stopped.abort(Error("second stopped"))
    const other = {
      ...f.caller,
      sessionID: "another-real-caller",
      id: "other-call",
      signal: stopped.signal,
    } as ToolContext
    try {
      const first = f.runtime.execute("lsp_goto_definition", { filePath: "a.ts", line: 1, character: 6 }, f.caller)
      await expect(
        f.runtime.execute("lsp_goto_definition", { filePath: "a.ts", line: 1, character: 6 }, other),
      ).rejects.toThrow("second stopped")
      await first
      expect(f.permissions.every((p) => p.sessionID === "real-caller")).toBe(true)
      expect(f.counts().requests).toBe(1)
    } finally {
      await f.cleanup()
    }
  })
  test("Windows language-server URI drive casing is normalized before core ancestor walks", async () => {
    const f = fixture()
    try {
      const lowerDrive = (path: string) =>
        process.platform === "win32" ? defined(path[0]).toLowerCase() + path.slice(1) : path
      const edit: WorkspaceEdit = {
        changes: {
          [pathToFileURL(lowerDrive(f.a)).href]: [
            { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 14 } }, newText: "safe" },
          ],
        },
      }
      const normalized = normalizeWorkspaceEditUris(edit, f.root)
      expect(Object.keys(defined(normalized.changes))).toEqual([pathToFileURL(f.a).href])
      f.setEdit(edit)
      await f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "safe" }, f.caller)
      expect(readFileSync(f.a, "utf8")).toContain("safe")
    } finally {
      await f.cleanup()
    }
  })

  test("normalization preserves suffix casing and rejects non-file URIs without widening external paths", async () => {
    const f = fixture()
    try {
      const mixed = join(f.root, "MixedCase.ts")
      writeFileSync(mixed, "original\n")
      const textEdit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, newText: "x" }
      const edit = normalizeWorkspaceEditUris({ changes: { [pathToFileURL(mixed).href]: [textEdit] } }, f.root)
      expect(Object.keys(defined(edit.changes))).toEqual([pathToFileURL(mixed).href])
      expect(() =>
        normalizeWorkspaceEditUris({ changes: { "https://example.test/a.ts": [textEdit] } }, f.root),
      ).toThrow("Unsupported edit URI")
    } finally {
      await f.cleanup()
    }
  })

  test("overwriting a directory cannot bypass denial on an existing destination descendant", async () => {
    const f = fixture()
    const source = join(f.root, "source"),
      destination = join(f.root, "destination")
    mkdirSync(source)
    mkdirSync(destination)
    writeFileSync(join(source, "child.ts"), "source\n")
    const protectedFile = join(destination, "protected.ts")
    writeFileSync(protectedFile, "protected\n")
    f.setEdit({
      documentChanges: [
        {
          kind: "rename",
          oldUri: pathToFileURL(source).href,
          newUri: pathToFileURL(destination).href,
          options: { overwrite: true },
        },
      ],
    })
    const denied = Error("destination descendant denied")
    f.options.permission.assert = async (input: PermissionInput) => {
      if (input.action === "edit" && input.resources.includes(protectedFile)) throw denied
    }
    try {
      await expect(
        f.runtime.execute("lsp_rename", { filePath: "a.ts", line: 1, character: 6, newName: "x" }, f.caller),
      ).rejects.toBe(denied)
      expect(readFileSync(protectedFile, "utf8")).toBe("protected\n")
      expect(readFileSync(join(source, "child.ts"), "utf8")).toBe("source\n")
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
})

describe("owned internal LSP format backend", () => {
  test("format uses owned client, real edit permission and mutation caller then resynchronizes", async () => {
    const f = fixture()
    try {
      const output = await f.runtime.format("a.ts", f.caller)
      expect(output.details).toMatchObject({ status: "formatted", linesAdded: 1, linesRemoved: 1 })
      expect(readFileSync(f.a, "utf8")).toBe("const original = 2;\n")
      expect(f.permissions.some((p) => p.action === "read")).toBe(true)
      expect(f.permissions.filter((p) => p.action === "edit").flatMap((p) => p.resources)).toEqual([f.a])
      expect(defined(f.events[0]).tool).toBe("format")
      expect(defined(f.events[0]).context).toBe(f.caller)
      expect(f.counts().syncs).toBe(1)
    } finally {
      await f.cleanup()
    }
  })
  test("missing server or capability returns unavailable, while an unchanged edit is honest", async () => {
    const f = fixture()
    try {
      f.setFormat(async () => null)
      expect((await f.runtime.format("a.ts", f.caller)).details).toMatchObject({
        status: "unavailable",
        reason: "capability_not_advertised",
        linesAdded: 0,
        linesRemoved: 0,
      })
      f.setFormat(async () => [])
      expect((await f.runtime.format("a.ts", f.caller)).details.status).toBe("unchanged")
      f.options.resolveServer = () => {
        throw new LspServerLookupError("No server configured")
      }
      expect((await f.runtime.format("a.ts", f.caller)).details).toMatchObject({
        status: "unavailable",
        reason: "missing_dependency",
      })
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("only explicit method-not-found becomes unavailable; general errors preserve identity", async () => {
    const f = fixture()
    const failure = { code: -32603, message: "server failure" }
    try {
      f.setFormat(async () => {
        throw { code: -32601, message: "method not found" }
      })
      expect((await f.runtime.format("a.ts", f.caller)).details.status).toBe("unavailable")
      f.setFormat(async () => {
        throw failure
      })
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toBe(failure)
    } finally {
      await f.cleanup()
    }
  })
  test("readonly and read denial never call server; edit rejection never writes", async () => {
    const f = fixture()
    const rejection = { reason: "user rejection" }
    try {
      f.denyCaller(rejection)
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toBe(rejection)
      f.denyCaller(undefined)
      f.deny(rejection)
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toBe(rejection)
      expect(f.counts().formats).toBe(0)
      f.deny(undefined)
      f.options.permission.assert = async (input: PermissionInput) => {
        if (input.action === "edit") throw rejection
      }
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toBe(rejection)
      expect(readFileSync(f.a, "utf8")).toBe("const original = 1\n")
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("snapshot predates server request so concurrent edits cannot be overwritten", async () => {
    const f = fixture()
    try {
      f.setFormat(async (file) => {
        writeFileSync(file, "concurrent external edit\n")
        return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "BAD" }]
      })
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toThrow("changed")
      expect(readFileSync(f.a, "utf8")).toBe("concurrent external edit\n")
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("changes during edit approval and symlink escape fail before formatting write", async () => {
    const f = fixture()
    const external = realpathSync(mkdtempSync(join(tmpdir(), "v2-format-outside-")))
    const file = join(external, "a.ts")
    writeFileSync(file, "outside\n")
    try {
      f.options.permission.assert = async (input: PermissionInput) => {
        if (input.action === "edit") writeFileSync(f.a, "changed during approval\n")
      }
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toThrow("changed")
      expect(readFileSync(f.a, "utf8")).toBe("changed during approval\n")
      symlinkSync(external, join(f.root, "link"), process.platform === "win32" ? "junction" : "dir")
      const before = f.counts().formats
      await expect(f.runtime.format("link/a.ts", f.caller)).rejects.toThrow("workspace")
      expect(f.counts().formats).toBe(before)
      expect(readFileSync(file, "utf8")).toBe("outside\n")
    } finally {
      await f.cleanup()
      rmSync(external, { recursive: true, force: true })
    }
  })
  test("abort and final disposal reject pending format and never recreate the client", async () => {
    const f = fixture()
    let began: () => void = () => {}
    const started = new Promise<void>((r) => {
      began = r
    })
    f.setFormat(async (_file, signal) => {
      began()
      await new Promise<void>((_resolve, reject) => {
        defined(signal).addEventListener("abort", () => reject(defined(signal).reason), { once: true })
      })
      return []
    })
    try {
      const call = f.runtime.format("a.ts", f.caller)
      await started
      await f.runtime.dispose()
      await expect(call).rejects.toThrow("disposed")
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toThrow("disposed")
      expect(f.counts().starts).toBe(1)
      expect(f.counts().stops).toBe(1)
      expect(f.events).toHaveLength(0)
    } finally {
      await f.cleanup()
    }
  })
  test("onMutation recursion fails explicitly instead of queuing behind itself", async () => {
    const f = fixture()
    f.options.onMutation = async () => {
      await f.runtime.format("a.ts", f.caller)
    }
    try {
      await expect(f.runtime.format("a.ts", f.caller)).rejects.toThrow("after the original")
      expect(readFileSync(f.a, "utf8")).toBe("const original = 2;\n")
    } finally {
      await f.cleanup()
    }
  })
  test("component shares its one registered runtime, fences duplicate registration and closes format", async () => {
    const f = fixture()
    const tools: Info[] = []
    let disposed = 0
    const host = {
      location: { directory: f.root },
      permission: f.options.permission,
      tool: {
        transform: async (fn: ToolAdder) => {
          fn({ add: (tool: Info) => tools.push(tool) })
          return {
            dispose: async () => {
              disposed++
            },
          }
        },
      },
    } as unknown as LspHost
    try {
      const component = createLspComponent(f.options)
      await expect(component.format("a.ts", f.caller)).rejects.toThrow("registered")
      const close = await component.register(host)
      await expect(component.register(host)).rejects.toThrow("registered")
      await component.format("a.ts", f.caller)
      expect(tools.map((t) => t.name)).toEqual([...LSP_TOOL_NAMES])
      await defined(tools.find((t) => t.name === "lsp_goto_definition")).execute(
        { filePath: "a.ts", line: 1, character: 6 },
        f.caller,
      )
      expect(f.counts().starts).toBe(1)
      await close()
      await close()
      expect(disposed).toBe(1)
      await expect(component.format("a.ts", f.caller)).rejects.toThrow("disposed")
      const disabled = createLspComponent({ ...f.options, enabled: false })
      const off = await disabled.register(host)
      expect((await disabled.format("a.ts", f.caller)).details).toMatchObject({
        status: "unavailable",
        reason: "disabled",
      })
      await off()
      await expect(disabled.format("a.ts", f.caller)).rejects.toThrow("disposed")
    } finally {
      await f.cleanup()
    }
  })
})

test("format never reclassifies a permission or observer error as a missing capability", async () => {
  const f = fixture()
  const rejection = { code: -32601, message: "approval rejected" }
  try {
    f.options.permission.assert = async (input: PermissionInput) => {
      if (input.action === "edit") throw rejection
    }
    await expect(f.runtime.format("a.ts", f.caller)).rejects.toBe(rejection)
    expect(readFileSync(f.a, "utf8")).toBe("const original = 1\n")
    f.options.permission.assert = async () => {}
    f.options.onMutation = async () => {
      throw rejection
    }
    await expect(f.runtime.format("a.ts", f.caller)).rejects.toBe(rejection)
    expect(readFileSync(f.a, "utf8")).toBe("const original = 2;\n")
    expect(f.counts().syncs).toBe(1)
  } finally {
    await f.cleanup()
  }
})

test("parallel runtime disposal calls share the same completion promise", async () => {
  const f = fixture()
  try {
    await f.runtime.format("a.ts", f.caller)
    const first = f.runtime.dispose()
    const second = f.runtime.dispose()
    expect(first).toBe(second)
    await Promise.all([first, second])
    expect(f.counts().stops).toBe(1)
  } finally {
    await f.cleanup()
  }
})

test("component diagnostics uses genuine caller and its owned six-tool runtime without catalog lookup", async () => {
  const f = fixture()
  const tools: Info[] = []
  const callers: unknown[] = []
  const host = {
    location: { directory: f.root },
    permission: f.options.permission,
    tool: {
      transform: async (fn: ToolAdder) => {
        fn({ add: (tool: Info) => tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
  } as unknown as LspHost
  const component = createLspComponent({
    ...f.options,
    authorize: async (caller, operation) => {
      callers.push(caller)
      expect(operation.tool).toBe("lsp_diagnostics")
    },
  })
  try {
    await expect(component.diagnostics("a.ts", f.caller)).rejects.toThrow("registered")
    const close = await component.register(host)
    const output = await component.diagnostics("a.ts", f.caller)
    expect(callers).toEqual([f.caller])
    expect(callers[0]).toBe(f.caller)
    expect(output.metadata?.severity).toBe("error")
    expect(tools.map((tool) => tool.name)).toEqual([...LSP_TOOL_NAMES])
    expect(
      f.permissions.every(
        (request) =>
          request.sessionID === f.caller.sessionID &&
          request.source !== undefined &&
          "id" in request.source &&
          request.source.id === f.caller.id,
      ),
    ).toBe(true)
    await close()
    await expect(component.diagnostics("a.ts", f.caller)).rejects.toThrow("disposed")
    const disabled = createLspComponent({ ...f.options, enabled: false })
    const off = await disabled.register(host)
    expect((await disabled.diagnostics("a.ts", f.caller)).metadata).toMatchObject({
      status: "unavailable",
      errorKind: "missing_dependency",
      reason: "disabled",
    })
    await off()
    await expect(disabled.diagnostics("a.ts", f.caller)).rejects.toThrow("disposed")
  } finally {
    await f.cleanup()
  }
})
function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a defined value")
  return value
}
