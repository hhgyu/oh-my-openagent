// /facts -- read-only view of the facts pipeline, plus the ONLY manual unpark path.
//
// `/facts retry` clears failure records and triggers one reconcile/launch attempt. It never
// changes either watermark. The store restores parked files to the hot queue under its
// lock before clearing their records. There is no automatic unparking.

import { FactsFailureStore, type FactsFailureFilter, type FactsFailuresFile } from "../facts"
import type { MemoryIdentityPaths } from "../identity"
import { LockContentionError } from "../locks"
import { parseCommandArgs } from "./args"
import { formatFactsStatus, readFactsOverview } from "./facts-status"
import { requireIdentity, respond, type MemoryCommandContext, type MemoryCommandDeps } from "./types"

function conversationsIn(records: readonly { readonly conversationId: string }[]): string[] {
  return [...new Set(records.map((record) => record.conversationId))].sort()
}

async function runRetry(
  deps: MemoryCommandDeps,
  ctx: MemoryCommandContext,
  identityPaths: MemoryIdentityPaths,
  conversationId: string | undefined,
): Promise<string> {
  const store = new FactsFailureStore({ identityPaths })
  let before: FactsFailuresFile
  try {
    before = await store.readFailures()
  } catch (error) {
    if (error instanceof LockContentionError) return respond(ctx, "cannot retry: the failure ledger is busy; try /facts retry again shortly", "info")
    return respond(
      ctx,
      `cannot retry: the failure ledger is unreadable (${error instanceof Error ? error.message : String(error)}); repair or remove failures.json first`,
      "error",
    )
  }

  const matching = before.entries.filter(
    (record) => conversationId === undefined || record.conversationId === conversationId,
  )
  if (matching.length === 0) {
    const scope = conversationId === undefined ? "the facts ledger" : `conversation ${conversationId}`
    return respond(ctx, `no failure records to clear for ${scope}; nothing was retried`, "info")
  }

  const filter: FactsFailureFilter = conversationId === undefined ? {} : { conversationId }
  let removed: number
  try {
    removed = await store.clearForRetry(filter)
  } catch (error) {
    if (error instanceof LockContentionError) return respond(ctx, "cannot retry: the failure ledger is busy; try /facts retry again shortly", "info")
    throw error
  }
  // ONE attempt: the extractor owns its own re-entrancy latch, so the command never loops.
  // A host's reconcile only launches the extractor and does not wait for its outcome, so the
  // report must not claim anything about the outcome: it says the retry started and leaves
  // the result to the next /facts read.
  await deps.factsSink?.reconcile()
  const names = conversationsIn(matching)
  const unparked = matching.filter((record) => record.state === "parked").length
  const unparkedNote = unparked === 0
    ? ""
    : `; ${unparked} parked ${unparked === 1 ? "batch" : "batches"} unparked`
  return respond(
    ctx,
    `cleared ${removed} record${removed === 1 ? "" : "s"} for ${names.join(", ")}; one retry attempt was started${unparkedNote}; run /facts again to check whether any batch parked again`,
  )
}

export async function runFactsCommand(deps: MemoryCommandDeps, args: string, ctx: MemoryCommandContext): Promise<string> {
  const identity = requireIdentity(deps, ctx)
  if (typeof identity === "string") return respond(ctx, identity, "error")

  const parsed = parseCommandArgs(args)
  const conversationFlag = parsed.flags.get("conversation")
  const conversationId = typeof conversationFlag === "string" ? conversationFlag : undefined

  if (parsed.positionals[0] === "retry") {
    return runRetry(deps, ctx, identity.identityPaths, conversationId)
  }
  if (parsed.positionals.length > 0) {
    return respond(ctx, `unknown /facts subcommand "${parsed.positionals[0]}"; use /facts or /facts retry`, "error")
  }

  const overview = await readFactsOverview({
    identityPaths: identity.identityPaths,
    now: new Date(deps.now?.() ?? Date.now()),
  })
  return respond(ctx, formatFactsStatus(identity.identity, overview))
}
