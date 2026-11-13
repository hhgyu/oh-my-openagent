import { Schema } from "effect"
import type { TSchema } from "typebox"
import type { Info, Result, ToolContext, ToolDomain } from "@opencode/plugin/promise/tool"
import type { Registration } from "@opencode/plugin/promise/registration"
import {
  buildTaskExecute,
  buildTaskToolDescription,
  normalizeTaskToolArguments,
  runTaskOutput,
  runTaskCancel,
  forgetTaskOutputSessionReads,
  TASK_CANCEL_TOOL_DESCRIPTION,
  TASK_SEND_TOOL_DESCRIPTION,
  createToolArgumentValidator,
  ToolArgumentValidationError,
  type TaskToolContext,
  type TaskToolDeps,
  type TaskToolParamsStatic,
  type TaskOutputInput,
  type TaskOutputDeps,
  type TaskSendInput,
  type TaskCancelInput,
  type TaskSendTeamRouting,
} from "@oh-my-opencode/senpi-task/task-operations"
import type { createToolKernel } from "../host/tool-kernel"
import type { ListedTool, ToolRegistry } from "../host/tool-registry"
import { bindToolValueCodec, type ToolCodecAssociation } from "../host/tool-value-codec"
import type { ToolNormalizerAssociation } from "../host/tool-argument-normalizer"
import type {
  NativeTaskTargetPermissionAssociation,
  createNativeTaskService,
} from "../orchestration/native-task/service"
import { issueNativeTaskCodecs, nativeTaskInputSchemas } from "./native-task-codecs"
import { requestedTaskSkillNames, type PreparedNativeTaskRuntime } from "./native-task-preparation"
import { adaptNativeTaskResult } from "./native-task-result"

const canonicalTargets = new WeakMap<
  ListedTool,
  { readonly id: string; readonly name: string; readonly execute: ListedTool["execute"] }
>()
/** Read-only origin check. Only this bridge's original target construction registers origins. */
export function assertCanonicalNativeTaskTarget(target: ListedTool): void {
  const original = canonicalTargets.get(target)
  if (
    !original ||
    !Object.isFrozen(target) ||
    original.id !== target.id ||
    original.name !== target.name ||
    original.execute !== target.execute
  )
    throw Error("Noncanonical Native task permission target")
}

type Name = "task" | "task_output" | "task_send" | "task_cancel"
/** The 4 Native task tool names this bridge publishes. */
export const NATIVE_TASK_TOOL_NAMES: readonly Name[] = Object.freeze([
  "task",
  "task_output",
  "task_send",
  "task_cancel",
])
const OUTPUT_DESCRIPTION =
  "Read a current-session child by task_id or name; status, tail or full. Read-only; never revives or steers a child."
type Service = ReturnType<typeof createNativeTaskService>
type OperationRun = Parameters<Awaited<ReturnType<Service["forCall"]>>["operation"]>[0]
/** The arguments of ONE call's Native operation, passed on unchanged and never retained. */
export interface NativeTaskOperationCall {
  readonly manager: Parameters<OperationRun>[0]
  readonly resolveAncestry: Parameters<OperationRun>[1]
  readonly signal: AbortSignal
  readonly operation: Parameters<OperationRun>[3]
}

/** A strict public boundary: validation never converts or replaces the input. */
export function nativeTaskPublicInput(name: Name) {
  return strictPublicInput(nativeTaskInputSchemas[name])
}

/** The same strict public boundary for any canonical Native TypeBox input schema. */
export function strictPublicInput(canonical: TSchema) {
  const validate = createToolArgumentValidator(canonical)
  const json = JSON.parse(JSON.stringify(canonical))
  // Code Mode otherwise drops unknown keys before invoking the SDK callback.
  // Preserve them in transport so canonical validation can name and reject them.
  preserveUnknownFields(json)
  return Schema.Any.check(
    Schema.makeFilter<unknown>(
      (value) => {
        try {
          validate(value)
          return true
        } catch (error) {
          if (error instanceof ToolArgumentValidationError) return error.message
          throw error
        }
      },
      {
        toJsonSchema: () => structuredClone(json),
      },
    ),
  )
}

function preserveUnknownFields(schema: unknown): void {
  if (schema === null || typeof schema !== "object") return
  const value = schema as Record<string, unknown>
  if (value.type === "object") value.additionalProperties = true
  Object.values(value).forEach(preserveUnknownFields)
}

