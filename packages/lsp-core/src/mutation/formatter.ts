import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { isDarwinAutomountTriggerPath } from "@oh-my-opencode/utils/path-containment"
import { basename, extname, relative, resolve } from "node:path"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { createSpawnCommand } from "../lsp/process"
import { resolveServerBinary } from "../lsp/server-installation"
import { resolveBunProjectCommand } from "../lsp/bun-project-checks"
import { extractMutatedFilePaths, MUTATION_TOOL_NAMES, runSingleFlight, type PostMutationEvent } from "./post-mutation"

// Mutation formatting is intentionally opt-in through project markers and fail-open by default.
export const formatOnMutationDefaults = { mode: "best-effort", maxFileBytes: 1_048_576, timeoutMs: 3_000 } as const
export type FormatMode = "off" | "best-effort" | "required"
export type FormatterTool = "biome" | "prettier" | "bun format" | "rustfmt" | "gofmt" | "ruff"
export type Formatter = { readonly tool: FormatterTool; readonly command: string; readonly args: readonly string[] }

// Sentinel for "the child never started": a non-numeric variant so no real exit code —
// including negative Windows NTSTATUS-style codes — can be mistaken for it. The caller
// reports the formatter as missing instead of treating it as a failed format run.
type ChildExit = number | "spawn-failed"

export function resolveFormatMode(config: { mode?: FormatMode; languages?: Record<string, boolean> }, language: string): FormatMode {
  if (config.languages?.[language] === false) return "off"
  return config.mode ?? "best-effort"
}

export const bunFormatter: Formatter = { tool: "bun format", command: "bun", args: ["format", "--write"] }

export function detectFormatter(markers: readonly string[], filePath: string, configText = ""): Formatter | undefined {
  const name = basename(filePath)
  void name
  const ext = extname(filePath)
  if (markers.includes("biome.json") || markers.includes("biome.jsonc")) return { tool: "biome", command: "biome", args: ["format", "--write"] }
  if (markers.some((m) => m === ".prettierrc" || m.startsWith(".prettierrc") || m === "prettier.config.js" || m.startsWith("prettier.config."))) return { tool: "prettier", command: "prettier", args: ["--write"] }
  if (markers.includes("rustfmt.toml") || markers.includes("Cargo.toml")) return ext === ".rs" ? { tool: "rustfmt", command: "rustfmt", args: [] } : undefined
  if (markers.includes("go.mod")) return ext === ".go" ? { tool: "gofmt", command: "gofmt", args: ["-w"] } : undefined
  if ((markers.includes("ruff.toml") || (markers.includes("pyproject.toml") && /^\s*\[tool\.ruff\]/m.test(configText))) && ext === ".py") return { tool: "ruff", command: "ruff", args: ["format"] }
  return undefined
}

export interface FormatterOutcome { readonly status: "formatted" | "unchanged" | "missing"; readonly added: number; readonly removed: number }
export interface FormatterCliRequest {
  readonly filePath: string
  readonly cwd: string
  readonly timeoutMs: number
  readonly binary: string
  readonly formatter: Formatter
}
/** Host-specific authority/lifetime adapters. Omitted by Native, preserving its existing path. */
export interface FormatterHostPorts {
  readonly runCli?: (request: FormatterCliRequest) => Promise<FormatterOutcome>
  readonly isIgnored?: (filePath: string, cwd: string) => boolean | Promise<boolean>
  /** Explicit host resolution; null must not fall through to ambient discovery. */
  readonly resolveBinary?: (command: string, cwd: string) => string | null
  readonly singleFlight?: <T>(path: string, work: () => Promise<T>) => Promise<T>
  /** Rethrow host rejection/abort here; Native's default still allows CLI fallback. */
  readonly daemonError?: (error: unknown) => void
}

export type FormatterDaemonPort = (filePath: string) => Promise<{ readonly content?: readonly { readonly type: string; readonly text?: string }[]; readonly details?: unknown; readonly isError?: boolean }>

export interface FormatterStepOptions {
  readonly config?: Partial<{ mode: FormatMode; languages: Record<string, boolean>; maxFileBytes: number; timeoutMs: number }>
  readonly markers?: (cwd: string) => readonly string[]
  readonly readMarker?: (cwd: string, marker: string) => string
  readonly resolveBinary?: (command: string, cwd: string) => string | null
  readonly resolveBunFormat?: (cwd: string) => Promise<string | undefined>
  readonly logger?: { warn(message: string, details?: unknown): void }
}

