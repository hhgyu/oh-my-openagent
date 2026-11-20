import type { GatewayDeliveryResult } from "./types"

export type SameDeviceWake = {
  /** Called with a send's answer; a `queued_offline` answer for a wakeable session becomes a requested wake (5.3). */
  readonly afterSend: (result: GatewayDeliveryResult) => Promise<GatewayDeliveryResult>
}
