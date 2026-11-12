import type { HostStartAuthority, ManagerStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { SessionLease, SessionToolPolicy } from "../../host/session-state"
import { readBorrowedChildParent, type BorrowedChildParent } from "../../host/session-backend"

const brand: unique symbol = Symbol("verified owned parent binding")
export interface VerifiedParentBinding {
  readonly [brand]: true
}
/** Internal binding state; exported only so dependent declarations can name it. */
export interface Parent {
  lease: SessionLease
  policy: SessionToolPolicy
  rootSessionId: string
  depth: number
  stop: AbortController
  assertOwned(): void
  assertAdmission?: () => void
  work: Set<Promise<unknown>>
}
const issued = new WeakMap<VerifiedParentBinding, Parent>()
export function parentBindingInfo(binding: VerifiedParentBinding) {
  const parent = issued.get(binding)
  if (!parent) throw Error("Unissued verified parent")
  parent.assertOwned()
  parent.lease.signal.throwIfAborted()
  return parent
}
export function createParentBindings(root: SessionLease, policy: SessionToolPolicy, assertRoot: () => void) {
  const current = new Map<string, VerifiedParentBinding>(),
    owned = new WeakSet<VerifiedParentBinding>()
  const authorities = new WeakMap<HostStartAuthority, VerifiedParentBinding>()
  function issue(
    lease: SessionLease,
    policy: SessionToolPolicy,
    depth: number,
    assertOwned: () => void,
    assertAdmission?: () => void,
  ) {
    const binding: VerifiedParentBinding = Object.freeze({ [brand]: true as const })
    issued.set(binding, {
      lease,
      policy,
      rootSessionId: root.sessionID,
      depth,
      stop: new AbortController(),
      assertOwned,
      assertAdmission,
      work: new Set(),
    })
    current.set(lease.sessionID, binding)
    owned.add(binding)
    return binding
  }
  const rootBinding = issue(root, policy, 0, assertRoot)
  function info(binding: VerifiedParentBinding, admission = false) {
    if (!owned.has(binding)) throw Error("Foreign root parent binding")
    const value = parentBindingInfo(binding)
    if (current.get(value.lease.sessionID) !== binding) throw Error("Parent binding superseded")
    if (admission) {
      value.assertAdmission?.()
      value.stop.signal.throwIfAborted()
    }
    return value
  }
  async function drain(binding: VerifiedParentBinding): Promise<void> {
    const parent = issued.get(binding)
    if (!parent || !owned.has(binding)) throw Error("Foreign parent drain")
    // Cleanup custody only: stop/new-action eligibility is separate. A completing accepted
    // operation may register more original work before this snapshot settles.
    while (parent.work.size) await Promise.allSettled([...parent.work])
  }
  return {
    root: rootBinding,
    info,
    drain,
    get(sessionID: string) {
      return current.get(sessionID)
    },
    adopt(capability: BorrowedChildParent, depth: number, assertOwned: () => void, assertAdmission?: () => void) {
      const cap = readBorrowedChildParent(capability)
      assertAdmission?.()
      const prior = current.get(cap.lease.sessionID)
      if (prior) {
        const parent = info(prior)
        parent.stop.signal.throwIfAborted()
        if (parent.lease !== cap.lease || parent.depth !== depth) throw Error("Another child lease owns this borrower")
        // A new verified callback may refresh current action eligibility. Already
        // captured Native admissions below retain their own original fence.
        parent.assertAdmission = assertAdmission
        return prior
      }
      assertOwned()
      return issue(
        cap.lease,
        cap.policy,
        depth,
        () => {
          cap.assertCurrent()
          assertOwned()
        },
        assertAdmission,
      )
    },
    capture(
      binding: VerifiedParentBinding,
      original: HostStartAuthority,
      spec: Pick<ManagerStartSpec, "parent_session_id" | "root_session_id" | "depth">,
    ) {
      const parent = info(binding, true)
      if (
        spec.parent_session_id !== parent.lease.sessionID ||
        (spec.root_session_id ?? spec.parent_session_id) !== parent.rootSessionId ||
        spec.depth !== parent.depth + 1
      )
        throw Error("Start ancestry differs from verified parent")
      original.assertAdmission()
      const assertCapturedAdmission = parent.assertAdmission
      const authority: HostStartAuthority = Object.freeze({
        admissionSignal: AbortSignal.any([original.admissionSignal, parent.stop.signal]),
        lifetimeSignal: original.lifetimeSignal,
        assertAdmission() {
          info(binding)
          parent.stop.signal.throwIfAborted()
          assertCapturedAdmission?.()
          original.assertAdmission()
        },
        assertLifetime() {
          info(binding)
          original.assertLifetime()
        },
      })
      authorities.set(authority, binding)
      return authority
    },
    fromAuthority(authority: HostStartAuthority | undefined) {
      const parent = authority && authorities.get(authority)
      if (!parent) throw Error("Queued start has no issued parent binding")
      info(parent, true)
      return parent
    },
    async track<T>(binding: VerifiedParentBinding, work: Promise<T>): Promise<T> {
      const parent = info(binding)
      parent.work.add(work)
      try {
        return await work
      } finally {
        parent.work.delete(work)
      }
    },
    stop(sessionID: string) {
      const binding = current.get(sessionID)
      if (!binding) return
      const parent = issued.get(binding)
      if (!parent) throw Error("Borrowed parent binding was not issued by this owner")
      parent.stop.abort(Error("Borrowed parent admission closed"))
      return binding
    },
    async release(binding: VerifiedParentBinding) {
      const parent = issued.get(binding)
      if (!parent || !owned.has(binding)) throw Error("Foreign parent release")
      parent.stop.abort(Error("Borrowed parent released"))
      await drain(binding)
      if (binding !== rootBinding && current.get(parent.lease.sessionID) === binding)
        current.delete(parent.lease.sessionID)
    },
    entries() {
      return [...current.values()]
    },
  }
}
