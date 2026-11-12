import { createDagSkillMaterializer, DagManagerError, type DagFileStore, type DagMaterializeSkills, type DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"
import type { DagToolInput } from "@oh-my-opencode/senpi-task/dag-operations"
import type { SkillLoader } from "@oh-my-opencode/senpi-task/task-operations"
import { NativeDagRefusal } from "./refusals"
import type { NativeDagCall } from "./runtime"

/** ONE workflow call's skill authority: authorizes `names` for the call's genuine caller (the S2
 * per-call `skill` permission decisions over a fresh host listing), then returns Native's DAG skill
 * materializer over the loader that serves exactly those names. A denial rejects unchanged. */
export type NativeDagSkillAuthority = (names: readonly string[]) => Promise<DagMaterializeSkills>

interface NativeDagSkillAuthorityInput {
  /** S2 `authorizeSkills` bound to this call's caller and signal. */
  authorize(names: readonly string[]): Promise<SkillLoader>
  readonly store: DagFileStore
  /** The prepared location: the loader refuses any other. Native pins it in the run's skill manifest. */
  readonly cwd: string
}

export function nativeDagSkillAuthority(input: NativeDagSkillAuthorityInput): NativeDagSkillAuthority {
  return async names => createDagSkillMaterializer({ store: input.store, cwd: input.cwd, loadSkills: await input.authorize(names) })
}

/** Native's materialization when a call holds no skill authority: a node without skills keeps its
 * submitted prompt (Native `buildSkillPrepend` with nothing to prepend, like `node-retry.ts`'s
 * identity materializer); a node that names skills is refused, never dispatched without them. */
export const callBoundSkillMaterializer: DagMaterializeSkills = ({ definition }) => {
  const skilled = definition.nodes.filter(node => (node.load_skills?.length ?? 0) > 0).map(node => node.id)
  if (skilled.length > 0) {
    throw new NativeDagRefusal("invalid_definition", `Node(s) ${skilled.map(id => `"${id}"`).join(", ")} name skills in load_skills, but this workflow call holds no skill authorization; run it from a workflow start, amend or retry call.`, skilled)
  }
  return { nodes: definition.nodes.map(node => ({ nodeId: node.id, effectivePrompt: node.prompt })) }
}

function distinct(lists: readonly (readonly string[] | undefined)[]): string[] {
  const names = new Set<string>()
  for (const list of lists) for (const name of list ?? []) names.add(name)
  return [...names]
}

/** The skill names this call may materialize, first appearance first, or undefined when it
 * materializes nothing. Native materializes at `start` (every node), at `amend` (changed and added
 * nodes; every named skill of the submitted definition is authorized) and at a `retry` with a
 * prompt override (the amend path for the named node). A plain retry, a reuse, recovery and every
 * other verb dispatch the effective prompt the run record already holds. */
function requestedDagSkillNames(params: DagToolInput, record: (runId: string) => DagRunRecordV1 | undefined): readonly string[] | undefined {
  if (params.action === "start" || params.action === "amend") return params.definition ? distinct(params.definition.nodes.map(node => node.load_skills)) : undefined
  if (params.action !== "retry" || params.prompt === undefined || params.run_id === undefined) return undefined
  const targets = new Set(params.node_id !== undefined ? [params.node_id] : params.node_ids ?? [])
  const nodes = record(params.run_id.trim())?.definition.nodes ?? []
  return distinct(nodes.filter(node => targets.has(node.id)).map(node => node.load_skills))
}

/** The call with Native's materializer over THIS call's authorized skills, or undefined (decided
 * synchronously) when the verb materializes nothing and the call goes on unchanged without a
 * turn. Authorization runs before any engine work, so a denied skill leaves no run, no amendment
 * and no retry behind. */
export function authorizeCallSkills(call: NativeDagCall, skills: NativeDagSkillAuthority | undefined, params: DagToolInput,
  record: (runId: string) => DagRunRecordV1): Promise<NativeDagCall> | undefined {
  if (skills === undefined) return undefined
  const names = requestedDagSkillNames(params, runId => {
    try { return record(runId) } catch (error) {
      if (error instanceof DagManagerError) return undefined
      throw error
    }
  })
  if (names === undefined) return undefined
  return skills(names).then(materializeSkills => ({ ...call, materializeSkills }))
}