export interface NativeTaskTargets {
  readonly tools: readonly ListedTool[]
  readonly codecs: readonly ToolCodecAssociation[]
  readonly normalizers: readonly ToolNormalizerAssociation[]
}

/** Trusted component assembly ONLY. The producer owns the genuine registry,
 * kernel and SAME service as one unit. Its current per-root Native grant and SDK
 * agent/session permission provenance must be proved before entry activation.
 * No global/read/all-tools policy is supplied or inferred by this adapter. */
export interface NativeTaskBridgeOwner {
  readonly registry: ToolRegistry
  readonly kernel: ReturnType<typeof createToolKernel>
  readonly service: Service
  /** Omitted only for low-level ordinary explicit resource-adapter composition. */
  readonly targetPermissions?: readonly NativeTaskTargetPermissionAssociation[]
  /** Current supported host facts; never a fabricated Native ExtensionContext. */
  context(caller: ToolContext, signal: AbortSignal): TaskToolContext | Promise<TaskToolContext>
  taskDependencies(
    caller: ToolContext,
  ): Pick<TaskToolDeps, "resolveSkillInvocations" | "resolveChildToolNames" | "executionModeGate">
  outputDependencies(caller: ToolContext): Omit<TaskOutputDeps, "manager" | "resolveCallerSessionId">
  /** Team routing for THIS call's `task_send`, built inside its operation over the same manager.
   * Absent, or returning undefined, keeps the Native no-team send. */
  teamRouting?(caller: ToolContext, call: NativeTaskOperationCall): TaskSendTeamRouting | undefined
  /** Registry/scopes/metadata remain live until service and callbacks are joined.
   * Must retain failed cleanup for retry; successful repeat release is harmless. */
  release(): Promise<void>
}

export interface NativeTaskBridgeOptions {
  readonly tool: ToolDomain
  readonly prepared: PreparedNativeTaskRuntime
  /** Snapshot/preparation must use this component signal and retain custody of
   * original acquisition work on failure. No racing away abandoned acquisition. */
  acquire(targets: NativeTaskTargets, signal: AbortSignal): Promise<NativeTaskBridgeOwner>
  /** Required failure-side custody: join/rollback anything acquired before
   * acquire rejected. Retain failed closers so a subsequent close retries. */
  rollbackAcquisition(): Promise<void>
}

/** Creates an owned, UNREGISTERED component. Root must own it before awaiting
 * ready, and must close even after rejected setup. No production entry uses it
 * until the real policy/context producer and normal-entry harness are proved. */
