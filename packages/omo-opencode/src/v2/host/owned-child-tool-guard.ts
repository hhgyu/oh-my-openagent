import { Cause, Context, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { randomUUID } from "node:crypto"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { checkHostGrantTarget, type PreparedHostTaskGrant, type HostGrantRequirement } from "../orchestration/native-task/host-grant"

type ToolInfo = Awaited<Effect.Success<ReturnType<ToolDomain["list"]>>>[number]
type Coverage = { readonly boundRequirements: readonly HostGrantRequirement[]; readonly targets?: readonly { readonly requirement: HostGrantRequirement; readonly nativeName: string; readonly hostID: string }[] }
export interface ChildGuardApproval { readonly buildAgentID: string }
export interface ChildGuardStage { readonly sessionID: string }
export interface ChildGuardBinding {
  /** The ORIGINAL issued backend child, never a locator reconstructed from JSON. */
  readonly child: object
  readonly agent: string
  /** Original synchronous backend.observationGuard plus current live producers. */
  readonly assertCurrent: () => void
  readonly coverage?: Coverage
  readonly network?: { readonly hostID: string; readonly assertCurrent: () => void; readonly allowsGet: (url: string) => boolean
    /** Trusted producer's ORIGINAL intrinsic-GET executor, not a name/schema. */
    readonly intrinsicGetOriginal?: ToolInfo["execute"] }
  /** ORIGINAL live Promise-backed producer custody. Effect-only producers have no JS work and
   * omit it; a real Promise producer must expose its own revoke and settled join. */
  readonly producers?: { revoke(): void; join(): Promise<void> }
}
export interface OwnedChildToolGuard {
  /** Trusted composition only: retain the SAME G2 approval and Native admission. */
  approve(admission: object, input: { readonly selection: PreparedHostTaskGrant; readonly buildAgentID: string; readonly assertCurrent: () => void }): ChildGuardApproval
  beginStage(approval: ChildGuardApproval, sessionID: string, assertAdmission: () => void): ChildGuardStage
  /** Explicit same-ID renewal under a FRESH approval. A parked tombstone of this guard must be
   * joined and is replaced by a new Scope/generation with no unrelated gap (old-generation
   * wrappers stay denied); any other live stage refuses. A guard that never owned the ID begins. */
  renewStage(approval: ChildGuardApproval, sessionID: string, assertAdmission: () => void): ChildGuardStage
  bind(stage: ChildGuardStage, binding: ChildGuardBinding): void
  revoke(stage: ChildGuardStage): void
  /** Interrupt and JOIN original Effect fibers/finalizers. Does not certify an
   * underlying Promise adapter's abandoned JavaScript callback. */
  join(stage: ChildGuardStage): Effect.Effect<void>
  /** Call only after the real backend confirms child closed/gone. Throws retain
   * the deny marker and exclusive claim, allowing cleanup retry. */
  release(stage: ChildGuardStage, assertClosed: () => void): void
  /** Distinct park retirement: only after original effects/producers joined AND the actual
   * backend validates its opaque parked receipt for this exact child. Frees the active claim
   * while keeping the owned-ID deny tombstone; the host deny rule fences fresh snapshots. */
  retireParked(stage: ChildGuardStage, receipt: object, validate: (receipt: object, child: object) => void): void
  close(): Effect.Effect<void>
}
type Approval = { token: ChildGuardApproval; selection: PreparedHostTaskGrant; assertCurrent(): void; stage?: Stage }
type Stage = { token: ChildGuardStage; approval: Approval; state: "provisional" | "bound" | "revoked" | "released" | "parked"; scope: Scope.Closeable; binding?: ChildGuardBinding; joining?: Deferred.Deferred<Exit.Exit<void, never>>; joined?: Exit.Exit<void, never>
  producerJoin?: Promise<void>; producersJoined?: boolean; parkedReceipt?: object }
const retired = (stage: Stage) => stage.state === "released" || stage.state === "parked"
const joined = (stage: Stage) => !!stage.joined && Exit.isSuccess(stage.joined) && (!stage.binding?.producers || stage.producersJoined === true)

function snapshot<A>(value: A): A {
  const copy = structuredClone(value)
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { for (const value of Object.values(item)) freeze(value); Object.freeze(item) } }
  freeze(copy); return copy
}

