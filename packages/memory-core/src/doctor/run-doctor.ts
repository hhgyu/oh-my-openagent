// /doctor: deterministic memory health checks plus the skill frontmatter repair, moved here from
// omo-senpi `components/memory/commands/doctor-runtime.ts` so every host renders the same report.
//
// Checks: repository presence, frontmatter validity sweep, persona presence, soul seed, stale locks,
// orphaned reflection worktrees, abandoned and quarantined runs, receipts, the ghost reservation, the
// host's reflection health, the compile-warn token advisory, the external projection, the structural
// audit and the facts advisory. Output is read-only and never enters model context.

import { auditMemoryRepo, type MemoryAuditReport } from "../audit"
import type { ExternalProjectionLimits } from "../compile"
import { parseCommandArgs } from "../commands/args"
import { factsParkedCauseSummary } from "../commands/facts-failure-cause"
import { factsRemediationHint, formatFactsAdvisory, readFactsOverview } from "../commands/facts-status"
import {
  formatSkillNameFrontmatterRepairReport,
  repairMissingSkillNameFrontmatter,
} from "../commands/skill-frontmatter"
import { estimateSystemTokens } from "../commands/tokens"
import {
  requireIdentity,
  respond,
  sessionIdOf,
  type MemoryCommandContext,
  type MemoryCommandDeps,
  type MemoryCommandIdentity,
} from "../commands/types"
import type { RuntimeRetentionPolicy } from "../retention"
import { redactSecretLikeMaterial } from "../sync/redact"
import {
  checkAbandonedRuns,
  checkFrontmatter,
  checkLocks,
  checkRepository,
  checkRuntimeSize,
  checkSoulSeed,
  checkTokens,
  checkWorktrees,
  type CheckLevel,
  type DoctorCheck,
  type RuntimeSizeReport,
} from "./checks"
import { checkProjection } from "./projection"
import { checkQuarantinedRuns, checkReceipts, type QuarantinedRun, type ReceiptSummaries } from "./receipts"
import { checkGhostReservation } from "./reservation"

/** What the host resolves for one bound identity, read only once its repository exists. */
export interface DoctorHostSettings {
  /** `memory.compile_warn_tokens`. */
  readonly warnTokens: number
  /** `memory.projection`, with the identity's override applied. */
  readonly projectionLimits: ExternalProjectionLimits
}

/** What the runtime-size check reads for one identity: its `memory.runtime` cap and windows. */
export interface DoctorRuntimeSizeSettings {
  readonly maxBytes: number
  readonly policy: RuntimeRetentionPolicy
  readonly reflectionEnabled: boolean
}

export interface DoctorDeps extends MemoryCommandDeps {
  doctorSettings(identity: MemoryCommandIdentity): DoctorHostSettings
  /** The reflection-health line: the host owns the reflection run records it reads. */
  reflectionHealth(identity: MemoryCommandIdentity, now: number): Promise<DoctorCheck>
  /** Stale-lock and ghost-reservation liveness probe; defaults to signal-0. */
  isProcessAlive?(pid: number): boolean
  /**
   * The skill `name:` frontmatter repair writes the working tree outside any memory commit. `false`
   * keeps the doctor read-only (the OpenCode 2 host); absent means repair, as Senpi does.
   */
  readonly skillRepair?: boolean
  /** The runtime-size line and its JSON report; absent means the host does not report the runtime size. */
  runtimeSize?(identity: MemoryCommandIdentity): DoctorRuntimeSizeSettings
  /**
   * `/doctor --fix`: runs the stale reflection-lock reaper for the session's identity and returns its report
   * lines. Absent means the host's /doctor has no `--fix` flag.
   */
  reflectionLockFix?(sessionId: string, options: { readonly dryRun: boolean }): Promise<readonly string[]>
}

const LEVEL_ORDER: Record<CheckLevel, number> = { ok: 0, warn: 1, fail: 2 }

function worstLevel(checks: readonly DoctorCheck[]): CheckLevel {
  return checks.reduce<CheckLevel>(
    (worst, check) => (LEVEL_ORDER[check.level] > LEVEL_ORDER[worst] ? check.level : worst),
    "ok",
  )
}

/**
 * Advisory only, and only when there IS something to advise: a healthy facts ledger renders
 * nothing, so the zero state stays silent. A corrupt ledger is a `fail`, since launches are
 * blocked until it is repaired.
 */
