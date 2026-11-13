import { FRAGMENT_DIR } from "./changelog-gate-rules.ts";
import { UPSTREAM_SYNC } from "./changelog-gate.config.ts";

type Git = (args: readonly string[]) => string;

export type UpstreamSyncInput = {
  readonly labels: readonly string[];
  /** The commit the gate judges (in CI the PR merged into the base tip). */
  readonly head: string;
  readonly baseHead: string;
  /** Every path the PR adds, modifies or deletes (git diff --no-renames). */
  readonly changedPaths: readonly string[];
  /** changes/unreleased/<pr>.md: never exempt, the shared rules still require and validate it. */
  readonly ownFragment: string | null;
};

export type UpstreamSyncVerdict = { readonly exempt: readonly string[]; readonly note: string };

const isLogPath = (path: string): boolean =>
  path === "CHANGELOG.md" || path === "changes.md" || path.endsWith("/changes.md") || path.startsWith(`${FRAGMENT_DIR}/`);

/**
 * The upstream-sync exemption, or null when the PR does not carry the label. A labelled PR that merges new upstream
 * commits may carry a changelog or log path only when the path's state at head (mode and blob, or absence) is the
 * state upstream gave it: equal at merge-base(upstream, head), and changed there since the base branch's last sync
 * point, so upstream itself made the change. Any other byte, a fork fragment deleted in the merge included, leaves
 * `exempt` empty and the shared rules give today's verdict.
 */
export function upstreamSyncExemption(git: Git, input: UpstreamSyncInput): UpstreamSyncVerdict | null {
  if (!input.labels.map((label) => label.trim()).includes(UPSTREAM_SYNC.label)) return null;
  const refuse = (note: string): UpstreamSyncVerdict => ({ exempt: [], note });
  try {
    git(["fetch", "--no-tags", "--quiet", UPSTREAM_SYNC.url, `+refs/heads/${UPSTREAM_SYNC.branch}:${UPSTREAM_SYNC.ref}`]);
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return refuse(`could not fetch ${UPSTREAM_SYNC.url} ${UPSTREAM_SYNC.branch}: ${detail}`);
  }
  const upstreamBase = mergeBase(git, UPSTREAM_SYNC.ref, input.head);
  if (upstreamBase === null) return refuse(`the PR shares no history with ${UPSTREAM_SYNC.url} ${UPSTREAM_SYNC.branch}`);
  if (isAncestor(git, upstreamBase, input.baseHead)) return refuse("the PR merges no upstream commit the base branch lacks");
  const merges = git(["rev-list", "--count", "--merges", "--ancestry-path", `${upstreamBase}..${input.head}`]).trim();
  if (merges === "0") return refuse("no merge commit joins upstream into the PR");
  const lastSync = mergeBase(git, input.baseHead, upstreamBase);
  const entry = (rev: string | null, path: string): string | null => {
    if (rev === null) return null;
    const line = git(["ls-tree", "--full-tree", rev, "--", path]).trim();
    return line === "" ? null : line.split("\t")[0] ?? null;
  };
  const logPaths = input.changedPaths.filter((path) => isLogPath(path) && path !== input.ownFragment);
  const foreign = logPaths.filter((path) => {
    const upstream = entry(upstreamBase, path);
    return entry(input.head, path) !== upstream || entry(lastSync, path) === upstream;
  });
  const at = upstreamBase.slice(0, 10);
  if (foreign.length > 0) {
    const shown = foreign.slice(0, 10).join(", ") + (foreign.length > 10 ? ` and ${foreign.length - 10} more` : "");
    return refuse(`not upstream's change at ${at}: ${shown}`);
  }
  return { exempt: logPaths, note: `${logPaths.length} changelog path(s) are upstream's bytes at ${at}` };
}

function mergeBase(git: Git, left: string, right: string): string | null {
  try {
    return git(["merge-base", left, right]).trim() || null;
  } catch {
    return null;
  }
}

function isAncestor(git: Git, ancestor: string, descendant: string): boolean {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}
