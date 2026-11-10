import { DEFAULT_MODEL_PROFILE_ORDER } from "./builtin-profiles"
import type { ModelProfileResolution } from "./resolve"

/**
 * The unset default (#10029): tries each lane in `DEFAULT_MODEL_PROFILE_ORDER` through the
 * caller's resolver (which probes credentials) and returns the first that resolves. When none
 * does, the first lane's result is returned, so the notice names Daily · Normal.
 */
export async function resolveDefaultModelProfile<T extends { readonly resolution: ModelProfileResolution }>(
  resolveFor: (profileId: string) => Promise<T>,
): Promise<T> {
  const [first, ...rest] = DEFAULT_MODEL_PROFILE_ORDER
  const primary = await resolveFor(first)
  if (primary.resolution.kind === "resolved") return primary
  for (const profileId of rest) {
    const candidate = await resolveFor(profileId)
    if (candidate.resolution.kind === "resolved") return candidate
  }
  return primary
}