async function checkFacts(
  deps: DoctorDeps,
  identityPaths: MemoryCommandIdentity["identityPaths"],
): Promise<DoctorCheck | undefined> {
  const overview = await readFactsOverview({
    identityPaths,
    now: new Date(deps.now?.() ?? Date.now()),
  })
  const advisory = formatFactsAdvisory(overview)
  if (advisory === undefined) return undefined
  const hint = factsRemediationHint(overview)
  const causes = factsParkedCauseSummary(overview.records, overview.factsDir)
  return {
    name: "facts",
    level: overview.corrupt === undefined ? "warn" : "fail",
    detail: `${advisory.replace(/^facts: /, "")}${hint === undefined ? "" : `; ${hint}`}${causes === undefined ? "" : ` (${causes})`}`,
  }
}

function redactReportStrings(value: unknown): unknown {
  if (typeof value === "string") return redactSecretLikeMaterial(value)
  if (Array.isArray(value)) return value.map(redactReportStrings)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redactReportStrings(field)]))
  }
  return value
}

function auditChecks(audit: MemoryAuditReport): DoctorCheck[] {
  if (audit.issues.length === 0) return [{ name: "audit", level: "ok", detail: "no structural issues" }]
  const checks: DoctorCheck[] = []
  for (const [code, count] of Object.entries(audit.counts)) {
    if (code === "frontmatter_invalid" || count === 0) continue
    const issues = audit.issues.filter((issue) => issue.code === code)
    checks.push({
      name: `audit:${code}`,
      level: code === "file_unreadable" ? "fail" : "warn",
      detail: `${issues.length} issue${issues.length === 1 ? "" : "s"}: ${issues.map((issue) => `${issue.path} -> ${issue.detail}`).join("; ")}`,
    })
  }
  return checks
}