/** Unregistered host infrastructure. The owner must be acquired in the real
 * Effect plugin scope before children; no Native SDK/UI import or fake context. */
export function acquireOwnedChildToolGuard(domains: { readonly tool: Pick<ToolDomain, "transform">; readonly permission: Pick<PermissionDomain, "hook"> }): Effect.Effect<OwnedChildToolGuard, never, Scope.Scope> {
  return Effect.gen(function* () {
    const approvals = new WeakMap<object, Approval>(), admissions = new WeakSet<object>()
    const stages = new WeakMap<object, Stage>(), sessions = new Map<string, Stage>(), children = new WeakSet<object>(), parkedReceipts = new WeakSet<object>()
    const originals = new WeakMap<ToolInfo["execute"], ToolInfo["execute"]>()
    // Public Permission.assert -> evaluate hooks run in the original Effect
    // context. This private per-owner reference cannot be borrowed by parallel
    // calls with equal SDK call IDs (CodeMode inner calls share those IDs).
    const intrinsic = Context.Reference<{ live: boolean; stage: Stage; original: ToolInfo["execute"]; hostID: string; context: Parameters<ToolInfo["execute"]>[1] } | undefined>(`owned-child-get-${randomUUID()}`, { defaultValue: () => undefined })
    let stopped = false, toolDisposed = false, permissionDisposed = false
    let ownerClose: Deferred.Deferred<Exit.Exit<void, never>> | undefined
    const current = () => { if (stopped) throw Error("Owned child guard is closing") }
    function stageFor(token: ChildGuardStage): Stage { const stage = stages.get(token); if (!stage) throw Error("Foreign child stage"); return stage }
    function verify(stage: Stage, agent: string): ChildGuardBinding {
      current()
      if (stage.state !== "bound" || !stage.binding) throw Error("Owned child is not executable")
      stage.approval.assertCurrent(); stage.binding.assertCurrent()
      if (stage.binding.agent !== agent || stage.approval.token.buildAgentID !== agent) throw Error("Owned child agent differs")
      current()
      if (stage.state !== "bound") throw Error("Owned child revoked during custody check")
      return stage.binding
    }
    const toolRegistration = yield* domains.tool.transform(editor => {
      for (const tool of editor.list()) {
        const original = originals.get(tool.execute) ?? tool.execute
        const wrapped: ToolInfo["execute"] = (input, context) => {
          // Generation captured at CALL creation: a lazy effect from an older stage (or an
          // unrelated issuance) cannot borrow a renewed stage by an equal session ID.
          const issued = sessions.get(context.sessionID)
          return Effect.suspend(() => {
          const stage = sessions.get(context.sessionID)
          if (stage !== issued) return Effect.fail(new ToolError({ message: "Owned child generation changed" }))
          if (!stage) return original.call(tool, input, context)
          return Effect.uninterruptibleMask(restore => Effect.gen(function* () {
            const authorize = () => {
              if (sessions.get(context.sessionID) !== stage) throw Error("Owned child generation changed")
              const binding = verify(stage, context.agent)
              if (checkHostGrantTarget(stage.approval.selection, tool.id, binding.coverage) !== "selected") throw Error("Final child tool is outside the Native grant")
              return binding
            }
            const refused = (cause: unknown) => new ToolError({ message: cause instanceof Error ? cause.message : "Child tool custody unavailable" })
            const binding = yield* Effect.try({ try: authorize, catch: refused })
            const marker = binding.network?.hostID === tool.id && binding.network.intrinsicGetOriginal === original ? { live: true, stage, original, hostID: tool.id, context } : undefined
            // Scope owns the ORIGINAL executor fiber. Caller interruption also
            // interrupts+joins it; Scope.close cannot race away its finalizers.
            const execution = Effect.suspend(() => {
              try { authorize() } catch (cause) { return Effect.fail(refused(cause)) }
              // Same synchronous turn as the final fence; do not yield between
              // final custody validation and invoking the original executor.
              return original.call(tool, input, context)
            }).pipe(Effect.provideService(intrinsic, marker),
              Effect.ensuring(Effect.sync(() => { if (marker) marker.live = false })))
            const fiber = yield* Effect.forkIn(restore(execution), stage.scope, { startImmediately: true })
            return yield* restore(Fiber.join(fiber)).pipe(Effect.ensuring(Fiber.interrupt(fiber)))
          }))
          })
        }
        originals.set(wrapped, original)
        editor.update(tool.id, value => { value.execute = wrapped })
      }
    })
    const permissionRegistration = yield* domains.permission.hook("evaluate", event => Effect.gen(function* () {
      const leaf = yield* intrinsic
      const stage = sessions.get(event.sessionID)
      if (!stage || event.action !== "webfetch") return
      try {
        const binding = verify(stage, event.agent ?? "")
        const network = binding.network
        if (!network || checkHostGrantTarget(stage.approval.selection, network.hostID, binding.coverage) !== "selected") throw Error("No live Native network grant")
        network.assertCurrent()
        const fromOriginalGet = leaf?.live === true && leaf.stage === stage && leaf.hostID === network.hostID && leaf.original === network.intrinsicGetOriginal &&
          leaf.context.sessionID === event.sessionID && leaf.context.agent === event.agent && leaf.context.id === event.source?.id && leaf.context.messageID === event.source?.messageID
        const method = event.metadata?.method
        const rawURL = event.metadata?.url
        const intrinsicGet = method === undefined && fromOriginalGet && typeof rawURL === "string" && rawURL.split("#")[0] === event.resources[0]
        if (event.source?.type !== "tool" || !event.source.id || !event.source.messageID || (method !== "GET" && !intrinsicGet) || event.resources.length !== 1) throw Error("Unverifiable owned fetch")
        const url = event.resources[0], parsed = new URL(url)
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || !network.allowsGet(url)) throw Error("Owned fetch target denied")
      } catch { event.effect = "deny"; event.message = "Owned child network grant refused" }
      // Allowed requests keep the host's original deny/ask/allow, never elevate.
    }))
    const owner: OwnedChildToolGuard = {
      approve(admission, input) {
        current(); input.assertCurrent()
        if (!admission || admissions.has(admission) || !input.buildAgentID) throw Error("Duplicate or invalid Native admission")
        const token = Object.freeze({ buildAgentID: input.buildAgentID })
        admissions.add(admission); approvals.set(token, { token, selection: snapshot(input.selection), assertCurrent: input.assertCurrent })
        return token
      },
      beginStage(token, sessionID, assertAdmission) {
        current(); const approval = approvals.get(token)
        if (!approval || approval.stage || !sessionID || sessions.has(sessionID)) throw Error("Foreign or busy approved stage")
        approval.assertCurrent(); assertAdmission()
        const stage: Stage = { token: Object.freeze({ sessionID }), approval, state: "provisional", scope: Scope.makeUnsafe() }
        approval.stage = stage; stages.set(stage.token, stage); sessions.set(sessionID, stage)
        return stage.token
      },
      renewStage(token, sessionID, assertAdmission) {
        current(); const approval = approvals.get(token), previous = sessions.get(sessionID)
        if (!approval || approval.stage || !sessionID || previous && (previous.state !== "parked" || !joined(previous))) throw Error("Only a joined parked stage may renew under a fresh approval")
        approval.assertCurrent(); assertAdmission()
        const stage: Stage = { token: Object.freeze({ sessionID }), approval, state: "provisional", scope: Scope.makeUnsafe() }
        approval.stage = stage; stages.set(stage.token, stage); sessions.set(sessionID, stage)
        return stage.token
      },
      bind(token, binding) {
        current(); const stage = stageFor(token)
        if (stage.state !== "provisional" || children.has(binding.child)) throw Error("Child stage already bound or revoked")
        stage.approval.assertCurrent(); binding.assertCurrent()
        if (binding.agent !== stage.approval.token.buildAgentID) throw Error("Actual build agent differs from approval")
        stage.binding = Object.freeze({ ...binding, ...(binding.coverage ? { coverage: snapshot(binding.coverage) } : {}), ...(binding.network ? { network: Object.freeze({ ...binding.network }) } : {}) })
        children.add(binding.child); stage.state = "bound"
      },
      revoke(token) { const stage = stageFor(token); if (!retired(stage)) { stage.state = "revoked"; stage.binding?.producers?.revoke() } },
      join(token) {
        const stage = stageFor(token); if (retired(stage)) return Effect.void
        stage.state = "revoked"; stage.binding?.producers?.revoke()
        return Effect.uninterruptible(Effect.gen(function* () {
          if (!stage.joined) {
            if (stage.joining) stage.joined = yield* Deferred.await(stage.joining)
            else {
              // Scope.close marks its Scope closed before finalizers finish;
              // a second Scope.close alone would return early. All callers
              // await this SAME original close, never that already-closed flag.
              stage.joining = Deferred.makeUnsafe()
              stage.joined = yield* Effect.exit(Scope.close(stage.scope, Exit.succeed(undefined)))
              yield* Deferred.succeed(stage.joining, stage.joined)
            }
          }
          if (Exit.isFailure(stage.joined)) return yield* Effect.failCause(stage.joined.cause)
          const producers = stage.binding?.producers
          if (producers && !stage.producersJoined) {
            // A failed/held producer join keeps custody; a later explicit join retries it.
            const work = stage.producerJoin ??= Promise.resolve().then(() => producers.join()).then(() => { stage.producersJoined = true }, error => { stage.producerJoin = undefined; throw error })
            yield* Effect.promise(() => work)
          }
        }))
      },
      release(token, assertClosed) {
        const stage = stageFor(token)
        if (stage.state === "released") return
        if (stage.state === "parked") throw Error("Parked child custody has no closed receipt")
        if (!joined(stage)) throw Error("Original child effects are not joined")
        assertClosed()
        // Retain a deny tombstone for the entire guard lifetime. Lazy executor
        // effects and future calls for this owned ID can never become unrelated.
        stage.state = "released"; stage.approval.stage = undefined
      },
      retireParked(token, receipt, validate) {
        const stage = stageFor(token)
        if (stage.state === "parked" && stage.parkedReceipt === receipt) return
        if (retired(stage) || !stage.binding) throw Error("Child stage cannot transfer to parked custody")
        if (!joined(stage)) throw Error("Original child effects are not joined")
        if (parkedReceipts.has(receipt)) throw Error("Parked receipt already consumed")
        validate(receipt, stage.binding.child)
        // Deny tombstone stays in sessions; prior wrappers and lazy effects remain denied.
        stage.state = "parked"; stage.parkedReceipt = receipt; parkedReceipts.add(receipt)
      },
      close() {
        stopped = true
        const owned = [...sessions.values()].filter(stage => !retired(stage)); for (const stage of owned) stage.state = "revoked"
        return Effect.uninterruptible(Effect.gen(function* () {
          if (ownerClose) {
            const exit = yield* Deferred.await(ownerClose)
            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
            return
          }
          const original = Deferred.makeUnsafe<Exit.Exit<void, never>>()
          ownerClose = original
          const exit = yield* Effect.exit(Effect.gen(function* () {
            let failure: Cause.Cause<never> | undefined
            for (const stage of owned) {
              const joined = yield* Effect.exit(owner.join(stage.token))
              if (Exit.isFailure(joined)) failure = failure ? Cause.combine(failure, joined.cause) : joined.cause
            }
            if (failure) return yield* Effect.failCause(failure)
            yield* Effect.sync(() => { if (owned.some(stage => !retired(stage))) throw Error("Child closure custody incomplete; deny hooks retained") })
            // Successful disposal is never repeated. Failed disposal remains
            // retained for a LATER explicit retry, not a concurrent second run.
            if (!permissionDisposed) { yield* permissionRegistration.dispose; permissionDisposed = true }
            if (!toolDisposed) { yield* toolRegistration.dispose; toolDisposed = true }
          }))
          yield* Deferred.succeed(original, exit)
          if (Exit.isFailure(exit)) {
            if (ownerClose === original) ownerClose = undefined
            return yield* Effect.failCause(exit.cause)
          }
        }))
      },
    }
    // Acquired AFTER registrations: LIFO owner join runs before SDK hook removal.
    // The trusted component must close/release its real children BEFORE closing
    // this plugin Scope. Automatic SDK scope teardown cannot retain hooks after
    // scope destruction; this module does not certify host unload safety.
    yield* Effect.addFinalizer(() => owner.close())
    return owner
  })
}
