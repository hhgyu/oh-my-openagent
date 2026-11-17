import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { openScriptedSession } from "./split-local-session"

const senpiDist = dirname(fileURLToPath(import.meta.resolve("@code-yeongyu/senpi")))
const fallbackLog = (await import(pathToFileURL(join(senpiDist, "core", "retry-fallback", "log.js")).href)) as {
  settledFallbackLoggers(): Promise<void>
}

describe("split-local scripted session close", () => {
  test("#given the engine's fallback logger still retiring its log generations #when the session closes #then the temp root stays removed after the logger settles", async () => {
    // given
    const realAccess = fsPromises.access
    const access = spyOn(fsPromises, "access").mockImplementation(async (path, mode) => {
      if (String(path).endsWith(".fallback-log-v2")) await new Promise((resolve) => setTimeout(resolve, 300))
      return realAccess(path, mode)
    })
    let root: string | undefined
    try {
      const session = await openScriptedSession("split-local", () => undefined)
      root = dirname(session.cwd)

      // when
      await session.close()
      await fallbackLog.settledFallbackLoggers()

      // then
      expect(existsSync(root)).toBe(false)
    } finally {
      access.mockRestore()
      if (root !== undefined) rmSync(root, { recursive: true, force: true })
    }
  })
})
