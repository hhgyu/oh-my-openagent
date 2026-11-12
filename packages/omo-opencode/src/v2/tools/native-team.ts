import type { Info, ToolContext, ToolDomain } from "@opencode/plugin/promise/tool"
import type { Registration } from "@opencode/plugin/promise/registration"
import {
  buildLeadTeamTools, runTeamCreate, runTeamDelete, runTeamTaskCreate, runTeamTaskGet, runTeamTaskList, runTeamTaskUpdate,
  type TeamToolsService,
} from "@oh-my-opencode/senpi-task/team-operations"
import { Compile } from "typebox/compile"
import { createToolArgumentValidator } from "@oh-my-opencode/senpi-task/task-operations"
import type { createToolKernel } from "../host/tool-kernel"
import type { ListedTool, ToolRegistry } from "../host/tool-registry"
import { bindToolValueCodec, type ToolCodecAssociation } from "../host/tool-value-codec"
import type { NativeTaskTargetPermissionAssociation, createNativeTaskService } from "../orchestration/native-task/service"
import { NATIVE_TEAM_TOOL_NAMES, issueNativeTeamCodec, nativeTeamInputSchemas, type NativeTeamToolName } from "./native-team-codecs"
import { strictPublicInput, type NativeTaskOperationCall } from "./native-task"
import { adaptNativeTaskResult } from "./native-task-result"

const canonicalTargets = new WeakMap<ListedTool, { readonly id: string; readonly name: string; readonly execute: ListedTool["execute"] }>()
/** Read-only origin check. Only this bridge's original target construction registers origins. */
export function assertCanonicalNativeTeamTarget(target: ListedTool): void {
  const original = canonicalTargets.get(target)
  if (!original || !Object.isFrozen(target) || original.id !== target.id || original.name !== target.name || original.execute !== target.execute) throw Error("Noncanonical Native team permission target")
}

type Service = ReturnType<typeof createNativeTaskService>
type ToolResult = Parameters<typeof adaptNativeTaskResult>[0]

export interface NativeTeamTargets {
  readonly tools: readonly ListedTool[]
  readonly codecs: readonly ToolCodecAssociation[]
}

/** Trusted component assembly ONLY: the SAME registry, kernel and Native task service that own the
 * task targets. Each lead team call runs inside that service's per-call operation. */
export interface NativeTeamBridgeOwner {
  readonly registry: ToolRegistry
  readonly kernel: ReturnType<typeof createToolKernel>
  readonly service: Service
  readonly targetPermissions: readonly NativeTaskTargetPermissionAssociation[]
  /** Inside THIS call's operation: refuse a non-lead caller, then build the team service over this
   * call's manager. Never retained past the call. */
  teamService(caller: ToolContext, call: NativeTaskOperationCall): TeamToolsService
  /** Must retain failed cleanup for retry; successful repeat release is harmless. */
  release(): Promise<void>
}

export interface NativeTeamBridgeOptions {
  readonly tool: ToolDomain
  acquire(targets: NativeTeamTargets, signal: AbortSignal): Promise<NativeTeamBridgeOwner>
  /** Join/rollback anything acquired before acquire rejected. */
  rollbackAcquisition(): Promise<void>
}

const validators = {
  team_create: Compile(nativeTeamInputSchemas.team_create), team_delete: Compile(nativeTeamInputSchemas.team_delete),
  task_create: Compile(nativeTeamInputSchemas.task_create), task_get: Compile(nativeTeamInputSchemas.task_get),
  task_list: Compile(nativeTeamInputSchemas.task_list), task_update: Compile(nativeTeamInputSchemas.task_update),
}

function checked<T>(validator: { Check(value: unknown): value is T }, input: unknown): T {
  if (!validator.Check(input)) throw Error("Invalid Native team tool input")
  return input
}

