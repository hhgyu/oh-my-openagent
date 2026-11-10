import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { resolveSafeMemoryRoot } from "./config"
import { registerMemoryComponent } from "./index"
import { createMemoryFixture } from "./test-support"

// Security contract (root AGENTS.md, #9727): the memory root may never be the OmO home or sit inside
// the desktop app's reserved ~/.omo entries.
describe("resolveSafeMemoryRoot", () => {
  const home = join("/", "users", "someone")
  test.each([
    ["default ~/.omo/memory", undefined, true],
    ["explicit outside home", join("/", "srv", "memory"), true],
    ["~/.omo itself", join(home, ".omo"), false],
    ["~/.omo/desktop", join(home, ".omo", "desktop"), false],
    ["under ~/.omo/desktop", join(home, ".omo", "desktop", "memory"), false],
    ["~/.omo/desktop.init-1", join(home, ".omo", "desktop.init-1", "x"), false],
    ["sibling ~/.omo/memory-desktop", join(home, ".omo", "memory-desktop"), true],
  ])("#given %s #then ok is %p", (_label, override, ok) => {
    // given
    const env = { OMO_MEMORY_HOME: override }
    // when
    const decision = resolveSafeMemoryRoot(env, home, home)
    // then
    expect(decision.ok).toBe(ok)
  })
})

describe("memory component with an unsafe root", () => {
  const fixtures: ReturnType<typeof createMemoryFixture>[] = []
  afterEach(() => { for (const created of fixtures.splice(0)) created.cleanup() })

  test("#given OMO_MEMORY_HOME under ~/.omo/desktop #when the root session writes #then the write is refused and nothing is created", async () => {
    // given
    const f = createMemoryFixture()
    fixtures.push(f)
    f.addSession("root")
    const reserved = join(f.home, ".omo", "desktop", "memory")
    const cleanup = await registerMemoryComponent(f.host, f.options({ env: { OMO_MEMORY_HOME: reserved } }))
    // when
    const write = f.runTool("memory", "root", { command: "create", reason: "r", file_path: "system/a.md", description: "Notes", file_text: "x" })
    // then
    await expect(write).rejects.toBeInstanceOf(ToolError)
    expect(existsSync(join(f.home, ".omo"))).toBe(false)
    await cleanup()
  })
})
