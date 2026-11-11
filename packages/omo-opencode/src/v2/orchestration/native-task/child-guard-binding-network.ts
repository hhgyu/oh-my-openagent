import type { ChildGuardBinding, OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { PreparedHostTaskGrant } from "./host-grant"

/** The Native names the host grant maps onto the one stock host `webfetch` tool. */
const WEBFETCH_NATIVE_NAMES: ReadonlySet<string> = new Set(["webfetch", "web_fetch"])

/** Port of Native `validateUrl` (senpi `webfetch/fetcher.js` 32-42): an `http://` or `https://`
 * prefix and a parseable URL. Native has no host allow or deny list and issues GET only; the guard
 * enforces the method and the user's own `webfetch` permission rules decide each URL. */
function nativeAllowsGet(url: string): boolean {
  return (url.startsWith("http://") || url.startsWith("https://")) && URL.canParse(url)
}

/** The CodeMode `fetch` GET grant of a child whose approved selection includes Native `webfetch`.
 * Undefined (the guard's deny-all) when `webfetch` is not selected, when its names resolve to more
 * than one host tool, or when the guard holds no pre-wrap original for that host tool. */
export function webfetchNetworkFor(selection: PreparedHostTaskGrant, guard: OwnedChildToolGuard, assertCurrent: () => void): ChildGuardBinding["network"] {
  const hostIDs = new Set(selection.selected.filter(pair => WEBFETCH_NATIVE_NAMES.has(pair.nativeName)).map(pair => pair.hostID))
  const [hostID] = hostIDs
  if (hostIDs.size !== 1 || hostID === undefined) return undefined
  const intrinsicGetOriginal = guard.intrinsicGetOriginal(hostID)
  if (!intrinsicGetOriginal) return undefined
  return { hostID, assertCurrent, allowsGet: nativeAllowsGet, intrinsicGetOriginal }
}
