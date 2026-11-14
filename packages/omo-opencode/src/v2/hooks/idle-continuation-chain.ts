// One settle, at most one continuation, in Native's precedence. On Senpi the goal continuation is queued on
// `agent_end` and a run continued that way never emits `agent_settled` (senpi `core/agent-session.js`
// `_emitAgentSettled`), where omo-senpi's ulw-execute and ulw-loop decide; ulw-loop also skips while boulder work is
// continuable. OpenCode 2 runs every `experimental.idle` hook on the same edge, so the components share ONE hook that
// asks them in that order and stops at the first that admitted a continuation.
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionIdle } from "@opencode/plugin/promise/session"

export const IDLE_CONTINUATION_RANK = { goal: 0, ulwExecute: 1, ulwLoop: 2 } as const

/** Resolves true when it admitted a continuation for this settle. */
export type IdleContinuation = (input: SessionIdle) => Promise<boolean>

export interface IdleHookPort {
  hook(name: "experimental.idle", callback: (input: SessionIdle) => Promise<void>): Promise<Registration>
}

export interface IdleContinuationChain {
  add(rank: number, continuation: IdleContinuation): Registration
  register(session: IdleHookPort): Promise<Registration>
}

export function createIdleContinuationChain(): IdleContinuationChain {
  const entries: { readonly rank: number; readonly continuation: IdleContinuation }[] = []
  return {
    add(rank, continuation) {
      const entry = { rank, continuation }
      entries.push(entry)
      entries.sort((left, right) => left.rank - right.rank)
      return {
        dispose: async () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        },
      }
    },
    register(session) {
      return session.hook("experimental.idle", async (input) => {
        for (const { continuation } of [...entries]) if (await continuation(input)) return
      })
    },
  }
}

export function attachIdleContinuation(
  session: IdleHookPort,
  chain: IdleContinuationChain | undefined,
  rank: number,
  continuation: IdleContinuation,
): Promise<Registration> {
  if (chain) return Promise.resolve(chain.add(rank, continuation))
  return session.hook("experimental.idle", async (input) => {
    await continuation(input)
  })
}
