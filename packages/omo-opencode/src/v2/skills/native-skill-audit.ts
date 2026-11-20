import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"

export type AuditClass = "MANDATORY" | "CONDITIONAL"

export interface AuditHit {
  readonly file: string
  readonly line: number
  readonly rule: string
  readonly class: AuditClass
  readonly reason: string
  readonly text: string
}

const BANNER_HEADING = "## Senpi Harness Tool Compatibility"

interface Rule {
  readonly name: string
  readonly pattern: RegExp
  /** A forbidden identifier is MANDATORY wherever it appears outside the staged banner; the rest need a ledger entry. */
  readonly forbidden: boolean
}

/** Identifiers OpenCode 2 lacks (a Native-only tool, env var, SDK, skill or question-call field). */
const RULES: readonly Rule[] = [
  { name: "waitForAnswer", pattern: /waitForAnswer/, forbidden: true },
  { name: "ask_user_question", pattern: /ask_user_question|request_user_input/, forbidden: true },
  { name: "required-flag", pattern: /(?<![\w_])required: true/, forbidden: true },
  { name: "OMO_DAG_SDK_ROOT", pattern: /OMO_DAG_SDK_ROOT/, forbidden: true },
  { name: "mass-ulw-read", pattern: /(?:Read|read) `?mass-ulw/, forbidden: true },
  { name: "team_status", pattern: /\bteam_status\b/, forbidden: false },
  { name: "team_list", pattern: /\bteam_list\b/, forbidden: false },
  { name: "team_send_message", pattern: /\bteam_send_message\b/, forbidden: false },
  {
    name: "team_shutdown",
    pattern: /\bteam_(?:shutdown_request|approve_shutdown|reject_shutdown)\b/,
    forbidden: false,
  },
  { name: "team_task", pattern: /\bteam_task_[a-z]+\b/, forbidden: false },
  { name: "monitor", pattern: /`monitor`/, forbidden: false },
  { name: "kill_bash", pattern: /\bkill_bash\b/, forbidden: false },
  { name: "dag", pattern: /`dag`|\bdag (?:node|SDK|tool|run|surface)|dag-library|OMO_DAG/i, forbidden: false },
  { name: "lsp_status", pattern: /\blsp_status\b/, forbidden: false },
  { name: "mass-ulw", pattern: /mass-ulw/, forbidden: false },
  {
    name: "senpi-only",
    pattern: /~\/\.senpi|\.senpi\/|SENPI_[A-Z_]+|\bsenpi (?:run|login|install|update|-p)\b/,
    forbidden: false,
  },
]

export interface AcceptedMention {
  /** A path prefix relative to the staged skills directory. */
  readonly file: string
  readonly rule: string
  readonly reason: string
}

/**
 * Mentions left as Native text, each with the reason it is not a normal-path instruction V2 must follow. A hit of a
 * non-forbidden rule outside the staged banner and outside this ledger fails the audit.
 */
const ACCEPTED_MENTIONS: readonly AcceptedMention[] = [
  {
    file: "ulw-research/",
    rule: "dag",
    reason:
      "a mass-research dag node exists only when the opt-in MASS branch runs on a graph surface; V2 takes the background-worker fallback",
  },
  {
    file: "ulw-research/references/research-collection.md",
    rule: "mass-ulw",
    reason: "conditional on a dependency-graph surface; the same paragraph carries the background-worker fallback",
  },
  {
    file: "frontend/references/design/",
    rule: "mass-ulw",
    reason: "an optional parallel-reader pointer; grounding.md:9 names parallel subagents as the alternative",
  },
  {
    file: "init-deep/SKILL.md",
    rule: "lsp_status",
    reason:
      "an availability check followed by the explicit fallback 'only if LSP is unavailable: explore agents + ast-grep'",
  },
  {
    file: "coding-agent-sessions/",
    rule: "senpi-only",
    reason:
      "documents where Senpi stores session transcripts, which the skill reads as data on a machine that has them",
  },
  {
    file: "ast-grep/README.md",
    rule: "senpi-only",
    reason: "install note about the Senpi skills directory, not a tool instruction",
  },
]

export function auditNativeSkillText(
  file: string,
  text: string,
  accepted: readonly AcceptedMention[] = ACCEPTED_MENTIONS,
): AuditHit[] {
  const hits: AuditHit[] = []
  let inBanner = false
  text.split("\n").forEach((line, index) => {
    if (line.startsWith("## ")) inBanner = line.startsWith(BANNER_HEADING)
    for (const rule of RULES) {
      if (!rule.pattern.test(line)) continue
      const base = { file, line: index + 1, rule: rule.name, text: line.trim().slice(0, 200) }
      if (inBanner && !rule.forbidden) {
        hits.push({
          ...base,
          class: "CONDITIONAL",
          reason: "inside the staged banner, a mapping table that wins over inline examples",
        })
        continue
      }
      const entry = rule.forbidden ? undefined : accepted.find((a) => a.rule === rule.name && file.startsWith(a.file))
      hits.push(
        entry
          ? { ...base, class: "CONDITIONAL", reason: entry.reason }
          : { ...base, class: "MANDATORY", reason: "not allowed on the V2 normal path and not accepted" },
      )
    }
  })
  return hits
}

function listTextFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTextFiles(path)
    return /\.(?:md|mjs|ya?ml|json|txt)$/.test(entry.name) ? [path] : []
  })
}

export function auditStagedSkills(root: string, accepted: readonly AcceptedMention[] = ACCEPTED_MENTIONS): AuditHit[] {
  return listTextFiles(root).flatMap((path) =>
    auditNativeSkillText(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"), accepted),
  )
}
