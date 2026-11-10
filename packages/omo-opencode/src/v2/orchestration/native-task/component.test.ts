import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHILD_HOST_TOOLS, childStructuralToolNames } from "@oh-my-opencode/senpi-task/task-operations"
import { CHILD_HOST_TOOLS as ORIGINAL_CHILD_HOST_TOOLS, childStructuralToolNames as originalChildStructuralToolNames } from "../../../../../senpi-task/src/runners/in-process/host-tools"
import { bumpTaskId, createTaskId } from "../../../../../senpi-task/src/state/id"
import type { ListedTool } from "../../host/tool-registry"
import { nativeTaskEnabled } from "../../index"
import { childCatalog, nativeTaskStateDir, seedTaskIdFloor } from "./component"

const tool = (id: string, name: string, options?: ListedTool["options"]) => ({ id, name, description: id, ...(options ? { options } : {}) }) as unknown as ListedTool

describe("#given the actual SDK catalog", () => {
  test("#then only unnamespaced child grant candidates remain", () => {
    // given
    const catalog = [tool("read", "read", { codemode: false }), tool("shell", "shell"), tool("browser_click", "click", { namespace: "browser" }),
      tool("subagent", "subagent"), tool("execute", "execute"), tool("public-task", "task"), tool("public-output", "task_output")]
    // when
    const ids = childCatalog(catalog).map(item => item.id)
    // then
    expect(ids).toEqual(["read", "shell"])
  })
})

describe("#given a parent session", () => {
  test("#then each parent gets a distinct state directory under the project .omo", () => {
    // when
    const first = nativeTaskStateDir("/project", "ses_a"), second = nativeTaskStateDir("/project", "ses_b")
    // then
    expect(first.startsWith(join("/project", ".omo", "tasks", "opencode-v2"))).toBe(true)
    expect(first).not.toBe(second)
    expect(nativeTaskStateDir("/project", "ses_a")).toBe(first)
  })
})

describe("#given plugin options", () => {
  test("#then the Native task component is enabled unless explicitly disabled", () => {
    expect(nativeTaskEnabled(undefined)).toBe(true)
    expect(nativeTaskEnabled({})).toBe(true)
    expect(nativeTaskEnabled({ "omo-native-task-enabled": false })).toBe(false)
  })
})

describe("#given the Native child host-tool table", () => {
  test("#then task-operations reexports the SAME original definitions", () => {
    expect(CHILD_HOST_TOOLS).toBe(ORIGINAL_CHILD_HOST_TOOLS)
    expect(childStructuralToolNames).toBe(originalChildStructuralToolNames)
  })
})

describe("#given task records already held by other parents of this project", () => {
  test("#then the next issued id is above every existing parent store id", () => {
    // given
    const project = mkdtempSync(join(tmpdir(), "omo-v2-id-floor-"))
    try {
      // Just above the current process floor, so the global floor is not pushed far for other tests.
      const highest = bumpTaskId(bumpTaskId(bumpTaskId(createTaskId())))
      const ids = [bumpTaskId(createTaskId()), highest]
      ids.forEach((id, index) => {
        const tasks = join(nativeTaskStateDir(project, `ses_parent_${index}`), "tasks")
        mkdirSync(tasks, { recursive: true })
        writeFileSync(join(tasks, `${id}.json`), "{}")
      })
      // when
      seedTaskIdFloor(project)
      const next = createTaskId()
      // then
      expect(next > highest).toBe(true)
    } finally { rmSync(project, { recursive: true, force: true }) }
  })
})
