/**
 * `cause`: the newest delivery whose message the model has taken into its context (a send from this
 * run continues its causal root). A delivery admitted but still waiting in a queue is not a cause yet.
 * `consumed`: the deliveries the model has taken into its context since its last final answer (an
 * assistant message without a tool call). A queued follow-up drained after that answer and before the
 * settle starts a new group: a report without `binding_id` goes to the binding of the message the current
 * answer is for, never to the thread the session started on. Any other person or host-started message after
 * a final answer also starts a new group.
 * `local`: a person's message is in the group. Together with a bound message the answer then has two
 * possible origins, and while the session has another outbound binding a report without `binding_id` is
 * refused rather than sent to the bound thread (`store-relay-ops.ts` `reportBindingDefault`).
 */
export type RunContext = {
  turn: number
  cause: string | undefined
  chainHop: number
  consumed: string[]
  replyTo: string[]
  replySenders: { session_id: string; name?: string; device?: string }[]
  local: boolean
  answered: boolean
}

/** One message entering the model's context: a person's, a host-started one that is no delivery, or a gateway delivery. */
export type RunInput =
  | { readonly kind: "user" }
  | { readonly kind: "engine" }
  /** A delivery message without a string id: after an answer it starts a new group with nobody approved, adding no sender. */
  | { readonly kind: "malformed" }
  /** RPC input is typed input, never a delivery this session received: its id is the client's to choose (#12317). */
  | { readonly kind: "rpc" }
  | {
      readonly kind: "delivery"
      readonly id: string
      readonly chainCount: number
      readonly agentSender?: string
      readonly senderName?: string
      readonly device?: string
    }

export function createRunContext(): RunContext {
  return {
    turn: 0,
    cause: undefined,
    chainHop: 0,
    consumed: [],
    replyTo: [],
    replySenders: [],
    local: false,
    answered: true,
  }
}

/**
 * Decision 0027 section 6 (#13042): the reply allowance belongs to the consumed delivery and lasts for the work that
 * delivery started - the consuming turn and every later turn the engine starts on its own (a reminder, a goal
 * continuation, a monitor wake: a host message that is no delivery). It ends when a new message starts work after
 * a final answer: a person's message or any delivery, whose own sender the new group then holds. A delivery that joins
 * running work adds its sender. The run's deliveries (`consumed`, the implicit target of a report) end with the final
 * answer in every order: an engine-started message that arrives after the answer and before the settle keeps the
 * allowance, not them.
 */
export function noteRunInput(run: RunContext, input: RunInput): void {
  if (input.kind === "malformed") {
    // Like a delivery it ends an answered group (nothing of the earlier group survives) and, unlike a valid one, adds
    // no sender; while work is running it joins it as a valid delivery would, adding nothing and keeping the hop.
    if (run.answered) startGroup(run)
    return
  }
  if (input.kind === "engine") {
    if (run.answered) run.consumed = []
    run.answered = false
    return
  }
  if (run.answered) startGroup(run)
  if (input.kind === "user") {
    run.local = true
    return
  }
  // RPC input is typed input, never a delivery this session received: its id is the client's to choose, so it is no
  // cause, no consumed origin and no reply sender, and a send from its run starts a new causal root (#12317).
  if (input.kind === "rpc") {
    run.local = true
    return
  }
  // Every consumed delivery is the cause of the run's next send, on either transport (decision 0027 section 3); one no row
  // here holds starts a new root there and its hop count continues the chain (K8).
  run.cause = input.id
  run.chainHop = Math.max(run.chainHop, input.chainCount)
  if (!run.consumed.includes(input.id)) run.consumed.push(input.id)
  if (input.agentSender !== undefined && !run.replyTo.includes(input.agentSender)) run.replyTo.push(input.agentSender)
  if (
    input.agentSender !== undefined &&
    !run.replySenders.some(
      (s) => s.session_id === input.agentSender && s.device === input.device && s.name === input.senderName,
    )
  )
    run.replySenders.push({
      session_id: input.agentSender,
      ...(input.senderName === undefined ? {} : { name: input.senderName }),
      ...(input.device === undefined ? {} : { device: input.device }),
    })
}

/** A final answer was given: the next input starts a new group, and nothing of the earlier one survives. */
function startGroup(run: RunContext): void {
  run.cause = undefined
  run.consumed = []
  run.replyTo = []
  run.replySenders = []
  run.chainHop = 0
  run.local = false
  run.answered = false
}

/** An assistant message ended: it is a final answer when it calls no tool. */
export function noteAssistantMessage(run: RunContext, callsTools: boolean): void {
  run.answered = !callsTools
}

/**
 * A settle alone keeps the consumed delivery's senders, hop and cause (#13042): the next input decides whether the work
 * continues. The run's deliveries end with the run: a report without binding_id after it must name its thread.
 */
export function noteRunSettled(run: RunContext): void {
  run.consumed = []
  run.local = false
  run.answered = true
}
