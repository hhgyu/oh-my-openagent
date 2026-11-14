import { afterAll, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopEngineReleaseAssetName, getDesktopEngineHost } from "@oh-my-opencode/senpi-desktop-engine"
import { DesktopEngineUnavailableError } from "@oh-my-opencode/senpi-desktop-service"
import { ENGINE_NOT_INSTALLED_ACTION, installedEngineChild, resolveInstalledEngine } from "./engine"

const root = mkdtempSync(join(tmpdir(), "omo-v2-computer-engine-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const platform = "win32"
const arch = "x64"
const host = getDesktopEngineHost(platform, arch)

function home(name: string): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

describe("V2 desktop engine resolution", () => {
  test("#given no Native install #when resolved and spawned #then it refuses with the actionable message and never downloads", async () => {
    // given
    const options = { env: {}, home: home("empty"), platform, arch }

    // when
    const source = resolveInstalledEngine(undefined, options)
    const error = await Promise.resolve(installedEngineChild(undefined, options)()).catch((caught: unknown) => caught)

    // then
    expect(source.kind).toBe("missing")
    expect(error).toBeInstanceOf(DesktopEngineUnavailableError)
    expect((error as Error).message).toContain(ENGINE_NOT_INSTALLED_ACTION)
  })

  test("#given an OmO Native binary runtime #when resolved #then its sidecar engine is chosen, newest version first", () => {
    // given
    const userHome = home("runtime")
    for (const version of ["1.2.0", "1.10.0"]) {
      const runtimeDir = join(userHome, ".omo", "binary-runtime", version)
      mkdirSync(join(runtimeDir, "native", "prebuilds", host), { recursive: true })
      writeFileSync(join(runtimeDir, "package.json"), JSON.stringify({ name: "omo", version }))
      writeFileSync(join(runtimeDir, "native", "prebuilds", host, "senpi-desktop-engine.exe"), "engine")
    }

    // when
    const source = resolveInstalledEngine(undefined, { env: {}, home: userHome, platform, arch })

    // then
    expect(source).toMatchObject({ kind: "runtime", version: "1.10.0" })
  })

  test("#given only Native's verified release cache #when resolved #then the cached generation is chosen", () => {
    // given
    const userHome = home("cache")
    const asset = desktopEngineReleaseAssetName(host)
    if (asset === null) throw Error("no release asset for the test host")
    const bytes = "cached engine"
    const sha = createHash("sha256").update(bytes).digest("hex")
    const generation = join(userHome, ".omo", "cache", "senpi-desktop-engine", "2.0.0", host, `${sha}-${randomUUID()}`)
    mkdirSync(generation, { recursive: true })
    writeFileSync(join(generation, asset), bytes)
    chmodSync(join(generation, asset), 0o755)

    // when
    const source = resolveInstalledEngine(undefined, { env: {}, home: userHome, platform, arch })

    // then
    expect(source).toMatchObject({ kind: "cache", version: "2.0.0", path: join(generation, asset) })
  })

  test("#given computer.engine_path #when it is missing or not a .exe on Windows #then it is refused, and an existing .exe wins", () => {
    // given
    const userHome = home("explicit")
    const exe = join(userHome, "engine.exe")
    const script = join(userHome, "engine.sh")
    writeFileSync(exe, "engine")
    writeFileSync(script, "engine")

    // when
    const found = resolveInstalledEngine(exe, { home: userHome, platform, arch })
    const notExe = resolveInstalledEngine(script, { home: userHome, platform, arch })
    const missing = resolveInstalledEngine(join(userHome, "absent.exe"), { home: userHome, platform, arch })

    // then
    expect(found).toEqual({ kind: "explicit", path: exe })
    expect(notExe.kind === "missing" && notExe.diagnostic.cause).toContain("expected a .exe file")
    expect(missing.kind === "missing" && missing.diagnostic.cause).toContain("missing")
  })
})
