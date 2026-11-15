import { describe, expect, test } from "bun:test"
import { delimiter, join, resolve } from "node:path"
import { resolveSenpiBin } from "./senpi-bin-resolution.mjs"

describe("resolveSenpiBin", () => {
  describe("#given a Windows PATH that only holds an npm/bun launcher with an extension", () => {
    test("#when resolving the default senpi name #then PATHEXT finds senpi.exe", () => {
      // given
      const binDir = resolve("fake-bin")
      const launcher = join(binDir, "senpi.EXE")
      const env = { PATH: [resolve("empty"), binDir].join(delimiter), PATHEXT: ".COM;.EXE;.CMD" }

      // when
      const resolved = resolveSenpiBin({
        env,
        cwd: resolve("project"),
        platform: "win32",
        exists: (path) => path === launcher,
      })

      // then
      expect(resolved).toBe(launcher)
    })
  })

  describe("#given the same PATH on a POSIX platform", () => {
    test("#when resolving #then no extension is appended", () => {
      // given
      const binDir = resolve("fake-bin")
      const env = { PATH: binDir, PATHEXT: ".EXE" }

      // when
      const resolved = resolveSenpiBin({
        env,
        cwd: resolve("project"),
        platform: "linux",
        exists: (path) => path === join(binDir, "senpi.EXE"),
      })

      // then
      expect(resolved).toBeNull()
    })
  })

  describe("#given SENPI_BIN names a path without its Windows extension", () => {
    test("#when resolving #then the extension-qualified file is returned", () => {
      // given
      const requested = resolve("tools", "senpi")

      // when
      const resolved = resolveSenpiBin({
        env: { SENPI_BIN: requested, PATHEXT: ".EXE" },
        cwd: resolve("project"),
        platform: "win32",
        exists: (path) => path === `${requested}.EXE`,
      })

      // then
      expect(resolved).toBe(`${requested}.EXE`)
    })
  })

  describe("#given the project's node_modules/.bin holds senpi", () => {
    test("#when PATH lacks it #then the project-local binary is used", () => {
      // given
      const cwd = resolve("project")
      const local = join(cwd, "node_modules", ".bin", "senpi")

      // when
      const resolved = resolveSenpiBin({ env: { PATH: "" }, cwd, platform: "linux", exists: (path) => path === local })

      // then
      expect(resolved).toBe(local)
    })
  })
})