/** The ORIGINAL Native lead tool operation for `name`, over the per-call team service. */
function runLeadTeamTool(name: NativeTeamToolName, service: TeamToolsService, input: unknown): Promise<ToolResult> {
  switch (name) {
    case "team_create": return runTeamCreate(service, checked(validators.team_create, input))
    case "team_delete": return runTeamDelete(service, checked(validators.team_delete, input))
    case "task_create": return runTeamTaskCreate(service, checked(validators.task_create, input))
    case "task_get": return runTeamTaskGet(service, checked(validators.task_get, input))
    case "task_list": return runTeamTaskList(service, checked(validators.task_list, input))
    case "task_update": return runTeamTaskUpdate(service, checked(validators.task_update, input))
  }
}

const refuse = (): Promise<never> => Promise.reject(Error("Description template team service is never invoked"))
/** Reads only the ORIGINAL descriptions of `buildLeadTeamTools`; this template's service is never invoked. */
const TEMPLATE: TeamToolsService = { createTeam: refuse, deleteTeam: refuse, sendMessage: refuse, status: refuse, listTeams: refuse, createTask: refuse,
  listTasks: refuse, updateTask: refuse, getTask: refuse, requestShutdown: refuse, approveShutdown: refuse, rejectShutdown: refuse }
const DESCRIPTIONS: ReadonlyMap<string, string> = new Map(buildLeadTeamTools({ service: TEMPLATE }).map(tool => [tool.name, tool.description]))
function description(name: NativeTeamToolName): string {
  const value = DESCRIPTIONS.get(name)
  if (value === undefined) throw Error(`Native lead team tool ${name} is absent from buildLeadTeamTools`)
  return value
}

/** Creates an owned, UNREGISTERED lead team component over the shared Native task owner. The root
 * must own it before awaiting ready, and must close it even after rejected setup. */
