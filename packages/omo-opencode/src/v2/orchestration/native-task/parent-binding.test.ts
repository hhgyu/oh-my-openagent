import { expect, test } from "bun:test"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import { createParentBindings, parentBindingInfo, type VerifiedParentBinding } from "./parent-binding"
import type { HostStartAuthority } from "@oh-my-opencode/senpi-task/manager-kernel"
import {
  createSessionBackend,
  type ChildJournal,
  type ChildRecord,
  type SessionBackendApi,
} from "../../host/session-backend"
import { withJoinedSessionCancellation } from "../../host/session-cancellation"
function fixture() {
  const scopes = createSessionScopes(),
    policy = { tools: ["read"], authorize() {} },
    root = scopes.open("root" as SessionLease["sessionID"], policy)
  const bindings = createParentBindings(root, policy, () => scopes.assert(root))
  const raw = new AbortController()
  const authority: HostStartAuthority = {
    admissionSignal: raw.signal,
    lifetimeSignal: root.signal,
    assertAdmission() {
      raw.signal.throwIfAborted()
      scopes.assert(root)
    },
    assertLifetime() {
      scopes.assert(root)
    },
  }
  return { scopes, root, bindings, raw, authority }
}
test("accepted start uses exact original issued authority identity and validated ancestry", () => {
  const f = fixture(),
    spec = { parent_session_id: "root", root_session_id: "root", depth: 1 }
  const authority = f.bindings.capture(f.bindings.root, f.authority, spec)
  expect(f.bindings.fromAuthority(authority)).toBe(f.bindings.root)
  expect(() => f.bindings.fromAuthority({ ...authority })).toThrow("no issued")
  expect(() => f.bindings.capture(f.bindings.root, f.authority, { ...spec, depth: 2 })).toThrow("ancestry")
  expect(() => parentBindingInfo({} as VerifiedParentBinding)).toThrow("Unissued")
  const foreign = fixture()
  expect(() => foreign.bindings.info(f.bindings.root)).toThrow("Foreign")
  f.scopes.dispose()
  foreign.scopes.dispose()
})
test("separate borrower admission stop leaves the actual owned lease live and joins original work", async () => {
  const f = fixture(),
    done = Promise.withResolvers<void>(),
    work = f.bindings.track(f.bindings.root, done.promise)
  const authority = f.bindings.capture(f.bindings.root, f.authority, {
    parent_session_id: "root",
    root_session_id: "root",
    depth: 1,
  })
  f.bindings.stop("root")
  expect(f.root.signal.aborted).toBe(false)
  expect(() => authority.assertAdmission()).toThrow("admission closed")
  authority.assertLifetime()
  let settled = false
  const release = f.bindings.release(f.bindings.root).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)
  done.resolve()
  await work
  await release
  expect(settled).toBe(true)
  expect(() => f.scopes.assert(f.root)).not.toThrow()
  f.scopes.dispose()
})

async function borrowedFixture() {
  const f = fixture(),
    records = new Map<string, ChildRecord>()
  const write = (before: ChildRecord, next: ChildRecord): undefined => {
    if (JSON.stringify(records.get(before.key)) !== JSON.stringify(before)) throw Error("stale controlled journal")
    records.set(next.key, structuredClone(next))
    return undefined
  }
  const journal: ChildJournal = {
    async claim(key, _owner, initial) {
      if (!initial) throw Error("initial only")
      records.set(key, structuredClone(initial))
      return initial
    },
    async read(key) {
      return records.get(key)
    },
    async write(before, next) {
      write(before, next)
    },
    writeSync: write,
    assertCurrent(row) {
      if (JSON.stringify(records.get(row.key)) !== JSON.stringify(row)) throw Error("stale controlled journal")
      return undefined
    },
  }
  const api = {
    async get({ sessionID }: { sessionID: string }) {
      return { id: sessionID, parentID: sessionID === "root" ? undefined : "root", location: { directory: "/project" } }
    },
    async create(input: { id: string }) {
      return { id: input.id, parentID: "root", location: { directory: "/project" } }
    },
    async interrupt() {
      return { interrupted: true }
    },
    async wait() {},
    async remove() {},
  } as unknown as SessionBackendApi
  withJoinedSessionCancellation(api, "controlled-test")
  const backend = createSessionBackend(
    {
      app: { name: "opencode", version: "2.2.6", channel: "stable" },
      location: { directory: "/project" },
      session: api,
    },
    {
      backendID: "controlled",
      owner: "owner",
      parent: f.root,
      scopes: f.scopes,
      policy: { tools: [], authorize() {} },
      journal,
      gate: {
        assertActive() {
          f.scopes.assert(f.root)
        },
      },
    },
  )
  const child = await backend.stage({
    key: "controlled-child",
    sessionID: "child" as SessionLease["sessionID"],
    agent: "build",
  })
  return { ...f, backend, child, capability: backend.borrowParent(child) }
}

