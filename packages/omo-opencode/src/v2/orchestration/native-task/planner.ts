import { createTaskChildPlanner } from "@oh-my-opencode/senpi-task/task-planner"
import type { ChildPlanner, ResolvedChildPlan } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { AgentDefinition } from "@oh-my-opencode/senpi-task"
import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { CatalogModel } from "../../host/model-catalog"

/** Existing synchronous Native selector over an actual, atomically refreshed host catalog. */
export function createOwnedTaskPlanner(options: {
  catalog: { list(): Promise<readonly CatalogModel[]> }
  config(): OmoConfig | Promise<OmoConfig>
  agents: Readonly<Record<string, AgentDefinition>>
}) {
  let models: readonly CatalogModel[] = [],
    config: OmoConfig | undefined,
    selected: ChildPlanner | undefined,
    fingerprint: string | undefined
  const registry = {
    getAvailable: () => models.map((model) => ({ provider: model.providerID, id: model.id, name: model.name })),
    find: (provider: string, id: string) =>
      registry.getAvailable().find((model) => model.provider === provider && model.id === id),
  }
  async function prepare() {
    const [catalog, next] = await Promise.all([options.catalog.list(), options.config()])
    const eligible = catalog.filter(
      (model) =>
        model.type === "chat" &&
        model.availability.enabled &&
        model.availability.providerListed &&
        model.availability.providerActivation !== "disabled",
    )
    const signature = JSON.stringify(next)
    models = Object.freeze([...eligible])
    config = next
    if (!selected || signature !== fingerprint) {
      selected = createTaskChildPlanner(next, options.agents, () => registry)
      fingerprint = signature
    }
  }
  const plan: ChildPlanner = (spec) => {
    if (!selected || !config)
      return {
        kind: "error",
        error: { code: "model_unavailable", message: "Actual host task catalog has not been prepared" },
      }
    return selected(spec)
  }
  function binding(plan: Pick<ResolvedChildPlan, "resolved_model" | "model" | "variant">) {
    const provider = plan.resolved_model?.provider ?? plan.model.slice(0, plan.model.indexOf("/"))
    const id = plan.resolved_model?.model_id ?? plan.model.slice(plan.model.indexOf("/") + 1)
    const actual = models.find((model) => model.providerID === provider && model.id === id)
    if (!actual) throw new Error("Planned exact model is absent from actual host catalog")
    if (plan.variant !== undefined && !actual.reasoning.variants.includes(plan.variant))
      throw new Error("Native reasoning variant is not declared by this host model")
    return { providerID: provider, id, ...(plan.variant === undefined ? {} : { variant: plan.variant }) }
  }
  return {
    prepare,
    plan,
    binding,
    config: () => {
      if (!config) throw new Error("Native task planner config has not been prepared")
      return config
    },
  }
}
