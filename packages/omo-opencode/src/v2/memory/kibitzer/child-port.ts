// The resident Kibitzer child over the shared memory child port (`../memory-child-port.ts`): a durable
// child journal under the identity's `runtime/recall/sidecars/<encoded-session>/`, `stage` with the
// hidden `kibitzer` agent and deny-all-but-five session permissions, the first input through `begin`,
// later input through `promptContinuation` (queued for a follow-up, steered into a running turn),
// settlement through `wait`, the cancel through `interrupt`, and unload through `close`. Nothing here
// calls `session.prompt` directly and no native-task guard custody is involved.

import { createMemoryChildPort, type IssuedMemoryChild, type MemoryChildPortDeps } from "../memory-child-port"
import type { KibitzerChildPort } from "./contract"

export { turnReport } from "../memory-child-port"

const KIBITZER_BACKEND_ID = "omo-kibitzer-opencode"
export const KIBITZER_JOURNAL_FILENAME = "children.sqlite"

export type IssuedKibitzerChild = IssuedMemoryChild

export type KibitzerChildPortDeps = Omit<MemoryChildPortDeps, "backendID" | "prefix" | "label">

export function createKibitzerChildPort(deps: KibitzerChildPortDeps): KibitzerChildPort {
  const port = createMemoryChildPort({ ...deps, backendID: KIBITZER_BACKEND_ID, prefix: "kibitzer", label: "Kibitzer" })
  return {
    start: (input) => port.start({ generation: input.generation, prompt: input.prompt }),
    close: () => port.close(),
  }
}
