import {
  checkNameConflict,
  fuzzyMatch,
  normalizeThreadName,
  resolveTarget,
  workspaceEntries,
  type ThreadAddressEntry,
} from "@oh-my-opencode/thread-core/addressing"
import type {
  ThreadCloseInput,
  ThreadCreateInput,
  ThreadHandoffInput,
  ThreadInterruptInput,
  ThreadListInput,
  ThreadReadInput,
  ThreadRenameInput,
  ThreadSendInput,
  ThreadSetModelInput,
  ThreadSetReasoningInput,
  ThreadToolResult,
} from "@oh-my-opencode/thread-core/contracts"
import {
  closeThread,
  interruptThread,
  setModelOn,
  setThinkingLevelOn,
} from "@oh-my-opencode/thread-core/control/operations"
import { controlIdentity } from "@oh-my-opencode/thread-core/control/port"
import { liveReadResult } from "@oh-my-opencode/thread-core/read-result"
import { replyTargetMismatch } from "@oh-my-opencode/thread-core/reply-allowance"
import { threadToolFailure } from "@oh-my-opencode/thread-core/errors"
import { failure } from "@oh-my-opencode/thread-core/tool-result"
import { summaryOf, type V2AddressEntry } from "./address-book"
import { createV2SessionControl } from "./control"
import type { ThreadCall, ThreadSurface } from "./surface"

const NOT_LIVE: ThreadToolResult = failure(
  "not_resumable",
  "The thread has no live owner.",
  "Retry when the target is live.",
)
const NO_DEVICES =
  "Threads on other devices need the account device service, which has no OpenCode 2 adapter yet; only sessions this machine's OpenCode servers hold are reachable."

type Located =
  | { readonly kind: "ok"; readonly entry: V2AddressEntry }
  | { readonly kind: "error"; readonly result: ThreadToolResult }

function addressOf(address: string, call: ThreadCall): string {
  return address === "self" ? call.callerId : address
}

async function locate(
  surface: ThreadSurface,
  call: ThreadCall,
  address: string,
  allScope: boolean | undefined,
): Promise<Located> {
  const entries = await surface.entries()
  const resolved = resolveTarget(entries, addressOf(address, call), {
    all_scope: allScope,
    callerWorkspaceRoot: await call.workspaceRoot(),
  })
  if (resolved.kind === "error") {
    const details = resolved.candidates === undefined ? undefined : { candidates: resolved.candidates }
    return { kind: "error", result: failure(resolved.code, resolved.message, resolved.next_action, details) }
  }
  return { kind: "ok", entry: resolved.entry as V2AddressEntry }
}

function control(surface: ThreadSurface, call: ThreadCall, entry: V2AddressEntry) {
  return createV2SessionControl({
    host: surface.controlHost(entry),
    info: entry.info,
    visible: async () => workspaceEntries(await surface.entries(), await call.workspaceRoot()),
  })
}