export function createFormatterStep(options: FormatterStepOptions, daemonFormat: FormatterDaemonPort, ports?: FormatterHostPorts) {
  const missingNotices = new Set<string>()
  const resolveBunFormat = options.resolveBunFormat ?? (cwd => resolveBunProjectCommand("format", cwd))
  return async function formatMutation(event: PostMutationEvent, cwd: string, sessionId = "anonymous") {
    if (event.toolName === undefined || !MUTATION_TOOL_NAMES.has(event.toolName) || event.input === undefined) return { content: undefined, error: undefined }
    const config = { ...formatOnMutationDefaults, ...(options.config ?? {}) }
    if (config.mode === "off") return { content: undefined, error: undefined }
    const additions: { readonly type: "text"; readonly text: string }[] = []
    let requiredError: string | undefined
    for (const rawPath of extractMutatedFilePaths(event)) {
      const filePath = resolve(cwd, rawPath)
      // A file behind a macOS automount trigger is not formatted: probing it can park the host loop (#11545).
      if (isDarwinAutomountTriggerPath(filePath)) continue
      if (!existsSync(filePath)) continue
      if (ports?.isIgnored ? await ports.isIgnored(filePath, cwd) : isGitIgnored(filePath, cwd)) continue
      if (readFileSync(filePath).byteLength > config.maxFileBytes) continue
      const markerNames = options.markers?.(cwd) ?? []
      const detected = detectFormatter(markerNames, filePath, options.readMarker?.(cwd, "pyproject.toml") ?? "")
      if (!detected) continue
      const language = languageForPath(filePath)
      if (resolveFormatMode(config, language) === "off") continue
      const probedBun = detected.tool === "prettier" ? await resolveBunFormat(cwd) : undefined
      const marker = probedBun === undefined ? detected : { ...bunFormatter, command: probedBun }
      const result = await (ports?.singleFlight ?? runSingleFlight)(filePath, () => formatOne(filePath, marker, cwd, config.timeoutMs, daemonFormat, options.resolveBinary, ports))
      if (result.status === "formatted") additions.push({
        type: "text",
        text: `\n\n(OmO) auto-formatted ${relative(cwd, filePath)} with ${marker.tool} (+${result.added}/-${result.removed} lines). File content changed; re-read before exact-text edits.`,
      })
      if (result.status === "missing" && config.mode === "required") requiredError = `Formatter ${marker.tool} is unavailable for ${rawPath}`
      if (result.status === "missing" && config.mode === "best-effort" && !missingNotices.has(`${sessionId}:${marker.tool}`)) {
        missingNotices.add(`${sessionId}:${marker.tool}`)
        options.logger?.warn(`Formatter ${marker.tool} unavailable; install it with bun add -d`)
      }
    }
    return { content: additions.length ? additions : undefined, error: requiredError }
  }
}

function languageForPath(path: string): string { const ext = extname(path); return ext === ".ts" || ext === ".tsx" ? "typescript" : ext === ".py" ? "python" : ext.slice(1) }
function isGitIgnored(filePath: string, cwd: string): boolean {
  try { execFileSync("git", ["check-ignore", "-q", "--", relative(cwd, filePath)], { cwd, stdio: "ignore", windowsHide: true }); return true } catch { return false }
}

async function formatOne(filePath: string, formatter: Formatter, cwd: string, timeoutMs: number, daemonFormat: FormatterDaemonPort, resolveBinary?: FormatterStepOptions["resolveBinary"], ports?: FormatterHostPorts): Promise<FormatterOutcome> {
  try {
    const daemon = await daemonFormat!(filePath)
    const details = daemon.details as Record<string, unknown> | undefined
    if (details?.["status"] === "formatted") return { status: "formatted", added: Number(details["linesAdded"] ?? 0), removed: Number(details["linesRemoved"] ?? 0) }
    if (details?.["reason"] !== "capability_not_advertised" && details?.["status"] !== "unavailable") return { status: "unchanged", added: 0, removed: 0 }
  } catch (error) { ports?.daemonError?.(error) /* Native CLI fallback remains the default. */ }
  const binary = ports?.resolveBinary ? ports.resolveBinary(formatter.command, cwd) : resolveBinary?.(formatter.command, cwd) ?? resolveServerBinary([formatter.command], cwd)
  if (!binary) return { status: "missing", added: 0, removed: 0 }
  if (ports?.runCli) return ports.runCli({ filePath, formatter, cwd, timeoutMs, binary })
  const before = readFileSync(filePath, "utf8")
  // Windows cannot spawn the extensionless POSIX shim npm/bun writes into node_modules/.bin,
  // and Node refuses a bare .cmd/.bat since CVE-2024-27980. createSpawnCommand resolves the
  // real launcher and routes shims through ComSpec as separate argv entries, which keeps the
  // file path from being reparsed as shell syntax, so reuse it instead of spawning raw.
  const prepared = createSpawnCommand([binary, ...formatter.args, filePath])
  let child: ReturnType<typeof spawn>
  try {
    child = spawn(prepared.command, prepared.args, { cwd, stdio: "ignore", shell: prepared.shell, windowsHide: true })
  } catch {
    return { status: "missing", added: 0, removed: 0 }
  }
  const exit = await Promise.race([childExit(child), new Promise<"timeout">(resolve => setTimeout(() => { child.kill("SIGKILL"); resolve("timeout") }, timeoutMs))])
  if (exit === "spawn-failed") return { status: "missing", added: 0, removed: 0 }
  if (exit !== 0) { writeFileSync(filePath, before); return { status: "unchanged", added: 0, removed: 0 } }
  const after = readFileSync(filePath, "utf8")
  if (after === before) return { status: "unchanged", added: 0, removed: 0 }
  return { status: "formatted", added: Math.max(0, after.split("\n").length - before.split("\n").length), removed: Math.max(0, before.split("\n").length - after.split("\n").length) }
}
function childExit(child: ReturnType<typeof spawn>): Promise<ChildExit> {
  return new Promise(resolve => {
    child.once("exit", code => resolve(code ?? 1))
    // A child that fails to spawn emits "error" and never "exit". Without this listener Node
    // re-throws it as an uncaughtException, so one unspawnable formatter kills the whole agent.
    child.once("error", () => resolve("spawn-failed"))
  })
}
