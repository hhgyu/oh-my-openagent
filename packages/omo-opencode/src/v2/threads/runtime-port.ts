import type {
  AdmitExternalMessageInput,
  ExternalAdmission,
  SessionRuntimePort,
} from "@oh-my-opencode/thread-core/gateway/adapter"
import type { ThreadV2Host, V2SessionSnapshot } from "./host"
import { THREAD_DELIVERY_METADATA_KEY, deliveryMetadata, threadDeliveryInputId } from "./delivery-metadata"

export type V2SessionRuntime = SessionRuntimePort & {
  /** Reads the session's phase and epoch before a drain pass; the port's synchronous reads answer from it. */
  readonly refresh: () => Promise<void>
}

/**
 * The receiver half of one OpenCode session. Admission is `session.synthetic` with a deterministic id
 * (steer -> `delivery: "steer"`, follow-up -> `delivery: "queue"`, `resume: true` so an idle session starts a turn).
 * The gateway row is the journaled intent; the host's synthetic row is the ACK, so a re-post after a crash names the
 * same id and the host answers with the row it already holds instead of a second message.
 */
export function createV2SessionRuntime(input: {
  readonly sessionID: string
  readonly session: Pick<ThreadV2Host["session"], "synthetic">
  readonly snapshot: () => Promise<V2SessionSnapshot>
  readonly hopOf: (deliveryId: string) => Promise<number>
}): V2SessionRuntime {
  let current: V2SessionSnapshot = { phase: "idle", epoch: 0 }
  const emitted = new Set<string>()

  async function admitExternalMessage(message: AdmitExternalMessageInput): Promise<ExternalAdmission> {
    if (emitted.has(message.delivery_id)) return { kind: "already_admitted", turn_epoch: current.epoch }
    const before = current
    if (
      message.deliverAs === "steer" &&
      message.expected_turn_id !== undefined &&
      (before.phase !== "mid_turn" || before.epoch !== message.expected_turn_id)
    )
      return { kind: "turn_conflict", turn_epoch: before.epoch }
    const id = threadDeliveryInputId(message.delivery_id)
    const hop = await input.hopOf(message.delivery_id)
    const posted = await input.session.synthetic({
      sessionID: input.sessionID,
      id,
      text: message.text,
      ...(message.display_text === undefined ? {} : { description: message.display_text.split("\n")[0] }),
      delivery: message.deliverAs === "steer" ? "steer" : "queue",
      resume: true,
      metadata: { [THREAD_DELIVERY_METADATA_KEY]: deliveryMetadata(message, hop) },
    })
    if (posted.id !== id || posted.sessionID !== input.sessionID || posted.type !== "synthetic")
      throw Error(`Foreign thread delivery ACK for ${message.delivery_id}`)
    emitted.add(message.delivery_id)
    if (before.phase === "idle") return { kind: "started", turn_epoch: before.epoch }
    return { kind: message.deliverAs === "steer" ? "steered" : "queued", turn_epoch: before.epoch }
  }

  return {
    refresh: async () => {
      current = await input.snapshot()
    },
    phase: () => current.phase,
    admissionGate: () => ({ can_admit: true, editor_revision: 0, turn_epoch: current.epoch }),
    admitExternalMessage,
    listAdmittedDeliveries: () => ({ pending: [], emitted: [...emitted] }),
  }
}
