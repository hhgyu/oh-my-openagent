/** The per-repo changelog-gate config: the only file that differs between repos. */
export const GATE_CONFIG = {
  releaseBranchPattern: /^release\//,
  // No releaseActors list: check-pr-changelog.ts identifies the release-state PR by publish.yml's marker on a
  // release branch in this repository, never by who opened it (#11704).
  // Unused here: check-pr-changelog.ts passes the shipped-surface classifier (changelog-shipping-policy.mjs) as
  // isUserFacing, which replaces the root rule for every verdict (#10841).
  userFacingRoots: [],
  // Exactly what publish.yml's release commit stages besides CHANGELOG.md and the fragments.
  releaseArtifacts: [
    /^package\.json$/,
    /^bun\.lock$/,
    /^packages\/[^/]+\/package\.json$/,
    /^packages\/omo-senpi\/plugin\/package\.json$/,
    // publish.yml force-adds the whole directory (git add -f packages/omo-senpi/plugin/extensions).
    /^packages\/omo-senpi\/plugin\/extensions\//,
    /^packages\/omo-senpi\/plugin\/runtime\//,
    /^packages\/omo-codex\/plugin\/(?:package\.json|package-lock\.json|\.codex-plugin\/plugin\.json)$/,
    /^packages\/omo-codex\/plugin\/components\/[^/]+\/(?:package\.json|hooks\/hooks\.json)$/,
    /^packages\/omo-codex\/plugin\/hooks\/[^/]+\.json$/,
    /^packages\/omo-codex\/scripts\/install-dist\/install-local\.mjs$/,
    // stamp-release-changelog.ts writes the fragments' log blocks into their logs in the release commit.
    /^packages\/[^/]+\/changes\.md$/,
  ],
} as const

/** The upstream this fork merges. A PR labelled `label` that merges new upstream commits may carry upstream's own
 * changelog and log edits, but only byte-for-byte as upstream wrote them (check-pr-changelog.ts). */
export const UPSTREAM_SYNC = {
  label: "upstream-sync",
  url: "https://github.com/code-yeongyu/oh-my-openagent",
  branch: "dev",
  ref: "refs/changelog-gate/upstream",
} as const
