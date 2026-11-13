// The resident Kibitzer child over the shared memory child port (`../memory-child-port.ts`): a durable
// child journal under the identity's `runtime/recall/sidecars/<encoded-session>/`, `stage` with the
// hidden `kibitzer` agent, deny-all-but-five session permissions and the model `resolveModel` picked
// inside the recall category (`./model.ts`), the first input through `begin`,
// later input through `promptContinuation` (queued for a follow-up, steered into a running turn),
// settlement through `wait`, the cancel through `interrupt`, and unload through `close`. Nothing here
// calls `session.prompt` directly and no native-task guard custody is involved.

import { Model } from "@opencode/plugin"
import { createMemoryChildPort, type IssuedMemoryChild, type MemoryChildPortDeps } from "../memory-child-port"
import { retryableReflectionModelFailure } from "../reflection-model-retry"
import type { KibitzerChildModel, KibitzerChildPort } from "./contract"
import { pickKibitzerModel, type KibitzerModelResolution } from "./model"

export { turnReport } from "../memory-child-port"

const KIBITZER_BACKEND_ID = "omo-kibitzer-opencode"
export const KIBITZER_JOURNAL_FILENAME = "children.sqlite"

export type IssuedKibitzerChild = IssuedMemoryChild

export type KibitzerChildPortDeps = Omit<MemoryChildPortDeps, "backendID" | "prefix" | "label"> & {
  readonly resolveModel: () => Promise<KibitzerModelResolution>
}

function stageModel(choice: KibitzerChildModel) {
  return {
    ...Model.Ref.parse(choice.model),
    ...(choice.variant === undefined
      ? {}
      : { variant: choice.variant as NonNullable<ReturnType<typeof Model.Ref.parse>["variant"]> }),
  }
}

export function createKibitzerChildPort(deps: KibitzerChildPortDeps): KibitzerChildPort {
  const { resolveModel, ...portDeps } = deps
  const port = createMemoryChildPort({
    ...portDeps,
    backendID: KIBITZER_BACKEND_ID,
    prefix: "kibitzer",
    label: "Kibitzer",
  })
  const retired = new Set<string>()
  return {
    resolveModel: async () => pickKibitzerModel(await resolveModel(), retired),
    async start(input) {
      const choice = input.model
      if (choice === undefined) throw new Error("Kibitzer child refused: no recall category model was resolved")
      const child = await port.start({ generation: input.generation, prompt: input.prompt, model: stageModel(choice) })
      return {
        ...child,
        async waitForIdle() {
          const report = await child.waitForIdle()
          if (report.status === "error" && retryableReflectionModelFailure(report.error ?? report.message ?? ""))
            retired.add(choice.model)
          return report
        },
      }
    },
    close: () => port.close(),
  }
}