export function createNativeTeamBridge(options: NativeTeamBridgeOptions) {
  const stop = new AbortController(), callbacks = new Set<Promise<void>>(), setups = new Set<Promise<void>>()
  const registrations: Registration[] = []
  const inputValidators = new Map<string, (value: unknown) => unknown>()
  let closing = false, closed = false, owner: NativeTeamBridgeOwner | undefined, closeAttempt: Promise<void> | undefined
  const current = () => { if (closing) throw Error("Native team bridge is closing"); stop.signal.throwIfAborted() }
  function ticket(set: Set<Promise<void>>) {
    let finish!: () => void
    const work = new Promise<void>(resolve => { finish = resolve })
    set.add(work)
    return () => { set.delete(work); finish() }
  }
  async function publicCall(name: NativeTeamToolName, input: unknown, caller: ToolContext) {
    current()
    const finish = ticket(callbacks), prepared = ticket(setups)
    try {
      const resources = owner
      if (!resources) throw Error("Native team bridge has no acquired owner")
      const lease = await resources.service.parent(caller)
      current(); caller.signal.throwIfAborted()
      const bound = resources.kernel.bind(caller, lease)
      prepared()
      try { return await bound.invoke(name, input) }
      finally { bound.dispose() }
    } finally { prepared(); finish() }
  }
  const targets = NATIVE_TEAM_TOOL_NAMES.map((name): ListedTool => Object.freeze({
    id: `omo.native.${name}`, name,
    description: description(name),
    input: nativeTeamInputSchemas[name] as unknown as Info["input"],
    async execute(input, caller) {
      current()
      const resources = owner
      if (!resources) throw Error("Native team bridge has no acquired owner")
      const call = await resources.service.forCall(caller)
      // Every member start, cancel and destruction of this call runs under THIS call's authority.
      return call.operation(async (manager, resolveAncestry, signal, operation) => {
        const service = resources.teamService(caller, { manager, resolveAncestry, signal, operation })
        signal.throwIfAborted(); current()
        return adaptNativeTaskResult(await runLeadTeamTool(name, service, input))
      })
    },
  }))
  const codecs = targets.map((target, index) => {
    const name = NATIVE_TEAM_TOOL_NAMES[index]
    if (name === undefined || target.name !== name) throw Error("Native team target order differs")
    return issueNativeTeamCodec(target, name)
  })
  const definitions = Object.freeze({ tools: Object.freeze(targets), codecs: Object.freeze(codecs) }) satisfies NativeTeamTargets
  for (const target of targets) canonicalTargets.set(target, { id: target.id, name: target.name, execute: target.execute })
  const publicDefinitions = NATIVE_TEAM_TOOL_NAMES.map((name): Info => Object.freeze({
    name, description: description(name), input: strictPublicInput(nativeTeamInputSchemas[name]),
    execute: (input, caller) => publicCall(name, input, caller),
  }))

  const acquired = Promise.resolve().then(() => options.acquire(definitions, stop.signal)).then(value => { owner = value; return value })
  const ready = (async () => {
    const resources = await acquired
    current()
    for (const [index, target] of targets.entries()) {
      const entry = resources.registry.get(target.name, resources.registry.generation)
      const associations = resources.targetPermissions.filter(value => value.tool === target)
      if (associations.length !== 1 || entry.nativeTaskPermission?.permission !== associations[0]?.permission) throw Error("Native team permission association differs from canonical target")
      entry.nativeTaskPermission.assertOwner(resources.service)
      const inputCodec = definitions.codecs[index]?.input
      if (!inputCodec) throw Error("Native team canonical target has no input codec")
      const decoder = bindToolValueCodec(inputCodec, target, "input")
      if (entry.tool.execute !== target.execute || entry.inputDecoder !== decoder.decode ||
        JSON.stringify(entry.tool.input) !== JSON.stringify(decoder.schema) || entry.tool.output !== undefined) throw Error("Native team registry does not own exact canonical targets")
    }
    registrations.push(await options.tool.hook("execute.before", event => {
      const validate = inputValidators.get(event.tool)
      if (validate) { current(); validate(event.input) }
    }))
    registrations.push(await options.tool.transform(editor => {
      current()
      // Validate ALL collisions before touching any definition.
      const matches = publicDefinitions.map(tool => editor.list().filter(entry => entry.name === tool.name))
      if (matches.some(entries => entries.length > 1)) throw Error("Ambiguous public Native team tool")
      inputValidators.clear()
      for (const [index, tool] of publicDefinitions.entries()) {
        const previous = matches[index]?.[0]
        if (previous) editor.update(previous.id, entry => {
          entry.name = tool.name; entry.description = tool.description; entry.input = tool.input; entry.execute = tool.execute
          delete entry.output; delete entry.options
        })
        else editor.add(tool)
        const effective = editor.list().filter(entry => entry.name === tool.name), replaced = effective[0]
        if (effective.length !== 1 || !replaced || replaced.input !== tool.input || replaced.description !== tool.description ||
          replaced.output !== undefined || replaced.options !== undefined) throw Error("Public Native team tool replacement failed")
        inputValidators.set(replaced.id, createToolArgumentValidator(nativeTeamInputSchemas[tool.name as NativeTeamToolName]))
      }
    }))
    current()
  })()
  void ready.catch(() => {})

  return Object.freeze({
    ready,
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      if (closeAttempt) return closeAttempt
      closing = true; stop.abort(Error("Native team bridge closed"))
      const work = (async () => {
        await ready.catch(() => {})
        const failures: unknown[] = []
        for (let index = registrations.length - 1; index >= 0; index--) {
          try {
            const registration = registrations[index]
            if (!registration) throw Error("Native team bridge registration is missing")
            await registration.dispose(); registrations.splice(index, 1)
          }
          catch (error) { failures.push(error) }
        }
        await Promise.all([...setups])
        if (owner) {
          try { await owner.service.close() } catch (error) { failures.push(error) }
        } else {
          try { await options.rollbackAcquisition() } catch (error) { failures.push(error) }
        }
        await Promise.all([...callbacks])
        if (!failures.length && owner) {
          try { await owner.release() } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, "Native team bridge cleanup incomplete")
        inputValidators.clear(); closed = true
      })()
      closeAttempt = work
      void work.finally(() => { if (!closed && closeAttempt === work) closeAttempt = undefined }).catch(() => {})
      return work
    },
  })
}