export function createNativeTaskBridge(options: NativeTaskBridgeOptions) {
  const stop = new AbortController(),
    callbacks = new Set<Promise<void>>(),
    setups = new Set<Promise<void>>()
  const registrations: Registration[] = [],
    taskIDs = new Set<string>(),
    statusReads = new Map<string, string>()
  const inputValidators = new Map<string, (value: unknown) => unknown>()
  let closing = false,
    closed = false,
    owner: NativeTaskBridgeOwner | undefined,
    closeAttempt: Promise<void> | undefined
  const current = () => {
    if (closing) throw Error("Native task bridge is closing")
    stop.signal.throwIfAborted()
  }
  function ticket(set: Set<Promise<void>>) {
    let finish!: () => void
    const work = new Promise<void>((resolve) => {
      finish = resolve
    })
    set.add(work)
    return () => {
      set.delete(work)
      finish()
    }
  }
  async function publicCall(name: Name, input: unknown, caller: ToolContext) {
    current()
    // Both placeholders exist BEFORE even the first session lookup is invoked.
    const finish = ticket(callbacks),
      prepared = ticket(setups)
    try {
      const resources = owner
      if (!resources) throw Error("Native task bridge has no acquired owner")
      const lease = await resources.service.parent(caller)
      current()
      caller.signal.throwIfAborted()
      const bound = resources.kernel.bind(caller, lease)
      // No await between setup phase completion and original action invocation.
      prepared()
      try {
        return await bound.invoke(name, input)
      } finally {
        bound.dispose()
      }
    } finally {
      prepared()
      finish()
    }
  }
  const description = buildTaskToolDescription({ omoConfig: options.prepared.config, agents: options.prepared.agents })
  const descriptions: Record<Name, string> = {
    task: description,
    task_output: OUTPUT_DESCRIPTION,
    task_send: TASK_SEND_TOOL_DESCRIPTION,
    task_cancel: TASK_CANCEL_TOOL_DESCRIPTION,
  }
  const targets = NATIVE_TASK_TOOL_NAMES.map((name): ListedTool =>
    Object.freeze({
      id: `omo.native.${name}`,
      name,
      description: descriptions[name],
      input: nativeTaskInputSchemas[name] as unknown as Info["input"],
      async execute(input, caller) {
        current()
        const resources = owner
        if (!resources) throw Error("Native task bridge has no acquired owner")
        const call = await resources.service.forCall(caller)
        return call.operation(
          async (manager, resolveAncestry, signal, operation) => {
            if (name === "task_output") {
              const result = await runTaskOutput(
                { ...resources.outputDependencies(caller), manager: operation.output },
                input as TaskOutputInput,
                caller.sessionID,
                statusReads,
              )
              return adaptNativeTaskResult(result)
            }
            // The SAME canonical send lifetime (mapped/late outcome chain) and cancel port of this operation.
            if (name === "task_send") {
              const teamRouting = resources.teamRouting?.(caller, { manager, resolveAncestry, signal, operation })
              return adaptNativeTaskResult(
                await operation.runSend(input as TaskSendInput, { signal, ...(teamRouting && { teamRouting }) }),
              )
            }
            if (name === "task_cancel")
              return adaptNativeTaskResult(await runTaskCancel(operation.cancel, input as TaskCancelInput))
            const context = await resources.context(caller, signal)
            signal.throwIfAborted()
            current()
            if (context.sessionManager.getSessionId() !== caller.sessionID) throw Error("Foreign Native task context")
            // Availability is not authorization: THIS caller's `skill` decisions precede any child
            // staging, and a deny/reject propagates unchanged. The loader serves only those names.
            const skillSignal = AbortSignal.any([caller.signal, signal])
            const loadSkills = await options.prepared.authorizeSkills(
              caller,
              requestedTaskSkillNames(input as TaskToolParamsStatic),
              skillSignal,
            )
            skillSignal.throwIfAborted()
            current()
            const execute = buildTaskExecute({
              ...resources.taskDependencies(caller),
              manager: operation.task,
              omoConfig: options.prepared.config,
              agents: options.prepared.agents,
              resolveAncestry,
              prepareRuntime: async () => {
                current()
                signal.throwIfAborted()
              },
              loadSkills,
            })
            const progress = operation.reportProgress
              ? (update: Parameters<NonNullable<Parameters<typeof execute>[3]>>[0]) => {
                  const projected = adaptNativeTaskResult(update)
                  const report = operation.reportProgress,
                    metadata = projected.metadata
                  if (!report) throw Error("Native task progress port is no longer available")
                  if (!metadata) throw Error("Native task progress result has no metadata")
                  report({ nativeTask: metadata.native })
                }
              : undefined
            return adaptNativeTaskResult(
              await execute(caller.id, input as TaskToolParamsStatic, signal, progress, context),
            )
          },
          { progress: caller.progress },
        )
      },
    }),
  )
  const issued = targets.map((target) => issueNativeTaskCodecs(target, target.name as Name))
  const definitions = Object.freeze({
    tools: Object.freeze(targets),
    codecs: Object.freeze(issued.map((item) => item.codec)),
    normalizers: Object.freeze(issued.flatMap((item) => (item.normalizer ? [item.normalizer] : []))),
  }) satisfies NativeTaskTargets
  for (const target of targets)
    canonicalTargets.set(target, { id: target.id, name: target.name, execute: target.execute })
  const publicDefinitions = targets.map((target): Info =>
    Object.freeze({
      name: target.name,
      description: target.description,
      input: nativeTaskPublicInput(target.name as Name),
      execute: (input, caller) => publicCall(target.name as Name, input, caller),
    }),
  )

  // Own acquisition before invoking a potentially synchronous/async producer.
  const acquired = Promise.resolve()
    .then(() => options.acquire(definitions, stop.signal))
    .then((value) => {
      owner = value
      return value
    })
  const ready = (async () => {
    const resources = await acquired
    current()
    for (const [index, target] of targets.entries()) {
      const entry = resources.registry.get(target.name, resources.registry.generation)
      if (entry.nativeTaskPermission || resources.targetPermissions) {
        const associations = resources.targetPermissions?.filter((value) => value.tool === target)
        if (associations?.length !== 1 || entry.nativeTaskPermission?.permission !== associations[0]?.permission)
          throw Error("Native bridge permission association differs from canonical target")
        entry.nativeTaskPermission.assertOwner(resources.service)
      }
      const inputCodec = definitions.codecs[index]?.input
      if (!inputCodec) throw Error("Native bridge canonical target has no input codec")
      const decoder = bindToolValueCodec(inputCodec, target, "input")
      if (
        entry.tool.execute !== target.execute ||
        entry.inputDecoder !== decoder.decode ||
        JSON.stringify(entry.tool.input) !== JSON.stringify(decoder.schema) ||
        (target.name === "task" && !entry.normalizeInput) ||
        entry.tool.output !== undefined
      )
        throw Error("Native bridge registry does not own exact canonical targets")
    }
    registrations.push(
      await options.tool.hook("execute.before", (event) => {
        if (taskIDs.has(event.tool)) {
          current()
          event.input = normalizeTaskToolArguments(event.input)
        }
        const validate = inputValidators.get(event.tool)
        if (validate) {
          current()
          validate(event.input)
        }
      }),
    )
    current()
    registrations.push(
      await options.tool.transform((editor) => {
        current()
        // Validate ALL collisions before touching either definition.
        const matches = publicDefinitions.map((tool) => editor.list().filter((entry) => entry.name === tool.name))
        if (matches.some((entries) => entries.length > 1)) throw Error("Ambiguous public Native task tool")
        taskIDs.clear()
        inputValidators.clear()
        for (const [index, tool] of publicDefinitions.entries()) {
          const previous = matches[index]?.[0]
          if (previous)
            editor.update(previous.id, (entry) => {
              entry.name = tool.name
              entry.description = tool.description
              entry.input = tool.input
              entry.execute = tool.execute
              delete entry.output
              delete entry.options
            })
          else editor.add(tool)
          const effective = editor.list().filter((entry) => entry.name === tool.name),
            replaced = effective[0]
          if (
            effective.length !== 1 ||
            !replaced ||
            replaced.input !== tool.input ||
            replaced.description !== tool.description ||
            replaced.output !== undefined ||
            replaced.options !== undefined
          )
            throw Error("Public Native task tool replacement failed")
          if (tool.name === "task") taskIDs.add(replaced.id)
          inputValidators.set(replaced.id, createToolArgumentValidator(nativeTaskInputSchemas[tool.name as Name]))
        }
      }),
    )
    current()
  })()
  // Setup rejection is observable via ready without an unhandled rejection.
  void ready.catch(() => {})

  return Object.freeze({
    ready,
    /** The public `task` operation for a caller that is not an SDK `task` call: an eval cell's
     * `tools.task` (eval-task-host-tool.ts), under the eval call's own SDK context. Arguments get the
     * same normalization the `execute.before` hook gives a direct call. */
    invokeTask(input: unknown, caller: ToolContext): Promise<Result> {
      return publicCall("task", normalizeTaskToolArguments(input), caller)
    },
    /** Wire to a genuine session lifetime event at assembly; manual forgetting
     * is not evidence that host session retirement is connected. */
    forgetSession(sessionID: string) {
      forgetTaskOutputSessionReads(statusReads, sessionID)
    },
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      if (closeAttempt) return closeAttempt
      closing = true
      stop.abort(Error("Native task bridge closed"))
      const work = (async () => {
        // Join ORIGINAL setup, including any late-acquired registrations.
        await ready.catch(() => {})
        const failures: unknown[] = []
        for (let index = registrations.length - 1; index >= 0; index--) {
          try {
            const registration = registrations[index]
            if (!registration) throw Error("Native task bridge registration is missing")
            await registration.dispose()
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
        // Failed registrations/service retain all lower-level resource custody.
        if (!failures.length && owner) {
          try {
            await owner.release()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) throw new AggregateError(failures, "Native task bridge cleanup incomplete")
        statusReads.clear()
        taskIDs.clear()
        inputValidators.clear()
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
