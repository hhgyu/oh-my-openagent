import type * as PromisePlugin from "@opencode/plugin/promise/plugin"
import { ChildParentLink, type ParentPermissionMode } from "@oh-my-opencode/senpi-task/parent-link"

// OpenCode 2's own approval mode for a session is its `permissions` ruleset. The host copies a parent's ruleset into a
// child created without one, but never carries a later change to it. Native task children follow their parent's mode
// on every change (#12853); this ports that follow onto owned children through Native's own ChildParentLink.

type FollowHost = {
  readonly event: Pick<PromisePlugin.Context["event"], "subscribe">
  readonly session: Pick<PromisePlugin.Context["session"], "get" | "update">
}
type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }

function encodePermissionMode(rules: readonly Rule[] | undefined): string {
  return JSON.stringify(
    (rules ?? []).map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect })),
  )
}

function decodePermissionMode(mode: string): Rule[] {
  const value: unknown = JSON.parse(mode)
  if (!Array.isArray(value)) throw new Error("Parent approval mode is not a ruleset")
  return value.map((rule: Rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }))
}

export interface ParentPermissionWatch extends ParentPermissionMode {
  /** A fresh host read of the parent; an event seen after the read was issued wins over it. */
  refresh(): Promise<void>
  dispose(): void
}

export function watchParentPermissions(host: FollowHost, parentID: string, signal: AbortSignal): ParentPermissionWatch {
  const stop = new AbortController()
  const lifetime = AbortSignal.any([stop.signal, signal])
  const listeners = new Set<(mode: string) => void>()
  let mode: string | undefined
  let changes = 0
  const publish = (next: string) => {
    mode = next
    for (const listener of [...listeners]) listener(next)
  }
  void (async () => {
    try {
      for await (const event of host.event.subscribe({ types: ["session.permissions"], signal: lifetime })) {
        if (event.type !== "session.permissions" || event.data.sessionID !== parentID) continue
        changes++
        publish(encodePermissionMode(event.data.permissions))
      }
    } catch (error) {
      if (!lifetime.aborted) console.warn("[oh-my-openagent/v2] parent approval-mode watch failed", { parentID, error })
    }
  })()
  return {
    current: () => mode,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async refresh() {
      const seen = changes
      const info = await host.session.get({ sessionID: parentID as never })
      if (changes === seen && !lifetime.aborted) publish(encodePermissionMode(info.permissions))
    },
    dispose() {
      stop.abort()
      listeners.clear()
    },
  }
}

export interface ChildPermissionFollow {
  /** Stops following and joins a push already in flight; a later parent change reaches this child no more. */
  stop(): Promise<void>
}

/** A fresh child is aligned at once when its host copy already differs from the parent (a change raced its creation).
 * A recovered child keeps the rules it was restored with until the parent's next change: rules a user wrote on the
 * child itself are never overwritten without one. A failed push is reported and retried on the parent's next change. */
export function followParentPermissions(options: {
  readonly host: FollowHost
  readonly watch: ParentPermissionWatch
  readonly taskId: string
  readonly childID: string
  readonly fresh: boolean
  readonly assertCurrent: () => void
  readonly onWarning: (message: string) => void
  readonly onRecovered: () => void
}): ChildPermissionFollow {
  let stopped = false
  let inflight: Promise<unknown> = Promise.resolve()
  const link = new ChildParentLink(options.taskId, undefined, options.watch, (message) => {
    options.onWarning(message)
    return options.onRecovered
  })
  const push = (mode: string) => {
    if (stopped) return Promise.reject(new Error("Child no longer follows its parent"))
    options.assertCurrent()
    const work = options.host.session.update({
      sessionID: options.childID as never,
      permissions: decodePermissionMode(mode),
    })
    inflight = work.catch(() => undefined)
    return work
  }
  const starting = (async () => {
    await options.watch.refresh()
    const child = await options.host.session.get({ sessionID: options.childID as never })
    if (stopped) return
    if (!options.fresh || encodePermissionMode(child.permissions) === options.watch.current()) link.named({})
    link.follow(push)
  })().catch((error: unknown) => {
    if (stopped) return
    options.onWarning(
      `task ${options.taskId} could not start following its parent's approval mode; its mode stays the one it was created with: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
  return {
    async stop() {
      stopped = true
      link.close()
      await starting
      await inflight
    },
  }
}
