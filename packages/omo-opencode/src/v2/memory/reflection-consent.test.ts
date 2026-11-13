import { describe, expect, test } from "bun:test"
import { consentedProviders, type ProviderConsentDomains } from "./reflection-consent"

type ProviderRow = { readonly id: string; readonly integrationID?: string }
type IntegrationRow = { readonly id: string; readonly connections: readonly { readonly type: string }[] }

// The host records carry more fields; consent reads only ids, `integrationID` and `connections`.
function domains(
  providers: readonly ProviderRow[],
  integrations: readonly IntegrationRow[],
): Required<ProviderConsentDomains> {
  return {
    provider: { list: async () => ({ data: providers }) },
    integration: { list: async () => ({ data: integrations }) },
  } as unknown as Required<ProviderConsentDomains>
}

// Shape observed on the real OpenCode 2.2.6 host: built-in `opencode` (no connection), env-keyed
// `anthropic`, and a config-declared `qa-local` provider with no integration link.
const PROVIDERS: readonly ProviderRow[] = [
  { id: "opencode", integrationID: "opencode" },
  { id: "anthropic", integrationID: "anthropic" },
  { id: "qa-local" },
]
const INTEGRATIONS: readonly IntegrationRow[] = [
  { id: "opencode", connections: [] },
  { id: "anthropic", connections: [{ type: "env" }] },
  { id: "qa-local", connections: [] },
]

describe("reflection provider consent", () => {
  test("#given a built-in provider without a connection #when consent is read #then only connected and config-declared providers count", async () => {
    // given
    const host = domains(PROVIDERS, INTEGRATIONS)
    // when
    const consented = await consentedProviders(host)
    // then
    expect([...consented].sort()).toEqual(["anthropic", "qa-local"])
  })

  test("#given a stored credential on the built-in provider #when consent is read #then it counts", async () => {
    // given
    const host = domains(PROVIDERS, [
      { id: "opencode", connections: [{ type: "credential" }] },
      ...INTEGRATIONS.slice(1),
    ])
    // when
    const consented = await consentedProviders(host)
    // then
    expect(consented.has("opencode")).toBe(true)
  })

  test("#given no integration domain or a failing read #when consent is read #then nothing counts and the failure is reported", async () => {
    // given
    const warnings: string[] = []
    const failing = {
      ...domains(PROVIDERS, INTEGRATIONS),
      integration: {
        list: async () => {
          throw new Error("offline")
        },
      },
    } as unknown as ProviderConsentDomains
    // when
    const missing = await consentedProviders({ provider: domains(PROVIDERS, INTEGRATIONS).provider })
    const failed = await consentedProviders(failing, (message) => {
      warnings.push(message)
    })
    // then
    expect(missing.size).toBe(0)
    expect(failed.size).toBe(0)
    expect(warnings).toHaveLength(1)
  })
})
