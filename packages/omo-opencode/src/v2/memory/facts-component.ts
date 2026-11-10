// Composition of the facts extractor inside the memory component: the child hosting, the runtime and
// the persona the hidden `omo-facts` agent runs with. Production hosts the child only on the same
// capable host as the Kibitzer judge (verified OpenCode 2.2.6 with the joined Effect session
// transport) and only when the agent domain can register the hidden agent; a supplied `createPort`
// stands in for that host in tests. A missing persona disables only facts extraction. The persona is
// read here, BEFORE any host transform runs: a throw inside a transform disables the whole plugin.

import { loadFactsPersona } from "@oh-my-opencode/memory-core"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import { createModelCatalog, type CatalogModel } from "../host/model-catalog"
import { describeError, type MemoryBinder } from "./binding"
import type { MemoryLogger } from "./config"
import { createMemoryFacts, type MemoryFacts } from "./facts"
import { createFactsChildHosting, type FactsChildHosting, type FactsPortRequest } from "./facts-child"
import { kibitzerHostCapable } from "./kibitzer"
import type { MemoryChildPort, MemoryChildTimers } from "./memory-child-port"
import type { MemoryHost } from "./index"

/** Facts extractor test seams: the child port, the model catalog, the deadline timers and length. */
export interface MemoryFactsSeams {
  readonly createPort?: (request: FactsPortRequest) => MemoryChildPort
  readonly catalog?: () => Promise<readonly CatalogModel[]>
  readonly timers?: MemoryChildTimers
  readonly deadlineMs?: number
}

interface FactsComponentParts {
  readonly facts: MemoryFacts
  readonly hosting: FactsChildHosting
  /** The persona to register the hidden agent with; absent under a test port. */
  readonly persona?: string
}

export function createFactsComponent(context: MemoryHost, deps: {
  readonly binder: MemoryBinder
  readonly logger: MemoryLogger
  readonly now: () => number
  readonly loadSettings: (cwd: string) => OmoMemorySettings
  readonly seams?: MemoryFactsSeams
}): FactsComponentParts | undefined {
  const seams = deps.seams
  let persona: string | undefined
  if (seams?.createPort === undefined) {
    if (!kibitzerHostCapable(context) || context.agent === undefined) return undefined
    try {
      persona = loadFactsPersona()
    } catch (error) {
      deps.logger.warn("facts extraction disabled: persona asset unavailable", { error: describeError(error) })
      return undefined
    }
  }
  const model = context.model
  const provider = context.provider
  const catalog = seams?.catalog ?? (model === undefined || provider === undefined ? undefined : () => createModelCatalog({ model, provider }).list())
  const hosting = createFactsChildHosting({
    host: context,
    warn: (message, details) => deps.logger.warn(message, details),
    ...(seams?.createPort === undefined ? {} : { createPort: seams.createPort }),
    ...(seams?.timers === undefined ? {} : { timers: seams.timers }),
  })
  const facts = createMemoryFacts({
    binder: deps.binder, session: context.session, logger: deps.logger, now: deps.now, loadSettings: deps.loadSettings, hosting,
    ...(catalog === undefined ? {} : { catalog }),
    ...(seams?.deadlineMs === undefined ? {} : { deadlineMs: seams.deadlineMs }),
  })
  return { facts, hosting, ...(persona === undefined ? {} : { persona }) }
}
