// Host-originated actions: a trusted component acting for a session without a model tool call (the
// restart recovery of left-behind task children, D-037). The tool kernel marks the frozen caller it
// issues for such an action; a grant that asks permission for it then names the action instead of a
// tool call source, since OpenCode 2.2.6's permission source only describes tool calls.

const hostActions = new WeakMap<object, string>()

export function markHostAction(caller: object, reason: string): void {
  if (!reason.trim()) throw new Error("A host action needs a reason")
  hostActions.set(caller, reason)
}

export function hostActionReason(caller: object): string | undefined {
  return hostActions.get(caller)
}