async function deliver(
  surface: ThreadSurface,
  call: ThreadCall,
  value: ThreadSendInput | ThreadHandoffInput,
  match: "exact" | "fuzzy",
  handoff: boolean,
): Promise<ThreadToolResult> {
  const entries = await surface.entries()
  const address = addressOf(value.thread, call)
  const root = await call.workspaceRoot()
  let entry: ThreadAddressEntry
  let resolvedBy: "id" | "exact_name" | "fuzzy"
  const exact = resolveTarget(entries, address, { all_scope: value.all_scope, callerWorkspaceRoot: root })
  if (exact.kind === "ok") {
    entry = exact.entry
    resolvedBy = exact.resolution === "id" ? "id" : "exact_name"
  } else if (match === "fuzzy") {
    const pool = value.all_scope === true ? entries : workspaceEntries(entries, root)
    const fuzzy = fuzzyMatch(
      pool.filter((candidate) => candidate.thread_id !== call.callerId),
      value.thread,
    )
    if (fuzzy.kind === "error")
      return failure(
        fuzzy.code,
        fuzzy.message,
        fuzzy.next_action,
        fuzzy.candidates === undefined ? undefined : { candidates: fuzzy.candidates },
      )
    entry = fuzzy.entry
    resolvedBy = "fuzzy"
  } else {
    const details = exact.candidates === undefined ? undefined : { candidates: exact.candidates }
    return failure(exact.code, exact.message, exact.next_action, details)
  }
  const mismatch = replyTargetMismatch(call.replyEvidence, value.thread, entry)
  if (mismatch !== undefined) return { kind: "error", error: mismatch }
  const sent = await call.send({
    thread_id: entry.thread_id,
    all_scope: true,
    text: value.message,
    mode: value.delivery ?? "auto",
    ...(value.expected_turn_id === undefined ? {} : { expected_turn_id: value.expected_turn_id }),
    idempotency_key: value.idempotency_key?.trim() || `call:${call.callId}`,
    args: value,
  })
  if (sent.kind === "error") return sent
  const facts = {
    delivery_id: sent.delivery_id,
    effective_mode: sent.effective_mode,
    endpoint: sent.endpoint_kind === null ? null : { kind: sent.endpoint_kind },
  }
  const target = entries.find((candidate) => candidate.thread_id === entry.thread_id) as V2AddressEntry
  if (!handoff)
    return {
      kind: "ok",
      thread_id: sent.thread_id,
      link: summaryOf(target).link,
      delivery: sent.delivery,
      message_seq: sent.message_seq,
      deduplicated: sent.deduplicated,
      ...facts,
    }
  return {
    kind: "ok",
    thread: summaryOf(target),
    resolved_by: resolvedBy,
    delivery: sent.delivery,
    message_seq: sent.message_seq,
    deduplicated: sent.deduplicated,
    ...facts,
  }
}

