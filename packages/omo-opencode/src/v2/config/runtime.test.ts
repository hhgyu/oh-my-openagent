import { describe, expect, it } from "bun:test"
import { join, resolve } from "node:path"
import { loadRuntimeConfig } from "./runtime"
import { loadAgentsConfig } from "../agents/config"
import { agentOverrideSchema } from "./agent-overrides"

const home = resolve("virtual-f07-home")
const cwd = join(home, "project")
const user = join(home, ".omo", "omo.jsonc")
const project = join(cwd, ".omo", "omo.jsonc")
function fixture(files: Record<string, unknown>, profile?: string) {
  const reads: string[] = []
  return {
    reads,
    options: {
      cwd,
      env: { HOME: home },
      platform: "linux" as const,
      profile,
      fileSystem: {
        existsSync: (path: string) => Object.hasOwn(files, path),
        readFileSync: (path: string) => {
          reads.push(path)
          return JSON.stringify(files[path])
        },
      },
    },
  }
}

describe("OpenCode runtime config snapshot", () => {
  it("retains the entire common config and expands model references outside agents", () => {
    const input = fixture({
      [user]: {
        models: { chosen: { model: "mock/current", reasoning: "high" } },
        categories: { quick: { model: "chosen", models: ["chosen"] } },
        model_profiles: { daily: { models: ["chosen"] } },
        model_profile: "daily",
        memory: { enabled: false },
        task: { default_concurrency: 3 },
        disabled_skills: ["unsafe"],
        exclude_models: ["blocked/*"],
        provenance: { workspaces: [{ name: "safe", paths: ["project"] }] },
        "[opencode]": {
          agents: {
            explore: {
              displayName: "Scout",
              permissions: [{ action: "shell", resource: "*", effect: "deny" }],
              model: "chosen",
            },
          },
        },
      },
    })
    expect(input.reads).toEqual([])
    const snapshot = loadRuntimeConfig(input.options)
    expect(snapshot.config.categories?.quick).toMatchObject({
      model: "mock/current",
      reasoning: "high",
      models: [{ model: "mock/current", reasoning: "high" }],
    })
    expect(snapshot.config.model_profiles?.daily.models).toEqual([{ model: "mock/current", reasoning: "high" }])
    expect(snapshot.config.model_profile).toBe("daily")
    expect(snapshot.config.memory?.enabled).toBe(false)
    expect(snapshot.config.task?.default_concurrency).toBe(3)
    expect(snapshot.config.disabled_skills).toEqual(["unsafe"])
    expect(snapshot.config.exclude_models).toEqual(["blocked/*"])
    expect(snapshot.config.provenance?.workspaces?.[0].name).toBe("safe")
    expect(snapshot.agents.agents.explore).toMatchObject({
      displayName: "Scout",
      model: "mock/current",
      reasoning: "high",
      permissions: [{ action: "shell", resource: "*", effect: "deny" }],
    })
    expect(input.reads).toEqual([user])
    expect(snapshot.sources.find((source) => source.path === user)).toMatchObject({ loaded: true, scope: "user" })
    expect(snapshot.layers).toHaveLength(1)
  })

  it("preserves old host merge/profile/variant behavior and separates common config", () => {
    const input = fixture(
      {
        [user]: {
          models: { chosen: { model: "mock/catalog", reasoning: "medium" } },
          memory: { enabled: true },
          agents: { explore: { model: "chosen", prompt: "user" } },
          "[opencode]": {
            agents: {
              explore: { displayName: "User", permissions: [{ action: "read", resource: "*", effect: "allow" }] },
            },
          },
        },
        [project]: {
          agents: { explore: { prompt: "project" } },
          "[opencode]": { agents: { explore: { displayName: "Project" } } },
          profiles: {
            selected: {
              memory: { enabled: false },
              "[opencode]": {
                agents: { explore: { prompt_append: "profile", variant: "high" } },
                disabled_agents: ["oracle"],
              },
            },
          },
        },
      },
      "selected",
    )
    const snapshot = loadRuntimeConfig(input.options)
    expect(snapshot.profile).toBe("selected")
    expect(snapshot.config.memory?.enabled).toBe(false)
    expect(snapshot.agents.agents.explore).toMatchObject({
      model: "mock/catalog",
      reasoning: "high",
      variant: "high",
      prompt: "project",
      prompt_append: "profile",
      displayName: "Project",
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    })
    expect(loadAgentsConfig(input.options)).toEqual(snapshot.agents)
    expect(snapshot.agents.disabled_agents).toEqual(["oracle"])
    expect(snapshot.config.agents?.explore).not.toHaveProperty("displayName")
  })

  it("retains diagnostics, valid siblings and null-prototype host map without logging values", () => {
    const input = fixture(
      {
        [user]: JSON.parse(
          '{"[opencode]":{"agents":{"__proto__":{"prompt":"bad"},"constructor":{"prompt":"bad"},"oracle":{"model":4},"explore":{"prompt":"valid"}}}}',
        ),
      },
      "absent",
    )
    const snapshot = loadRuntimeConfig(input.options)
    expect(snapshot.profile).toBeUndefined()
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.kind === "profile")).toBe(true)
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.path === "agents.oracle")).toBe(true)
    expect(snapshot.agents.agents.explore?.prompt).toBe("valid")
    expect(Object.keys(snapshot.agents.agents)).toEqual(["explore"])
    expect(Object.getPrototypeOf(snapshot.agents.agents)).toBeNull()
    expect({}).not.toHaveProperty("prompt")
    expect(agentOverrideSchema.safeParse({ model: 4 }).success).toBe(false)
    expect(
      agentOverrideSchema.safeParse({ permissions: [{ action: "read", resource: "*", effect: "deny" }] }).success,
    ).toBe(true)
  })

  it("rereads independent snapshots without mutating caller fixtures", () => {
    const files = { [user]: { memory: { enabled: false } } }
    const input = fixture(files)
    const before = JSON.stringify(files)
    const first = loadRuntimeConfig(input.options)
    expect(first.config.memory?.enabled).toBe(false)
    expect(JSON.stringify(files)).toBe(before)
    files[user].memory.enabled = true
    expect(loadRuntimeConfig(input.options).config.memory?.enabled).toBe(true)
    expect(first.config.memory?.enabled).toBe(false)
    expect(input.reads).toEqual([user, user])
  })
})
