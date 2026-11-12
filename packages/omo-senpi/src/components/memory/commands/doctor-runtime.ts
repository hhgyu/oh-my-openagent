// /doctor runtime (the `#omo-memory-doctor-runtime` sidecar entry). The checks and the report live in
// memory-core (shared with the OpenCode 2 host); Senpi supplies its settings and its reflection-health
// line, which reads the Senpi worker's completion records.

import { runDoctor as runCoreDoctor } from "@oh-my-opencode/memory-core/doctor"

import { projectionLimits } from "../projection-limits"
import { checkReflectionHealth } from "./doctor-reflection-health"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export async function runDoctor(deps: MemoryCommandDeps, ctx: MemoryCommandContext, args = ""): Promise<string> {
  return runCoreDoctor({
    ...deps,
    doctorSettings: (identity) => {
      const settings = deps.loadSettings().settings
      return { warnTokens: settings.compile_warn_tokens, projectionLimits: projectionLimits(settings, identity.identity) }
    },
    reflectionHealth: (identity, now) => checkReflectionHealth(identity.identityPaths.reflection, { now }),
  }, ctx, args)
}
