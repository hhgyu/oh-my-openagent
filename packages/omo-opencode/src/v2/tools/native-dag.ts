import type { Info, ToolContext, ToolDomain } from "@opencode/plugin/promise/tool"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { DagToolInput, DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import type { createToolKernel } from "../host/tool-kernel"
import type { ListedTool, ToolRegistry } from "../host/tool-registry"
import { bindToolValueCodec, type ToolCodecAssociation } from "../host/tool-value-codec"
import type {
  NativeTaskTargetPermissionAssociation,
  createNativeTaskService,
} from "../orchestration/native-task/service"
import {
  NATIVE_DAG_DESCRIPTION,
  NATIVE_DAG_TOOL_NAME,
  checkedNativeDagInput,
  issueNativeDagCodec,
  nativeDagInputSchema,
} from "./native-dag-codecs"
import { strictPublicInput, type NativeTaskOperationCall } from "./native-task"
import { adaptNativeTaskResult } from "./native-task-result"

const canonicalTargets = new WeakMap<
  ListedTool,
  { readonly id: string; readonly name: string; readonly execute: ListedTool["execute"] }
>()
/** Read-only origin check. Only this bridge's original target construction registers origins. */
export function assertCanonicalNativeDagTarget(target: ListedTool): void {
  const original = canonicalTargets.get(target)
  if (
    !original ||
    !Object.isFrozen(target) ||
    original.id !== target.id ||
    original.name !== target.name ||
    original.execute !== target.execute
  )
    throw Error("Noncanonical Native workflow permission target")
}

type Service = ReturnType<typeof createNativeTaskService>

export interface NativeDagTargets {
  readonly tools: readonly ListedTool[]
  readonly codecs: readonly ToolCodecAssociation[]
}

/** Trusted component assembly ONLY: the SAME registry, kernel and Native task service that own the
 * task targets. Each `workflow` call runs inside that service's per-call operation. */
export interface NativeDagBridgeOwner {
  readonly registry: ToolRegistry
  readonly kernel: ReturnType<typeof createToolKernel>
  readonly service: Service
  readonly targetPermissions: readonly NativeTaskTargetPermissionAssociation[]
  /** Inside THIS call's operation: refuse a non-root caller, then run the call. Never retained. */
  workflow(caller: ToolContext, call: NativeTaskOperationCall): (input: DagToolInput) => Promise<DagToolResult>
  release(): Promise<void>
}

export interface NativeDagBridgeOptions {
  readonly tool: ToolDomain
  acquire(targets: NativeDagTargets, signal: AbortSignal): Promise<NativeDagBridgeOwner>
  rollbackAcquisition(): Promise<void>
}

/** Creates an owned, UNREGISTERED `workflow` component over the shared Native task owner. The root
 * must own it before awaiting ready, and must close it even after rejected setup. */
export function createNativeDagBridge(options: NativeDagBridgeOptions) {
  const stop = new AbortController(),
    callbacks = new Set<Promise<void>>(),
    setups = new Set<Promise<void>>()
  const registrations: Registration[] = []
  let closing = false,
    closed = false,
    owner: NativeDagBridgeOwner | undefined,
    closeAttempt: Promise<void> | undefined
  const current = () => {
    if (closing) throw Error("Native workflow bridge is closing")
    stop.signal.throwIfAborted()
  }
  function ticket(set: Set<Promise<void>>): () => void {
    const work = Promise.withResolvers<void>()
    set.add(work.promise)
    return () => {
      set.delete(work.promise)
      work.resolve()
    }
  }
  function resources(): NativeDagBridgeOwner {
    if (!owner) throw Error("Native workflow bridge has no acquired owner")
    return owner
  }
  async function publicCall(input: unknown, caller: ToolContext) {
    current()
    const finish = ticket(callbacks),
      prepared = ticket(setups)
    try {
      const acquired = resources()
      const lease = await acquired.service.parent(caller)
      current()
      caller.signal.throwIfAborted()
      const bound = acquired.kernel.bind(caller, lease)
      prepared()
      try {
        return await bound.invoke(NATIVE_DAG_TOOL_NAME, input)
      } finally {
        bound.dispose()
      }
    } finally {
      prepared()
      finish()
    }
  }
  const target: ListedTool = Object.freeze({
    id: `omo.native.${NATIVE_DAG_TOOL_NAME}`,
    name: NATIVE_DAG_TOOL_NAME,
    description: NATIVE_DAG_DESCRIPTION,
    input: nativeDagInputSchema as unknown as Info["input"],
    async execute(input, caller) {
      current()
      const acquired = resources()
      const call = await acquired.service.forCall(caller)
      // Every node start of this call runs under THIS call's authority, and only while it lasts.
      return call.operation(async (manager, resolveAncestry, signal, operation) => {
        const run = acquired.workflow(caller, { manager, resolveAncestry, signal, operation })
        signal.throwIfAborted()
        current()
        return adaptNativeTaskResult(await run(checkedNativeDagInput(input)))
      })
    },
  })
  const definitions = Object.freeze({
    tools: Object.freeze([target]),
    codecs: Object.freeze([issueNativeDagCodec(target)]),
  }) satisfies NativeDagTargets
  canonicalTargets.set(target, { id: target.id, name: target.name, execute: target.execute })
  const publicDefinition: Info = Object.freeze({
    name: NATIVE_DAG_TOOL_NAME,
    description: NATIVE_DAG_DESCRIPTION,
    input: strictPublicInput(nativeDagInputSchema),
    execute: (input, caller) => publicCall(input, caller),
  })

  const acquired = Promise.resolve()
    .then(() => options.acquire(definitions, stop.signal))
    .then((value) => {
      owner = value
      return value
    })
  const ready = (async () => {
    const owned = await acquired
    current()
    const entry = owned.registry.get(target.name, owned.registry.generation)
    const associations = owned.targetPermissions.filter((value) => value.tool === target)
    if (associations.length !== 1 || entry.nativeTaskPermission?.permission !== associations[0]?.permission)
      throw Error("Native workflow permission association differs from canonical target")
    entry.nativeTaskPermission.assertOwner(owned.service)
    const inputCodec = definitions.codecs[0]?.input
    if (!inputCodec) throw Error("Native workflow canonical target has no input codec")
    const decoder = bindToolValueCodec(inputCodec, target, "input")
    if (
      entry.tool.execute !== target.execute ||
      entry.inputDecoder !== decoder.decode ||
      JSON.stringify(entry.tool.input) !== JSON.stringify(decoder.schema) ||
      entry.tool.output !== undefined
    )
      throw Error("Native workflow registry does not own the exact canonical target")
    registrations.push(
      await options.tool.transform((editor) => {
        current()
        const matches = editor.list().filter((item) => item.name === publicDefinition.name)
        if (matches.length > 1) throw Error("Ambiguous public Native workflow tool")
        const previous = matches[0]
        if (previous)
          editor.update(previous.id, (item) => {
            item.name = publicDefinition.name
            item.description = publicDefinition.description
            item.input = publicDefinition.input
            item.execute = publicDefinition.execute
            delete item.output
            delete item.options
          })
        else editor.add(publicDefinition)
        const effective = editor.list().filter((item) => item.name === publicDefinition.name),
          replaced = effective[0]
        if (
          effective.length !== 1 ||
          !replaced ||
          replaced.input !== publicDefinition.input ||
          replaced.description !== publicDefinition.description ||
          replaced.output !== undefined ||
          replaced.options !== undefined
        )
          throw Error("Public Native workflow tool replacement failed")
      }),
    )
    current()
  })()
  void ready.catch(() => {})

  return Object.freeze({
    ready,
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      if (closeAttempt) return closeAttempt
      closing = true
      stop.abort(Error("Native workflow bridge closed"))
      const work = (async () => {
        await ready.catch(() => {})
        const failures: unknown[] = []
        for (let index = registrations.length - 1; index >= 0; index--) {
          try {
            await registrations[index]?.dispose()
            registrations.splice(index, 1)
          } catch (error) {
            failures.push(error)
          }
        }
        await Promise.all([...setups])
        if (owner) {
          try {
            await owner.service.close()
          } catch (error) {
            failures.push(error)
          }
        } else {
          try {
            await options.rollbackAcquisition()
          } catch (error) {
            failures.push(error)
          }
        }
        await Promise.all([...callbacks])
        if (!failures.length && owner) {
          try {
            await owner.release()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) throw new AggregateError(failures, "Native workflow bridge cleanup incomplete")
        closed = true
      })()
      closeAttempt = work
      void work
        .finally(() => {
          if (!closed && closeAttempt === work) closeAttempt = undefined
        })
        .catch(() => {})
      return work
    },
  })
}