export async function runDoctor(deps: DoctorDeps, ctx: MemoryCommandContext, args = ""): Promise<string> {
  const canFix = deps.reflectionLockFix !== undefined
  const allowed = canFix ? ["json", "fix", "dry-run"] : ["json"]
  const parsed = parseCommandArgs(args, { booleans: allowed })
  for (const flag of parsed.flags.keys()) {
    if (!allowed.includes(flag)) return respond(ctx, `unknown flag --${flag}`, "error")
  }
  if (
    parsed.positionals.length > 0 ||
    [...parsed.flags.values()].some((value) => value !== true) ||
    (parsed.flags.has("dry-run") && !parsed.flags.has("fix"))
  ) {
    return respond(ctx, canFix ? "usage: /doctor [--json] [--fix [--dry-run]]" : "usage: /doctor [--json]", "error")
  }
  const identity = requireIdentity(deps, ctx)
  if (typeof identity === "string") return respond(ctx, identity, "error")
  const sessionId = sessionIdOf(ctx)
  const fixLines =
    parsed.flags.has("fix") && sessionId !== undefined && deps.reflectionLockFix !== undefined
      ? await deps.reflectionLockFix(sessionId, { dryRun: parsed.flags.has("dry-run") })
      : []

  const repoDir = identity.identityPaths.repo
  const repository = checkRepository(identity)
  const checks: DoctorCheck[] = [repository]
  const extra: string[] = fixLines.map((line) => `[fix] ${line}`)
  let audit: MemoryAuditReport | null = null
  let skills = { scanned: 0, repaired: 0 }
  let receipts: ReceiptSummaries | null = null
  let quarantinedRuns: readonly QuarantinedRun[] = []
  let runtimeSize: RuntimeSizeReport | null = null

  if (repository.level === "ok") {
    const settings = deps.doctorSettings(identity)
    const warnTokens = settings.warnTokens
    const now = deps.now?.() ?? Date.now()
    const systemTokens = await estimateSystemTokens(repoDir)
    audit = await auditMemoryRepo(repoDir, { systemTokens, budgetTokens: warnTokens })
    const receiptCheck = await checkReceipts(identity.identityPaths.runtime, now)
    const quarantine = await checkQuarantinedRuns(identity.identityPaths.reflection)
    receipts = receiptCheck.receipts
    quarantinedRuns = quarantine.runs
    const runtimeSettings = deps.runtimeSize?.(identity)
    const runtime =
      runtimeSettings === undefined
        ? undefined
        : await checkRuntimeSize(identity.identityPaths, {
            maxBytes: runtimeSettings.maxBytes,
            policy: runtimeSettings.policy,
            now,
            reflectionEnabled: runtimeSettings.reflectionEnabled,
            discardUnreflectedJournals: runtimeSettings.policy.discardUnreflectedJournals ?? false,
            measureBudgetMs: runtimeSettings.policy.passBudgetMs ?? 60_000,
          })
    runtimeSize = runtime?.report ?? null
    checks.push(
      ...(await checkFrontmatter(repoDir, audit)),
      await checkSoulSeed(repoDir),
      await checkLocks(deps, identity.identityPaths.locks),
      await checkWorktrees(deps, identity),
      await checkAbandonedRuns(identity.identityPaths.reflection),
      quarantine.check,
      receiptCheck.check,
      await checkGhostReservation(identity.identityPaths, deps),
      await deps.reflectionHealth(identity, now),
      await checkTokens(repoDir, warnTokens, systemTokens),
      ...(runtime === undefined ? [] : [runtime.check]),
    )
    const projection = await checkProjection(repoDir, identity.identity, settings.projectionLimits)
    if (projection !== undefined) checks.push(projection)
    checks.push(...auditChecks(audit))

    const facts = await checkFacts(deps, identity.identityPaths)
    if (facts !== undefined) checks.push(facts)

    if (deps.skillRepair === false) {
      extra.push("[info] skills: frontmatter repair is not run by this host's /doctor (read-only)")
      return report(ctx, parsed.flags.has("json"), {
        identity,
        checks,
        extra,
        audit,
        skills,
        receipts,
        quarantinedRuns,
        runtimeSize: deps.runtimeSize === undefined ? undefined : runtimeSize,
      })
    }
    const repaired = await repairMissingSkillNameFrontmatter(repoDir)
    skills = { scanned: repaired.scanned, repaired: repaired.repaired.length }
    const repairReport = formatSkillNameFrontmatterRepairReport(repaired)
    extra.push(
      `[info] skills: scanned ${repaired.scanned} skill file${repaired.scanned === 1 ? "" : "s"}`,
      ...repairReport
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `[info] skills: ${line}`),
    )
  }

  return report(ctx, parsed.flags.has("json"), {
    identity,
    checks,
    extra,
    audit,
    skills,
    receipts,
    quarantinedRuns,
    runtimeSize: deps.runtimeSize === undefined ? undefined : runtimeSize,
  })
}

interface DoctorReport {
  readonly identity: MemoryCommandIdentity
  readonly checks: readonly DoctorCheck[]
  readonly extra: readonly string[]
  readonly audit: MemoryAuditReport | null
  readonly skills: { readonly scanned: number; readonly repaired: number }
  readonly receipts: ReceiptSummaries | null
  readonly quarantinedRuns: readonly QuarantinedRun[]
  /** Present (null before a repository exists) only when the host reports the runtime size. */
  readonly runtimeSize: RuntimeSizeReport | null | undefined
}

function report(ctx: MemoryCommandContext, json: boolean, input: DoctorReport): string {
  const { identity, checks, extra, audit, skills, receipts, quarantinedRuns, runtimeSize } = input
  const level = worstLevel(checks)
  const notifyLevel = level === "fail" ? "error" : level === "warn" ? "warning" : "info"
  if (json) {
    return respond(
      ctx,
      JSON.stringify(
        redactReportStrings({
          identity: identity.identity,
          level,
          checks,
          audit,
          skills,
          receipts,
          quarantinedRuns,
          ...(runtimeSize === undefined ? {} : { runtimeSize }),
        }),
        null,
        2,
      ),
      notifyLevel,
    )
  }
  const lines = [
    `# Memory doctor: ${identity.identity}`,
    "",
    ...checks.map((check) => `[${check.level}] ${check.name}: ${check.detail}`),
    ...extra,
  ]
  if (level === "fail") lines.push("", "fix the failing checks above, then re-run /doctor")
  else if (level === "warn") lines.push("", "warnings do not block memory; re-run /doctor after addressing them")

  return respond(ctx, redactSecretLikeMaterial(lines.join("\n")), notifyLevel)
}
