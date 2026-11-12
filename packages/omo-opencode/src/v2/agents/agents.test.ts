import { describe, expect, it } from "bun:test"
import { join, resolve } from "node:path"
const fixtureHome = resolve("virtual-v2-home")
const fixtureProject = join(fixtureHome, "project")
const fixtureUserConfig = join(fixtureHome, ".omo", "omo.jsonc")
const fixtureProjectConfig = join(fixtureProject, ".omo", "omo.jsonc")

import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { AGENT_DEFINITIONS, AGENT_IDS, applyAgents, loadAgentsConfig, registerAgents } from "./index"
import type { AgentsConfig } from "./config"

import { recordingEditor } from "./test-support"
const emptyConfig: AgentsConfig = { agents: {}, disabled_agents: [] }

function effective(editor: AgentEditor, id: string, action: string, resource = "*") {
  return editor.get(id)?.permissions.findLast((rule) => (rule.action === "*" || rule.action === action) && (rule.resource === "*" || rule.resource === resource))?.effect
}

describe("native v2 agents", () => {
  it("upserts all 11 roles, preserves builtin data and reapplies idempotently", () => {
    const { editor, entries } = recordingEditor()
    const build = structuredClone(entries.get("build"))
    applyAgents(editor, emptyConfig)
    const first = structuredClone([...entries])
    applyAgents(editor, emptyConfig)
    expect([...entries]).toEqual(first)
    expect(entries.get("build")).toEqual({ ...build, hidden: true, mode: "subagent" })
    expect(AGENT_IDS).toHaveLength(11)
    for (const id of AGENT_IDS) {
      expect(editor.get(id)?.system?.length).toBeGreaterThan(450)
      expect(editor.get(id)?.system).toContain("Use only tools exposed in this session")
    }
    expect(editor.get("explore")?.mode).toBe("subagent")
    expect(editor.get("sisyphus")?.mode).toBe("primary")
  })

  it("hides builtin build, builder and plan from the picker while keeping their dispatch entries", () => {
    const { editor } = recordingEditor()
    editor.update("builder", () => {})
    editor.update("plan", () => {})
    editor.update("custom-host", () => {})
    let defaultChanges = 0
    editor.default = () => { defaultChanges++ }
    applyAgents(editor, emptyConfig)
    expect(defaultChanges).toBe(0)
    for (const id of ["build", "builder", "plan"]) {
      expect(editor.get(id)?.hidden).toBe(true)
      expect(editor.get(id)?.mode).toBe("subagent")
    }
    expect(editor.get("custom-host")?.hidden).toBe(false)
    expect(editor.get("sisyphus")?.hidden).toBe(false)
    expect(editor.get("prometheus")?.hidden).toBe(false)
    expect(editor.list().filter((agent) => !agent.hidden).map((agent) => agent.id)).not.toContain("build")
  })

  it("retains builtin fallback visibility when corresponding OmO replacements are disabled", () => {
    const { editor } = recordingEditor()
    editor.update("plan", () => {})
    applyAgents(editor, { agents: {}, disabled_agents: [...AGENT_IDS] })
    expect(editor.get("build")?.hidden).toBe(false)
    expect(editor.get("plan")?.hidden).toBe(false)
    expect(editor.get("build")?.mode).toBe("primary")
    expect(editor.get("plan")?.mode).toBe("primary")
    expect(editor.list().filter(agent => !agent.hidden)).toHaveLength(2)
  })

  it("uses only selectable enabled replacements to decide builtin visibility", () => {
    const disabled = ["hephaestus", "atlas"]
    const { editor } = recordingEditor()
    editor.update("plan", () => {})
    applyAgents(editor, { agents: { sisyphus: { mode: "subagent" }, prometheus: { disable: true } }, disabled_agents: disabled })
    expect(editor.get("build")?.hidden).toBe(false)
    expect(editor.get("plan")?.hidden).toBe(false)
    const promoted = recordingEditor().editor
    applyAgents(promoted, { agents: { sisyphus: { mode: "subagent" }, oracle: { mode: "primary" } }, disabled_agents: disabled })
    expect(promoted.get("build")?.hidden).toBe(true)
  })

  it("applies model, model-chain primary, prompt, name and permission overrides", () => {
    const { editor } = recordingEditor()
    applyAgents(editor, { agents: {
      sisyphus: { model: "mock/primary#low", reasoning: "high", prompt: "custom system", prompt_append: "extra", displayName: "My Builder", permission: { bash: { "git *": "allow", "rm *": "deny" } }, permissions: [{ action: "webfetch", resource: "*", effect: "deny" }] },
      hephaestus: { model: "mock/ignored", models: [{ model: "mock/chain", reasoning: "medium" }] },
    }, disabled_agents: [] })
    expect(editor.get("sisyphus")?.model).toEqual({ providerID: "mock", id: "primary", variant: "high" })
    expect(editor.get("sisyphus")?.system).toBe("custom system\n\nextra")
    expect(editor.get("sisyphus")?.name).toBe("My Builder")
    expect(effective(editor, "sisyphus", "bash", "rm *")).toBe("deny")
    expect(effective(editor, "sisyphus", "webfetch")).toBe("deny")
    expect(editor.get("hephaestus")?.model).toEqual({ providerID: "mock", id: "chain", variant: "medium" })
  })

  it("inherits the host model and applies reasoning without forcing a model default", () => {
    const { editor } = recordingEditor()
    editor.update("oracle", (agent) => { agent.model = { providerID: "mock" as NonNullable<typeof agent.model>["providerID"], id: "inherited" as NonNullable<typeof agent.model>["id"], variant: "low" as NonNullable<typeof agent.model>["variant"] } })
    applyAgents(editor, { agents: { oracle: { reasoning: "high" } }, disabled_agents: [] })
    expect(editor.get("oracle")?.model).toEqual({ providerID: "mock", id: "inherited", variant: "high" })
    expect(editor.get("sisyphus")?.model).toBeUndefined()
  })

  it("keeps all agents registered when one configured model reference is malformed", () => {
    const { editor } = recordingEditor()
    applyAgents(editor, { agents: { oracle: { model: "not-provider-qualified" } }, disabled_agents: [] })
    expect(editor.get("oracle")?.model).toBeUndefined()
    for (const id of AGENT_IDS) expect(editor.get(id)).toBeDefined()
  })
  it("removes disabled OmO agents but preserves an unrelated host id in the denylist", () => {
    const { editor } = recordingEditor()
    applyAgents(editor, emptyConfig)
    applyAgents(editor, { agents: { oracle: { disable: true } }, disabled_agents: ["explore", "build"] })
    expect(editor.get("explore")).toBeUndefined()
    expect(editor.get("oracle")).toBeUndefined()
    expect(editor.get("build")).toBeDefined()
  })

  it("enforces role restrictions after broad user allowances", () => {
    const { editor } = recordingEditor()
    applyAgents(editor, { agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { permission: { "*": "allow", edit: "allow", bash: "allow" }, tools: { edit: true } }])), disabled_agents: [] })
    for (const id of ["oracle", "explore", "librarian", "metis", "momus", "multimodal-looker", "prometheus"]) {
      expect(effective(editor, id, "edit")).toBe("deny")
      expect(effective(editor, id, "bash")).toBe("deny")
      expect(effective(editor, id, "task")).toBe("deny")
      expect(effective(editor, id, "subagent")).toBe("deny")
    }
    expect(effective(editor, "prometheus", "edit", "**/.omo/plans/*.md")).toBe("allow")
    expect(effective(editor, "sisyphus-junior", "task")).toBe("deny")
  })

  it("denies native shell for read-only roles even after user shell allowances", () => {
    const { editor } = recordingEditor()
    applyAgents(editor, { agents: Object.fromEntries(AGENT_IDS.map((id) => [id, { permission: { "*": "allow", bash: "allow", shell: "allow" }, tools: { bash: true, shell: true } }])), disabled_agents: [] })
    for (const id of ["oracle", "explore", "librarian", "metis", "momus", "multimodal-looker", "prometheus"]) expect(effective(editor, id, "shell")).toBe("deny")
    expect(effective(editor, "prometheus", "edit", "**/.omo/plans/*.md")).toBe("allow")
  })

  it("exposes only curated broker defaults before user rules, never overriding a user deny", () => {
    // given a host wildcard deny for each Native curated identity
    for (const id of ["explore", "librarian", "plan-consultant", "plan-reviewer"]) for (const userDeny of [false, true]) {
      const { editor } = recordingEditor()
      editor.update(id, agent => { agent.permissions = [{ action: "*", resource: "*", effect: "deny" }] })
      // when OmO registers the real child agent with or without an explicit user restriction
      applyAgents(editor, { agents: { [id]: userDeny ? { permission: { omo_native_readonly: "deny", omo_native_ls: "deny" } } : {} }, disabled_agents: [] })
      // then stock mutation remains denied and user broker denies win over plugin defaults
      expect(effective(editor, id, "omo_native_readonly")).toBe(userDeny ? "deny" : "allow")
      expect(effective(editor, id, "omo_native_ls")).toBe(userDeny ? "deny" : "allow")
      expect(effective(editor, id, "shell")).toBe("deny")
      expect(effective(editor, id, "edit")).toBe("deny")
    }
  })

  it("keeps Native-only builtins and custom identities out of the primary picker while preserving custom denies", () => {
    // given an enabled custom Native persona with a host-only primary-mode override
    const { editor } = recordingEditor()
    applyAgents(editor, { agents: { "custom-auditor": { mode: "primary", permission: { read: "deny" } } }, disabled_agents: [],
      nativeAgents: { "custom-auditor": { tools: { read: true } }, "disabled-custom": { disable: true } } })
    // then the actual registrar creates callable subagent identities, not new primary choices
    for (const id of ["plan-consultant", "plan-reviewer", "omo-native-code-reviewer", "omo-native-qa-executor", "omo-native-gate-reviewer", "custom-auditor"]) {
      expect(editor.get(id)?.mode).toBe("subagent")
      expect(editor.get(id)?.hidden).toBe(true)
    }
    expect(editor.get("disabled-custom")).toBeUndefined()
    expect(effective(editor, "custom-auditor", "read")).toBe("deny")
    expect(editor.get("sisyphus")?.mode).toBe("primary")
    expect(editor.get("sisyphus")?.hidden).toBe(false)
  })

  it("projects legacy tool permissions onto native shell, edit and subagent actions", () => {
    const overrides = [
      { permission: { bash: "deny" as const } },
      { tools: { bash: false } },
      { disallowed_tools: ["bash"] },
      { permissions: [{ action: "bash", resource: "echo *", effect: "deny" as const }] },
    ]
    for (const override of overrides) {
      const { editor } = recordingEditor()
      applyAgents(editor, { agents: { sisyphus: override }, disabled_agents: [] })
      expect(effective(editor, "sisyphus", "shell", "echo *")).toBe("deny")
    }
    for (const alias of ["write", "apply_patch", "patch"]) {
      const { editor } = recordingEditor()
      applyAgents(editor, { agents: { sisyphus: { disallowed_tools: [alias] } }, disabled_agents: [] })
      expect(effective(editor, "sisyphus", "edit")).toBe("deny")
    }
    const { editor } = recordingEditor()
    applyAgents(editor, { agents: { sisyphus: { permission: { task: "deny" } } }, disabled_agents: [] })
    expect(effective(editor, "sisyphus", "subagent")).toBe("deny")
  })

  it("rereads config on host replay and disposes its registration", async () => {
    let callback: ((editor: AgentEditor) => void) | undefined
    let disposed = false
    let disabled = false
    const options = { cwd: fixtureProject, env: { HOME: fixtureHome }, platform: "linux" as const, fileSystem: {
      existsSync: (path: string) => path === fixtureUserConfig,
      readFileSync: () => JSON.stringify({ "[opencode]": { disabled_agents: disabled ? ["oracle"] : [] } }),
    } }
    const cleanup = await registerAgents({ transform: async (fn) => { callback = fn; return { dispose: async () => { disposed = true } } } }, options)
    const { editor } = recordingEditor()
    callback?.(editor)
    expect(editor.get("oracle")).toBeDefined()
    disabled = true
    callback?.(editor)
    expect(editor.get("oracle")).toBeUndefined()
    await cleanup()
    expect(disposed).toBe(true)
  })
})