export function createSessionToolBodies(surface: ThreadSurface) {
  return {
    thread_list: async (value: ThreadListInput, call: ThreadCall): Promise<ThreadToolResult> => {
      const entries = await surface.entries()
      const visible = value.all_scope === true ? entries : workspaceEntries(entries, await call.workspaceRoot())
      return {
        kind: "ok",
        threads: (visible as V2AddressEntry[]).map(summaryOf),
        scope: value.all_scope === true ? "all" : "workspace",
      }
    },
    thread_read: async (value: ThreadReadInput, call: ThreadCall): Promise<ThreadToolResult> => {
      const located = await locate(surface, call, value.thread, value.all_scope)
      if (located.kind === "error") return located.result
      const port = control(surface, call, located.entry)
      return liveReadResult(port.thread_id, port.title, await port.getMessages(), value)
    },
    thread_send: (value: ThreadSendInput, call: ThreadCall) => deliver(surface, call, value, "exact", false),
    thread_handoff: (value: ThreadHandoffInput, call: ThreadCall) =>
      deliver(surface, call, value, value.match === "fuzzy" ? "fuzzy" : "exact", true),
    thread_interrupt: async (value: ThreadInterruptInput, call: ThreadCall): Promise<ThreadToolResult> => {
      const located = await locate(surface, call, value.thread, value.all_scope)
      if (located.kind === "error") return located.result
      if (located.entry.liveness !== "routable") return NOT_LIVE
      return await interruptThread(control(surface, call, located.entry), value.turn_id)
    },
    thread_close: async (value: ThreadCloseInput, call: ThreadCall): Promise<ThreadToolResult> => {
      const located = await locate(surface, call, value.thread, value.all_scope)
      if (located.kind === "error") return located.result
      if (located.entry.liveness !== "routable")
        return { kind: "ok", thread_id: located.entry.thread_id, closed: false }
      return await closeThread(control(surface, call, located.entry))
    },
    thread_set_model: async (value: ThreadSetModelInput, call: ThreadCall): Promise<ThreadToolResult> => {
      const located = await locate(surface, call, value.thread, value.all_scope)
      if (located.kind === "error") return located.result
      if (located.entry.liveness !== "routable") return NOT_LIVE
      return await setModelOn(control(surface, call, located.entry), value.model, value.provider)
    },
    thread_set_reasoning: async (value: ThreadSetReasoningInput, call: ThreadCall): Promise<ThreadToolResult> => {
      const located = await locate(surface, call, value.thread, value.all_scope)
      if (located.kind === "error") return located.result
      if (located.entry.liveness !== "routable") return NOT_LIVE
      return await setThinkingLevelOn(control(surface, call, located.entry), value.level, value.scope)
    },
    thread_rename: async (value: ThreadRenameInput, call: ThreadCall): Promise<ThreadToolResult> => {
      if (value.name === undefined && value.alias === undefined)
        return failure("invalid_arguments", "Pass a new name, a new alias, or both.", "Retry with name or alias.")
      const located = await locate(surface, call, value.thread, value.all_scope)
      if (located.kind === "error") return located.result
      if (located.entry.liveness !== "routable") return NOT_LIVE
      const port = control(surface, call, located.entry)
      const name = (value.name ?? value.alias)?.trim() ?? ""
      if (name.length === 0)
        return failure("invalid_arguments", "The new thread name is empty.", "Pass a non-empty name.")
      const existing = (await port.visible()).find(
        (entry) => entry.thread_id !== port.thread_id && normalizeThreadName(entry.name) === normalizeThreadName(name),
      )
      if (existing !== undefined)
        return failure(
          "name_conflict",
          `A thread named "${existing.name}" already exists.`,
          "Call thread_list and choose another name.",
        )
      await port.setName(name)
      return {
        kind: "ok",
        ...controlIdentity(port),
        name,
        ...(value.alias === undefined
          ? {}
          : { alias_scope: "local" as const, alias_unavailable: "no_remote" as const }),
      }
    },
    thread_create: async (value: ThreadCreateInput, call: ThreadCall): Promise<ThreadToolResult> => {
      if (value.device !== undefined)
        return failure("unsupported", NO_DEVICES, "Create the thread on this machine: leave device unset.")
      if (value.fork_from !== undefined)
        return failure(
          "unsupported",
          "OpenCode 2 gives plugins no session fork, so a thread cannot start from another thread's transcript.",
          "Create a fresh thread and thread_send it the context it needs.",
        )
      if (value.skills !== undefined)
        return failure(
          "unsupported",
          "OpenCode 2 sessions take no initial skill list at creation.",
          "Create the thread without skills and thread_send it an instruction to load them.",
        )
      if (value.thread !== undefined) {
        const located = await locate(surface, call, value.thread, true)
        if (located.kind === "error") return located.result
        return { kind: "ok", thread: summaryOf(located.entry), deduplicated: true }
      }
      const name = (value.name ?? value.alias)?.trim()
      if (name !== undefined && name.length > 0) {
        const conflict = checkNameConflict(await surface.entries(), name)
        if (conflict.kind === "error") return failure(conflict.code, conflict.message, conflict.next_action)
      }
      const created = await surface.createSession({
        directory: value.cwd ?? (await call.workspaceRoot()),
        ...(name === undefined || name.length === 0 ? {} : { title: name }),
        callerId: call.callerId,
      })
      return {
        kind: "ok",
        thread: summaryOf(created),
        deduplicated: false,
        ...(value.alias === undefined
          ? {}
          : { alias_scope: "local" as const, alias_unavailable: "no_remote" as const }),
      }
    },
  }
}

export function callerContextMissing(): {
  readonly kind: "error"
  readonly error: ReturnType<typeof threadToolFailure>
} {
  return {
    kind: "error",
    error: threadToolFailure(
      "caller_context_missing",
      "This thread tool needs the calling eval call, which has finished or runs detached.",
      "Call the thread tool from a running eval cell.",
    ),
  }
}
