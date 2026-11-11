// Reclaims hidden facts children a dead host left behind. Every facts launch stages its child under a
// fresh custody key in `<identity facts>/children.sqlite`; before stranded runs are settled, the open
// rows of the facts backend are taken over and closed by the shared memory child reclaim
// (`memory-child-reclaim.ts`: dead-owner takeover, generation raised to the stored floor, bounded retry
// memo in `children-reclaim.json`). A live (or unverifiable) owner's row is left alone.

import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"
import { reclaimStrandedMemoryChildren, type MemoryChildReclaimInput, type MemoryChildReclaimReport } from "./memory-child-reclaim"

export const FACTS_BACKEND_ID = "omo-facts-opencode"

export function reclaimStrandedFactsChildren(input: MemoryChildReclaimInput): Promise<MemoryChildReclaimReport> {
  return reclaimStrandedMemoryChildren(input, { backendID: FACTS_BACKEND_ID, toolNames: [FACTS_RECORD_TOOL_NAME], label: "facts" })
}
