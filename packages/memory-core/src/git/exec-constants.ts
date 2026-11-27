// A timed-out git first gets SIGTERM, on which it removes its own lock and temp files; SIGKILL
// follows only if it is still running after this grace. Killing outright stranded a HEAD.lock
// when a slow `git commit` was killed right after updating HEAD (omo #10199 field incident).
export const GIT_KILL_GRACE_MS = 10_000

// A hook's background child can inherit git's stdout/stderr and hold them open long after git has
// exited, so `close` may never come while it lives. Git's own output is written before it exits;
// this bounded drain only catches the last buffered chunks (omo #10199 review LOW 1).
export const GIT_EXIT_DRAIN_MS = 2_000

export function describeStdinError(error: NodeJS.ErrnoException | undefined): string {
  return error === undefined ? "" : `\nomo: git stdin was not fully delivered (${error.code ?? error.message})\n`
}
