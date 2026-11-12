import { Effect } from "effect"
import type { DurableChildJournal } from "../../host/child-journal"
import type { SessionLease, SessionScopes } from "../../host/session-state"
import type { ChildGuardApproval, ChildGuardStage, OwnedChildToolGuard } from "../../host/owned-child-tool-guard"

export interface GuardClaim {
  token: ChildGuardStage
  sessionID: string
  parent: SessionLease
  key: string
  hooksClosed: boolean
  closeHooks?: () => Promise<void>
  released: boolean
  /** The SAME backend's opaque receipt for this issued child, present only after a verified park. */
  parkedReceipt?: () => object | undefined
  assertParked?: (receipt: object, child: object) => void
}

/** Original guard-claim custody for the owned runner: stop/join, closed release, parked retirement. */
export function createGuardCustody(options: {
  owner: () => OwnedChildToolGuard
  journal: DurableChildJournal
  scopes: SessionScopes
  hostVersion: string
  location: string
}) {
  const claims = new Map<string, GuardClaim>()
  async function stop(claim: GuardClaim | undefined) {
    if (!claim || claim.released) return
    options.owner().revoke(claim.token)
    await Effect.runPromise(options.owner().join(claim.token))
  }
  async function joinedHooks(claim: GuardClaim) {
    await stop(claim)
    await claim.closeHooks?.()
    if (!claim.hooksClosed) throw Error("Original child policy/observer cleanup is incomplete")
  }
  async function release(claim: GuardClaim | undefined) {
    if (!claim || claim.released) return
    await joinedHooks(claim)
    const closed = await options.journal.read(claim.key)
    const assertClosed = () => {
      options.scopes.assert(claim.parent)
      if (
        !closed ||
        closed.key !== claim.key ||
        closed.phase !== "closed" ||
        closed.owner !== options.journal.owner ||
        closed.locator.sessionID !== claim.sessionID ||
        closed.locator.parentID !== claim.parent.sessionID ||
        closed.locator.backendID !== "omo-native-task-opencode" ||
        closed.locator.hostVersion !== options.hostVersion ||
        closed.locator.location !== options.location
      )
        throw Error("Actual child closed receipt is unavailable")
      if (!options.journal.assertCurrent) throw Error("Synchronous closed journal fence unavailable")
      options.journal.assertCurrent(closed)
    }
    options.owner().release(claim.token, assertClosed)
    claim.released = true
    claims.delete(claim.key)
  }
  /** Parked is not closed: transfer to static parked deny custody on the backend's receipt.
   * Only a later fresh-action recovery may renew this stage (see runner renewal). */
  async function retireParked(claim: GuardClaim | undefined) {
    const receipt = claim?.parkedReceipt?.()
    if (!claim || claim.released || !receipt || !claim.assertParked) return
    await joinedHooks(claim)
    options.owner().retireParked(claim.token, receipt, claim.assertParked)
    claim.released = true
    claims.delete(claim.key)
  }
  /** A restore renews the guard's parked tombstone for this ID (or begins on a fresh guard). */
  function begin(
    approval: ChildGuardApproval,
    sessionID: string,
    assertAdmission: () => void,
    renew: boolean,
  ): ChildGuardStage {
    return renew
      ? options.owner().renewStage(approval, sessionID, assertAdmission)
      : options.owner().beginStage(approval, sessionID, assertAdmission)
  }
  return {
    claims,
    stop,
    release,
    retireParked,
    begin,
    finish: (claim: GuardClaim | undefined) => (claim?.parkedReceipt?.() ? retireParked(claim) : release(claim)),
  }
}