describe("unified native agents config", () => {
  it("merges global/project layers, OpenCode blocks and selected profiles with core catalog resolution", () => {
    const files: Record<string, string> = {
      [fixtureUserConfig]: JSON.stringify({ agents: { sisyphus: { prompt: "global" } }, models: { chosen: { model: "mock/catalog", reasoning: "high" } }, "[opencode]": { agents: { sisyphus: { displayName: "Global Name", permission: { edit: "deny" } } }, disabled_agents: ["explore"] } }),
      [fixtureProjectConfig]: JSON.stringify({ agents: { sisyphus: { model: "chosen", prompt: "project" } }, "[opencode]": { agents: { sisyphus: { displayName: "Project Name" } } }, profiles: { test: { "[opencode]": { agents: { sisyphus: { prompt_append: "profile" } } } } } }),
    }
    const config = loadAgentsConfig({ cwd: fixtureProject, env: { HOME: fixtureHome, OMO_PROFILE: "test" }, platform: "linux", fileSystem: {
      existsSync: (path) => path in files, readFileSync: (path) => files[path],
    } })
    expect(config.agents.sisyphus).toMatchObject({ prompt: "project", model: "mock/catalog", reasoning: "high", displayName: "Project Name", prompt_append: "profile", permission: { edit: "deny" } })
    expect(config.disabled_agents).toEqual(["explore"])
  })

  it("keeps valid agents when another OpenCode override is invalid", () => {
    const config = loadAgentsConfig({ cwd: fixtureProject, env: { HOME: fixtureHome }, platform: "linux", fileSystem: {
      existsSync: (path) => path === fixtureUserConfig,
      readFileSync: () => JSON.stringify({ "[opencode]": { agents: { oracle: { model: 4 }, explore: { prompt: "valid" } } } }),
    } })
    expect(config.agents.oracle).toBeUndefined()
    expect(config.agents.explore?.prompt).toBe("valid")
    expect(AGENT_DEFINITIONS.every((agent) => agent.system.length > 450)).toBe(true)
  })
})
