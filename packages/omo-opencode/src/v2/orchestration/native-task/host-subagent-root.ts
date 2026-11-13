/** A session the host created with a parentID (its own subagent) may own Native tasks as a root
 * only when no OmO runtime owns it or any session between it and its parentless ancestor. OmO
 * children are created with their OmO parent as the host parent, so their owning root is always a
 * host ancestor, and its child journal claims every OmO child before the host session exists. */

const MAX_HOST_SUBAGENT_ANCESTRY = 32

interface HostSubagentRootInput {
  readonly caller: string
  readonly parentID: string
  readonly directory: string
  readonly signal: AbortSignal
  get(
    sessionID: string,
    signal: AbortSignal,
  ): Promise<{
    readonly id: string
    readonly parentID?: string | null
    readonly location: { readonly directory: string }
  }>
  journaledChildren(ancestor: string): ReadonlySet<string>
}

const OWNED_CHILD_WITHOUT_ROOT =
  "Nested caller has no unique owned root manager: this OmO child's root session has no active Native task manager; continue it from its root session"
const HOST_SUBAGENT_UNDER_OWNED =
  "Host subagent under an OmO-owned session cannot own Native tasks; only the OmO child or its root can start them"

function unverifiable(reason: string, cause?: unknown): never {
  throw new Error(`Host subagent ownership cannot be verified: ${reason}`, cause === undefined ? undefined : { cause })
}

async function hostAncestry(input: HostSubagentRootInput): Promise<string[]> {
  const chain = [input.caller]
  let next: string | undefined = input.parentID
  while (next !== undefined) {
    if (chain.includes(next)) unverifiable("host ancestry has a cycle")
    if (chain.length > MAX_HOST_SUBAGENT_ANCESTRY) unverifiable("host ancestry is too deep")
    let actual: Awaited<ReturnType<HostSubagentRootInput["get"]>>
    try {
      actual = await input.get(next, input.signal)
    } catch (cause) {
      input.signal.throwIfAborted()
      unverifiable(`ancestor ${next} is unavailable`, cause)
    }
    input.signal.throwIfAborted()
    if (actual.id !== next) unverifiable(`ancestor ${next} answered as another session`)
    if (actual.location.directory !== input.directory) unverifiable(`ancestor ${next} lives in another directory`)
    chain.push(next)
    next = actual.parentID ?? undefined
  }
  return chain
}

export async function assertHostSubagentRoot(input: HostSubagentRootInput): Promise<void> {
  const chain = await hostAncestry(input)
  for (const [index, ancestor] of chain.entries()) {
    if (index === 0) continue
    let claimed: ReadonlySet<string>
    try {
      claimed = input.journaledChildren(ancestor)
    } catch (cause) {
      unverifiable(`the child journal of ${ancestor} is unreadable`, cause)
    }
    if (claimed.has(input.caller)) throw new Error(OWNED_CHILD_WITHOUT_ROOT)
    if (chain.slice(1, index).some((between) => claimed.has(between))) throw new Error(HOST_SUBAGENT_UNDER_OWNED)
  }
}
