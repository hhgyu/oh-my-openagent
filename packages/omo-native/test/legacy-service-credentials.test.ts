import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { remainingTestTime } from "../../../test-support/test-deadline"
import { removeLegacyServiceCredentials } from "../bin/lib/legacy-service-credentials.js"

const homes: string[] = []
const RUNTIME_READY = "[startup-phase] runtime ready"

// Bounded below the test's own budget so a stalled child is stopped here, with its output and the startup phase it
// reached, instead of being reaped as a dangling process after the test already timed out (run 45432342382).
function runFirstCommand(entry: string, args: readonly string[], env: NodeJS.ProcessEnv, home: string, legacy: string) {
  const preload = join(home, "startup-phase.preload.ts")
  writeFileSync(preload, `process.stderr.write(${JSON.stringify(`${RUNTIME_READY}\n`)})\n`)
  const bound = Math.max(1, Math.floor(remainingTestTime()))
  const result = spawnSync(process.execPath, ["--preload", preload, join(import.meta.dir, "..", entry), ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: bound,
    killSignal: "SIGKILL",
  })
  if (result.error === undefined) return
  const phase = !result.stderr?.includes(RUNTIME_READY)
    ? "before the bun runtime ran any JavaScript"
    : existsSync(legacy)
      ? "after the runtime started and before main() removed the legacy file (loading the entry's imports)"
      : "after main() removed the legacy file"
  throw new Error(
    `${entry} ${args.join(" ")} was stopped at its ${bound} ms bound (${result.error.message}, signal ${String(result.signal)}); it stalled ${phase}\nstderr:\n${result.stderr ?? ""}\nstdout:\n${result.stdout ?? ""}`,
  )
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function homeWith(content?: string): { home: string; path: string } {
  const home = mkdtempSync(join(tmpdir(), "omo-legacy-creds-"))
  homes.push(home)
  mkdirSync(join(home, ".omo"), { recursive: true })
  const path = join(home, ".omo", "credentials.json")
  if (content !== undefined) writeFileSync(path, content, { mode: 0o644 })
  return { home, path }
}

const LEGACY = JSON.stringify({
  accessToken: "synthetic-access",
  accessTokenExpiresAt: "2026-10-10T00:00:00.000Z",
  device: { id: "synthetic-device", name: "synthetic" },
  offlineGrant: "synthetic-grant",
  refreshToken: "synthetic-refresh",
  sealingPrivateKey: "synthetic-sealing-private",
  signingPrivateKey: "synthetic-signing-private",
})

// The #10697 plaintext file holds a refresh token and both private keys: it must be gone after ANY first command
// after upgrading, including the hidden verbs a host or the desktop may call without ever doing a normal launch
// (#10658 delta review MEDIUM). Only side-effect-free invocations are spawned; login/logout would reach the real keychain.
const FIRST_COMMANDS: readonly (readonly string[])[] = [
  ["sync", "--help"],
  ["account", "--help"],
  ["--version"],
  ["-v"],
]

describe("a first command after upgrading", () => {
  const isolatedEnv = (home: string) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, OMO_RUNTIME: "bun" })

  for (const args of FIRST_COMMANDS) {
    test(`#given the legacy file #when \`omo ${args.join(" ")}\` runs through bin/omo.js #then the file is removed`, () => {
      const { home, path } = homeWith(LEGACY)
      runFirstCommand(join("bin", "omo.js"), args, isolatedEnv(home), home, path)
      expect(existsSync(path)).toBe(false)
    })

    // Run as the main module, like the release binary: its main() answers some commands before runCompiledLauncher.
    test(`#given the legacy file #when \`omo ${args.join(" ")}\` runs through the compiled entry's main #then the file is removed`, () => {
      const { home, path } = homeWith(LEGACY)
      runFirstCommand("compile-entry.ts", args, isolatedEnv(home), home, path)
      expect(existsSync(path)).toBe(false)
    })
  }
})

describe("a first command the release entry answers before any launch", () => {
  // A refused extra-CA value makes main() answer and return before the launcher (#10215). The legacy cleanup must
  // already have run (#10658 round 2): it is main()'s first step, shared by every command and every early return.
  test("#given the legacy file and a refused extra-CA value #when the compiled entry's main answers --version #then the file is removed", () => {
    const { home, path } = homeWith(LEGACY)
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      OMO_RUNTIME: "bun",
      OMO_EXTRA_CA_CERTIFICATES: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
    }
    runFirstCommand("compile-entry.ts", ["--version"], env, home, path)
    expect(existsSync(path)).toBe(false)
  })
})

describe("removeLegacyServiceCredentials", () => {
  test("#given the legacy credentials shape #when it runs #then the file is removed", () => {
    const { home, path } = homeWith(LEGACY)
    expect(removeLegacyServiceCredentials(home)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  test("#given no file #when it runs #then it is a no-op", () => {
    const { home } = homeWith()
    expect(removeLegacyServiceCredentials(home)).toBe(false)
  })

  test("#given a file without both private keys #when it runs #then the file is kept", () => {
    const { home, path } = homeWith(JSON.stringify({ signingPrivateKey: "only-one", refreshToken: "x" }))
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  test("#given invalid JSON #when it runs #then the file is kept", () => {
    const { home, path } = homeWith("{not json")
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  test("#given a symlink to a legacy-shaped file #when it runs #then neither link nor target is removed", () => {
    const { home, path } = homeWith()
    const target = join(home, "elsewhere.json")
    writeFileSync(target, LEGACY)
    symlinkSync(target, path)
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  test("#given a JSON array #when it runs #then the file is kept", () => {
    const { home, path } = homeWith(JSON.stringify(["signingPrivateKey", "sealingPrivateKey"]))
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  test("#given a directory at the credentials path #when it runs #then it is kept", () => {
    const { home, path } = homeWith()
    mkdirSync(path)
    writeFileSync(join(path, "inner.json"), LEGACY)
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(join(path, "inner.json"))).toBe(true)
  })

  test("#given a legacy-shaped file over 64 KiB #when it runs #then it is kept", () => {
    const padded = JSON.stringify({ ...JSON.parse(LEGACY), padding: "x".repeat(64 * 1024) })
    const { home, path } = homeWith(padded)
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(path)).toBe(true)
  })

  test("#given `.omo` is a file rather than a directory #when it runs #then it is a no-op", () => {
    const home = mkdtempSync(join(tmpdir(), "omo-legacy-creds-"))
    homes.push(home)
    writeFileSync(join(home, ".omo"), "not a directory")
    expect(removeLegacyServiceCredentials(home)).toBe(false)
    expect(existsSync(join(home, ".omo"))).toBe(true)
  })

  test.skipIf(process.platform === "win32")(
    "#given a FIFO at the credentials path #when it runs #then it is kept",
    () => {
      const { home, path } = homeWith()
      const made = spawnSync("mkfifo", [path])
      expect(made.status).toBe(0)
      expect(removeLegacyServiceCredentials(home)).toBe(false)
      expect(existsSync(path)).toBe(true)
    },
  )

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "#given a read-only `.omo` holding a legacy file #when unlink is refused #then it reports false and keeps the file",
    () => {
      const { home, path } = homeWith(LEGACY)
      const dir = join(home, ".omo")
      chmodSync(dir, 0o500)
      try {
        expect(removeLegacyServiceCredentials(home)).toBe(false)
        expect(existsSync(path)).toBe(true)
      } finally {
        chmodSync(dir, 0o700)
      }
    },
  )
})
