import { findContinuableWork, type ContinuableWork } from "@oh-my-opencode/boulder-state"
import { resolveHomeDir } from "@oh-my-opencode/omo-config-core"

import { resolveAgentSessionsDirectory } from "../agent-home/resolve-agent-home"

export type { ContinuableWork }

export function findContinuableBoulderWork(cwd: string, sessionId: string): ContinuableWork | null {
  // The record is read here anyway, so this is where a work abandoned by a dead session gets
  // repaired: a session that never completed its work leaves it `active` forever otherwise (#8413).
  return findContinuableWork(cwd, `senpi:${sessionId}`, {
    reconcile: {
      sessionsDirectory: resolveAgentSessionsDirectory({ env: process.env, homeDir: resolveHomeDir(process.env) }),
    },
  })
}
