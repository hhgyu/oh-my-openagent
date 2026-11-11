// Which providers the user chose, for the non-explicit reflection model rungs (`reflection-model.ts`).
// Native ranks only models the Senpi registry reports available, i.e. providers the user holds
// credentials for. OpenCode 2 also lists built-in providers the user never set up: its `opencode`
// provider is `activation: "enabled"` with free models and zero connections on a fresh install, so the
// model catalog alone cannot tell "the user chose this provider" apart from "the host ships it".
// The signal is the host's own provider/integration records (`provider.list` + `integration.list`):
// - a listed provider WITH an `integrationID` (a host-catalog provider) counts only when that
//   integration has at least one connection: a stored credential (key, OAuth, external) or a detected
//   environment variable (`IntegrationInfo.connections`);
// - a listed provider WITHOUT an `integrationID` was declared outside the host catalog, by the user's
//   OpenCode config `providers` block (or a plugin the user installed), and counts.
// A config override of a host-catalog provider that carries no connection does not count; the user
// can still name its models explicitly (`categories.<name>`). Missing domains or a failed read yield
// the empty set: the non-explicit rungs then offer nothing, never a provider the user did not choose.

import type { IntegrationDomain } from "@opencode/plugin/promise/integration"
import type { ProviderDomain } from "@opencode/plugin/promise/provider"

export type ProviderConsentDomains = {
  readonly provider?: Pick<ProviderDomain, "list">
  readonly integration?: Pick<IntegrationDomain, "list">
}

/** Provider ids the user configured or authenticated, from the live host records. */
export async function consentedProviders(domains: ProviderConsentDomains, warn?: (message: string, details?: Record<string, unknown>) => void): Promise<ReadonlySet<string>> {
  const { provider, integration } = domains
  if (provider === undefined || integration === undefined) return new Set()
  try {
    const [providers, integrations] = await Promise.all([provider.list(), integration.list()])
    const connected = new Set(integrations.data.filter(entry => entry.connections.length > 0).map(entry => entry.id))
    return new Set(providers.data
      .filter(entry => entry.integrationID === undefined || connected.has(entry.integrationID))
      .map(entry => entry.id))
  } catch (error) {
    warn?.("memory reflection could not read provider connections; only explicit and session models are eligible", { error: error instanceof Error ? error.message : String(error) })
    return new Set()
  }
}
