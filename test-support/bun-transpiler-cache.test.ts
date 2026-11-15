import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { pinBunRuntimeTranspilerCache, TEST_TRANSPILER_CACHE_DIRNAME } from "./bun-transpiler-cache"

describe("pinBunRuntimeTranspilerCache", () => {
  test("#given no cache path #when pinned #then the cache sits under the OS temp dir outside any run root", () => {
    // given
    const env: Record<string, string | undefined> = { XDG_CACHE_HOME: "/run/xdg/cache" }

    // when
    pinBunRuntimeTranspilerCache(env, "/os-tmp")

    // then
    expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(join("/os-tmp", TEST_TRANSPILER_CACHE_DIRNAME))
  })

  test.each(["/ci/bun-transpiler-cache", "0", ""])(
    "#given the environment already names %p #when pinned #then it is left unchanged",
    (explicit) => {
      // given
      const env: Record<string, string | undefined> = { BUN_RUNTIME_TRANSPILER_CACHE_PATH: explicit }

      // when
      pinBunRuntimeTranspilerCache(env, "/os-tmp")

      // then
      expect(env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe(explicit)
    },
  )

  test("#given the test preloads ran #when a test starts a bun child #then the child sees the pinned cache path", () => {
    // given
    const pinned = process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH

    // when
    const child = Bun.spawnSync(
      [process.execPath, "--eval", "process.stdout.write(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? '')"],
      {
        stdout: "pipe",
      },
    )

    // then
    expect(pinned).toBeDefined()
    expect(new TextDecoder().decode(child.stdout)).toBe(pinned ?? "")
  })
})
