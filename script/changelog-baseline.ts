import { FRAGMENT_DIR } from "./changelog-gate-rules.ts"
import { CHANGELOG_BASELINE } from "./changelog-gate.config.ts"

export type ChangelogBaselineInput = {
  readonly labels: readonly string[]
  readonly addedFiles: readonly string[]
  readonly modifiedFiles: readonly string[]
  readonly deletedFiles: readonly string[]
  /** CHANGELOG.md on the base branch head, or null when the base has none. */
  readonly baseChangelog: string | null
  /** CHANGELOG.md at the judged head, or null when the head has none. */
  readonly headChangelog: string | null
}

export type ChangelogBaselineVerdict = { readonly pass: boolean; readonly reason: string }

const NUMERIC_FRAGMENT = new RegExp(`^${FRAGMENT_DIR}/\\d+\\.md$`)
const STAMPED_LOG = /^(?:packages\/[^/]+\/)?changes\.md$/

const hasMarkerLine = (text: string): boolean =>
  text.split(/\r?\n/).some((line) => line.trim() === CHANGELOG_BASELINE.marker)

/**
 * The fork's one-time changelog baseline (D-048), or null when the PR does not carry the label. A labelled PR may
 * only replace CHANGELOG.md, write the stamped changes.md logs and delete numeric fragments, and only while the base branch's CHANGELOG.md lacks the
 * baseline marker; the new CHANGELOG.md must carry the marker, so the exception closes itself once merged.
 */
export function changelogBaselineVerdict(input: ChangelogBaselineInput): ChangelogBaselineVerdict | null {
  if (!input.labels.map((label) => label.trim()).includes(CHANGELOG_BASELINE.label)) return null
  const refuse = (reason: string): ChangelogBaselineVerdict => ({
    pass: false,
    reason: `changelog-baseline: ${reason}`,
  })
  if (input.baseChangelog === null) return refuse("the base branch has no CHANGELOG.md to rebase")
  if (hasMarkerLine(input.baseChangelog)) return refuse("the base CHANGELOG.md already carries the baseline marker")
  if (input.addedFiles.length > 0)
    return refuse(`a baseline PR adds no file: ${input.addedFiles.slice(0, 3).join(", ")}`)
  if (!input.modifiedFiles.includes("CHANGELOG.md")) return refuse("a baseline PR must replace CHANGELOG.md")
  const notLogs = input.modifiedFiles.filter((path) => path !== "CHANGELOG.md" && !STAMPED_LOG.test(path))
  if (notLogs.length > 0) {
    return refuse(`a baseline PR modifies only CHANGELOG.md and the changes.md logs: ${notLogs.slice(0, 3).join(", ")}`)
  }
  const other = input.deletedFiles.filter((path) => !NUMERIC_FRAGMENT.test(path))
  if (other.length > 0) return refuse(`a baseline PR deletes only numeric fragments: ${other.slice(0, 3).join(", ")}`)
  if (input.headChangelog === null || !hasMarkerLine(input.headChangelog)) {
    return refuse(`the new CHANGELOG.md must carry the line ${CHANGELOG_BASELINE.marker}`)
  }
  if (!input.headChangelog.split(/\r?\n/).some((line) => line.trim() === "## [Unreleased]")) {
    return refuse("the new CHANGELOG.md must keep a ## [Unreleased] heading for later fragments")
  }
  return {
    pass: true,
    reason: `changelog-baseline: CHANGELOG.md rebased, ${input.deletedFiles.length} fragment(s) consumed`,
  }
}
