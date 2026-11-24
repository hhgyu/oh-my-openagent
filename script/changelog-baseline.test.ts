import { describe, expect, test } from "bun:test"
import { type ChangelogBaselineInput, changelogBaselineVerdict } from "./changelog-baseline.ts"
import { CHANGELOG_BASELINE } from "./changelog-gate.config.ts"

const upstreamChangelog = "# Changelog\n\n## [Unreleased]\n\n## [5.1.79] - 2026-11-19\n\n- upstream entry\n"
const baselineChangelog = `# Changelog\n\n${CHANGELOG_BASELINE.marker}\n\n## [Unreleased]\n\n## [v2 baseline] - 2026-11-25\n\n- fork entry\n`

const baselinePr: ChangelogBaselineInput = {
  labels: [CHANGELOG_BASELINE.label],
  addedFiles: [],
  modifiedFiles: ["CHANGELOG.md", "changes.md", "packages/omo-senpi/changes.md"],
  deletedFiles: ["changes/unreleased/1.md", "changes/unreleased/14284.md"],
  baseChangelog: upstreamChangelog,
  headChangelog: baselineChangelog,
}

describe("changelog baseline exemption", () => {
  describe("#given a PR without the baseline label", () => {
    test("#when judged #then the shared rules decide", () => {
      expect(changelogBaselineVerdict({ ...baselinePr, labels: ["upstream-sync"] })).toBeNull()
    })
  })

  describe("#given a labelled PR that only rebases the changelog", () => {
    test("#when the base has no marker #then it passes and counts the consumed fragments", () => {
      const verdict = changelogBaselineVerdict(baselinePr)
      expect(verdict?.pass).toBe(true)
      expect(verdict?.reason).toContain("2 fragment(s)")
    })

    test("#when the label carries surrounding whitespace #then it still applies", () => {
      expect(changelogBaselineVerdict({ ...baselinePr, labels: [` ${CHANGELOG_BASELINE.label} `] })?.pass).toBe(true)
    })
  })

  describe("#given a labelled PR the exemption must refuse", () => {
    const refusals: readonly [string, Partial<ChangelogBaselineInput>, string][] = [
      ["the base already carries the marker", { baseChangelog: baselineChangelog }, "already carries"],
      ["the base has no changelog", { baseChangelog: null }, "no CHANGELOG.md"],
      ["a file is added", { addedFiles: ["changes/unreleased/200.md"] }, "adds no file"],
      ["CHANGELOG.md is untouched", { modifiedFiles: ["changes.md"] }, "must replace CHANGELOG.md"],
      [
        "a source file changes",
        { modifiedFiles: ["CHANGELOG.md", "script/check-pr-changelog.ts"] },
        "script/check-pr-changelog.ts",
      ],
      [
        "a nested changes.md outside packages/<name>",
        { modifiedFiles: ["CHANGELOG.md", "packages/a/b/changes.md"] },
        "packages/a/b/changes.md",
      ],
      ["a non-fragment file is deleted", { deletedFiles: ["README.ru.md"] }, "README.ru.md"],
      [
        "a non-numeric fragment is deleted",
        { deletedFiles: ["changes/unreleased/README.md"] },
        "changes/unreleased/README.md",
      ],
      ["the new changelog lacks the marker", { headChangelog: upstreamChangelog }, "must carry the line"],
      [
        "the marker is only quoted inside a line",
        { headChangelog: `# Changelog\nsee ${CHANGELOG_BASELINE.marker} here\n## [Unreleased]\n` },
        "must carry the line",
      ],
      ["the changelog is deleted", { headChangelog: null }, "must carry the line"],
      [
        "the new changelog drops Unreleased",
        { headChangelog: `# Changelog\n${CHANGELOG_BASELINE.marker}\n` },
        "## [Unreleased]",
      ],
    ]
    for (const [name, change, reason] of refusals) {
      test(`#when ${name} #then it fails naming the cause`, () => {
        const verdict = changelogBaselineVerdict({ ...baselinePr, ...change })
        expect(verdict?.pass).toBe(false)
        expect(verdict?.reason).toContain(reason)
      })
    }
  })
})