test("a retained borrower admission fence can refuse new actions without revoking accepted lifetime or cleanup", async () => {
  const f = await borrowedFixture(),
    done = Promise.withResolvers<void>()
  let eligible = true
  try {
    const binding = Reflect.apply(f.bindings.adopt, f.bindings, [
      f.capability,
      1,
      () => {},
      () => {
        if (!eligible) throw Error("ancestor no longer eligible")
      },
    ])
    const authority = f.bindings.capture(binding, f.authority, {
      parent_session_id: "child",
      root_session_id: "root",
      depth: 2,
    })
    const tracked = f.bindings.track(binding, done.promise)
    eligible = false
    expect(() => f.bindings.info(binding, true)).toThrow("eligible")
    expect(() => authority.assertAdmission()).toThrow("eligible")
    expect(() => authority.assertLifetime()).not.toThrow()
    expect(() => f.bindings.info(binding)).not.toThrow()
    let released = false
    const closing = f.bindings.release(binding).then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    done.resolve()
    await tracked
    await closing
    expect(released).toBe(true)
  } finally {
    done.resolve()
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("fresh verification refreshes current actions but cannot replace a captured queued authority's original fence", async () => {
  const f = await borrowedFixture()
  let originalEligible = true
  try {
    const binding = Reflect.apply(f.bindings.adopt, f.bindings, [
      f.capability,
      1,
      () => {},
      () => {
        if (!originalEligible) throw Error("original ancestor fence changed")
      },
    ])
    const old = f.bindings.capture(binding, f.authority, {
      parent_session_id: "child",
      root_session_id: "root",
      depth: 2,
    })
    originalEligible = false
    expect(Reflect.apply(f.bindings.adopt, f.bindings, [f.capability, 1, () => {}, () => {}])).toBe(binding)
    expect(() => f.bindings.info(binding, true)).not.toThrow()
    expect(() => old.assertAdmission()).toThrow("original ancestor")
    expect(() => old.assertLifetime()).not.toThrow()
  } finally {
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("release joins accepted work registered by a completing callback before deleting borrower", async () => {
  const f = await borrowedFixture(),
    first = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>()
  const binding = f.bindings.adopt(f.capability, 1, () => {})
  const initial = f.bindings.track(binding, first.promise)
  let late: Promise<void> | undefined,
    completed = false
  const continuation = first.promise.then(() => {
    late = f.bindings.track(binding, second.promise)
  })
  const release = f.bindings.release(binding).then(() => {
    completed = true
  })
  try {
    first.resolve()
    await initial
    await continuation
    // Let the original allSettled snapshot's continuation finish without releasing second.
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(f.bindings.get(f.child.locator.sessionID)).toBe(binding)
    expect(() => f.scopes.assert(f.child.lease)).not.toThrow()
    second.resolve()
    await late
    await release
    expect(completed).toBe(true)
    expect(f.bindings.get(f.child.locator.sessionID)).toBeUndefined()
  } finally {
    first.resolve()
    second.resolve()
    await initial
    await continuation
    await late
    await release
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("drain alone reaches fixed point while retaining exact binding, lease, policy and admission", async () => {
  const f = await borrowedFixture(),
    first = Promise.withResolvers<void>(),
    second = Promise.withResolvers<void>()
  const binding = f.bindings.adopt(f.capability, 1, () => {}),
    policy = parentBindingInfo(binding).policy
  const tracked = f.bindings.track(binding, first.promise)
  let late: Promise<void> | undefined,
    done = false
  const continuation = first.promise.then(() => {
    late = f.bindings.track(binding, second.promise)
  })
  const draining = f.bindings.drain(binding).then(() => {
    done = true
  })
  try {
    first.resolve()
    await tracked
    await continuation
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(false)
    expect(f.bindings.get(f.child.locator.sessionID)).toBe(binding)
    expect(f.bindings.info(binding, true).policy).toBe(policy)
    expect(f.child.lease.signal.aborted).toBe(false)
    second.resolve()
    await late
    await draining
    expect(f.bindings.get(f.child.locator.sessionID)).toBe(binding)
    expect(() => f.bindings.info(binding, true)).not.toThrow()
    f.bindings.stop(f.child.locator.sessionID)
    expect(() => f.bindings.info(binding, true)).toThrow("admission closed")
    await f.bindings.drain(binding)
    expect(() => f.bindings.info(binding)).not.toThrow()
    expect(() => f.scopes.assert(f.child.lease)).not.toThrow()
  } finally {
    first.resolve()
    second.resolve()
    await tracked
    await continuation
    await late
    await draining
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("drain rejects foreign factory bindings and does not delete root on repeated cleanup", async () => {
  const a = fixture(),
    b = fixture()
  try {
    await expect(a.bindings.drain(b.bindings.root)).rejects.toThrow("Foreign")
    await a.bindings.drain(a.bindings.root)
    await a.bindings.release(a.bindings.root)
    await a.bindings.drain(a.bindings.root)
    expect(a.bindings.get(a.root.sessionID)).toBe(a.bindings.root)
    expect(() => a.scopes.assert(a.root)).not.toThrow()
  } finally {
    a.scopes.dispose()
    b.scopes.dispose()
  }
})

test("late old release cannot delete a replacement exact borrowed binding", async () => {
  const f = await borrowedFixture()
  try {
    const old = f.bindings.adopt(f.capability, 1, () => {})
    await f.bindings.release(old)
    const replacement = f.bindings.adopt(f.backend.borrowParent(f.child), 1, () => {})
    expect(replacement).not.toBe(old)
    await f.bindings.release(old)
    await f.bindings.drain(old)
    expect(f.bindings.get(f.child.locator.sessionID)).toBe(replacement)
    expect(() => f.bindings.info(replacement, true)).not.toThrow()
  } finally {
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("settled rejected operation preserves original caller error while other pending work still joins", async () => {
  const f = fixture(),
    held = Promise.withResolvers<void>(),
    failure = Error("controlled operation failure")
  const failed = f.bindings.track(f.bindings.root, Promise.reject(failure))
  void failed.catch(() => {})
  const tracked = f.bindings.track(f.bindings.root, held.promise)
  let done = false
  const draining = f.bindings.drain(f.bindings.root).then(() => {
    done = true
  })
  try {
    await expect(failed).rejects.toBe(failure)
    await Promise.resolve()
    expect(done).toBe(false)
    held.resolve()
    await tracked
    await draining
    expect(done).toBe(true)
  } finally {
    held.resolve()
    await tracked
    await draining
    f.scopes.dispose()
  }
})

test("concurrent drains and release join one original operation without duplicated disposition", async () => {
  const f = await borrowedFixture(),
    held = Promise.withResolvers<void>()
  let dispositions = 0,
    finished = 0
  const binding = f.bindings.adopt(f.capability, 1, () => {})
  const original = held.promise.then(() => {
      dispositions++
    }),
    tracked = f.bindings.track(binding, original)
  const joins = [f.bindings.drain(binding), f.bindings.drain(binding), f.bindings.release(binding)].map((work) =>
    work.then(() => {
      finished++
    }),
  )
  try {
    await Promise.resolve()
    expect(finished).toBe(0)
    expect(f.child.lease.signal.aborted).toBe(false)
    held.resolve()
    await tracked
    await Promise.all(joins)
    expect(finished).toBe(3)
    expect(dispositions).toBe(1)
    expect(f.bindings.get(f.child.locator.sessionID)).toBeUndefined()
  } finally {
    held.resolve()
    await tracked
    await Promise.all(joins)
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("historical drain can join already accepted work after real child lease retirement without new authority", async () => {
  const f = await borrowedFixture(),
    held = Promise.withResolvers<void>(),
    binding = f.bindings.adopt(f.capability, 1, () => {})
  const tracked = f.bindings.track(binding, held.promise)
  try {
    await f.backend.close(f.child)
    expect(f.child.lease.signal.aborted).toBe(true)
    expect(() => f.bindings.info(binding)).toThrow()
    let done = false
    const draining = f.bindings.drain(binding).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    held.resolve()
    await tracked
    await draining
    expect(done).toBe(true)
  } finally {
    held.resolve()
    await tracked
    await f.backend.dispose()
    f.scopes.dispose()
  }
})

test("fresh process executes drain and release without SDK, UI or Native adapter runtime", () => {
  const bindingURL = new URL("./parent-binding.ts", import.meta.url).href,
    scopeURL = new URL("../../host/session-state.ts", import.meta.url).href
  const script = `let forbidden=0;Bun.plugin({name:"C2D-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@opencode\\/plugin|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/]omo-senpi[\\\\/]/},()=>{forbidden++;throw Error("NATIVE_ADAPTER")})}});const{createParentBindings}=await import(${JSON.stringify(bindingURL)}),{createSessionScopes}=await import(${JSON.stringify(scopeURL)});const scopes=createSessionScopes(),policy={tools:[],authorize(){}},root=scopes.open("unit",policy),bindings=createParentBindings(root,policy,()=>scopes.assert(root)),a=Promise.withResolvers(),b=Promise.withResolvers();const first=bindings.track(bindings.root,a.promise);let late,done=false;const continuation=a.promise.then(()=>{late=bindings.track(bindings.root,b.promise)});const join=bindings.drain(bindings.root).then(()=>{done=true});a.resolve();await first;await continuation;await Promise.resolve();await Promise.resolve();const stayedPending=!done;if(!stayedPending)throw Error("Snapshot only");b.resolve();await late;await join;const retained=bindings.get(root.sessionID)===bindings.root&&!root.signal.aborted;await bindings.release(bindings.root);scopes.dispose();if(forbidden||!retained)throw Error("Cold failed");console.log(JSON.stringify({forbidden,stayedPending,retained}));`
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 })
  expect(new TextDecoder().decode(child.stderr)).toBe("")
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
    forbidden: 0,
    stayedPending: true,
    retained: true,
  })
})
