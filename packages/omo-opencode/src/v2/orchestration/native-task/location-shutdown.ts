import type * as PromisePlugin from "@opencode/plugin/promise/plugin"

type ShutdownHost = Pick<PromisePlugin.Context, "event" | "location">
type EventLocation = { readonly directory: string; readonly workspaceID?: string | undefined } | undefined

/** The host scopes a plugin's subscription to its own location; an event that still names another
 * location (or workspace) is not ours. */
function sameLocation(event: EventLocation, own: ShutdownHost["location"]): boolean {
  return event === undefined || event.directory === own.directory && (event.workspaceID ?? undefined) === (own.workspaceID ?? undefined)
}

/** Calls `onShutdown` once when OpenCode shuts this plugin's location down (`location.shutdown`, emitted by
 * an evict or `location.reload` before it answers). OpenCode closes the location's scope, and so this
 * plugin, only after the last running step lets go; a child held mid-turn would keep the retired
 * generation open and its rows resident. Returns the watch's stop. */
export function watchLocationShutdown(host: ShutdownHost, onShutdown: () => Promise<void>): () => void {
  const stop = new AbortController()
  void (async () => {
    let shutdown = false
    try {
      for await (const event of host.event.subscribe({ types: ["location.shutdown"], signal: stop.signal })) {
        if (event.type !== "location.shutdown" || !sameLocation(event.location, host.location)) continue
        shutdown = true
        break
      }
    } catch (error) {
      if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] location shutdown watch failed; the host close still parks children", error)
      return
    }
    if (!shutdown || stop.signal.aborted) return
    stop.abort()
    await onShutdown().catch((error: unknown) => {
      console.error("[oh-my-openagent/v2] Native task park on location shutdown failed; the host close retries it", error)
    })
  })()
  return () => stop.abort()
}
