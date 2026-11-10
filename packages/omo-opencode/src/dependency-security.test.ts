import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"

function __repoRootFrom(start: string): string {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, ".git"))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error("repo root sentinel not found")
    dir = parent
  }
}

type BunLock = {
  workspaces?: {
    ""?: {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
  }
  packages?: Record<string, [string, ...unknown[]]>
}

const MINIMUM_SAFE_PICOMATCH_VERSION = "4.0.7"
const REPOSITORY_ROOT = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = __repoRootFrom(REPOSITORY_ROOT)
const FIRST_PARTY_SOURCE_PATHS = ["packages", "script", "test-support"] as const

function parseVersion(version: string): [number, number, number] {
  const [major = "0", minor = "0", patch = "0"] = version.split(".")
  return [Number(major), Number(minor), Number(patch)]
}

function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)

  for (let index = 0; index < leftParts.length; index++) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0

    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  return 0
}

function extractLockedVersion(packageReference: string): string {
  const versionSeparatorIndex = packageReference.lastIndexOf("@")

  if (versionSeparatorIndex === -1) {
    return packageReference
  }

  return packageReference.slice(versionSeparatorIndex + 1)
}

async function findFirstPartyEffectImports(): Promise<string[]> {
  // POSIX ERE, not PCRE: `git grep -P` needs a git built with USE_LIBPCRE and
  // exits 128 without it (#10735). Every git supports -E.
  const importPattern =
    String.raw`(from[[:space:]]+|import\([[:space:]]*|require\([[:space:]]*)["']effect(/[^"']*)?["']`
  const result = Bun.spawnSync(
    [
      "git",
      "grep",
      "-l",
      "-I",
      "-E",
      importPattern,
      "--",
      ...FIRST_PARTY_SOURCE_PATHS,
      ":(glob)**/*.ts",
      ":(exclude)packages/lsp-tools-mcp/**",
      ":(exclude)**/node_modules/**",
      ":(exclude)**/dist/**",
    ],
    // Bound the spawn so a slow `git grep -E` on a loaded Windows runner fails
    // deterministically instead of hanging past the test timeout (the observed flake).
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", timeout: 60_000 },
  )
  expect(
    result.signalCode ?? null,
    `git grep did not finish within the spawn timeout (signal ${result.signalCode})`,
  ).toBeNull()
  if (result.exitCode === 1) return []
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return result.stdout
    .toString()
    .split("\n")
    .filter((path) => path.length > 0)
}

// The OpenCode 2 plugin API is Effect-based; only its host adapter (and the build test of its Effect root)
// may import the host-provided effect.
const EFFECT_HOST_ADAPTER_PREFIXES = ["packages/omo-opencode/src/v2/", "packages/omo-opencode/src/opencode-v2/", "script/build-v2-effect-root.test.ts"] as const

describe("dependency security", () => {
  it("#given picomatch is bundled into the published dist #when dependencies are locked #then it uses the patched ReDoS-safe release", () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      devDependencies?: Record<string, string>
    }
    const bunLock = parse(readFileSync(join(REPO_ROOT, "bun.lock"), "utf-8")) as BunLock
    const dependencyRange = packageJson.devDependencies?.picomatch
    const lockedReference = bunLock.packages?.picomatch?.[0]

    expect(dependencyRange).toBe(`^${MINIMUM_SAFE_PICOMATCH_VERSION}`)
    expect(lockedReference).toBeDefined()

    const lockedVersion = extractLockedVersion(lockedReference ?? "")
    expect(compareVersions(lockedVersion, MINIMUM_SAFE_PICOMATCH_VERSION)).toBeGreaterThanOrEqual(0)
    expect(bunLock.workspaces?.[""]?.devDependencies?.picomatch).toBe(`^${MINIMUM_SAFE_PICOMATCH_VERSION}`)
  })

  it("#given effect is supplied by the OpenCode host #when root dependencies are locked #then the root package never ships it as a runtime dependency", () => {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const bunLock = parse(readFileSync(join(REPO_ROOT, "bun.lock"), "utf-8")) as BunLock
    const opencodePluginDependencies = bunLock.packages?.["@opencode-ai/plugin"]?.[2]

    expect(packageJson.dependencies?.effect).toBeUndefined()
    expect(bunLock.workspaces?.[""]?.dependencies?.effect).toBeUndefined()
    expect(opencodePluginDependencies).toMatchObject({
      dependencies: expect.objectContaining({ effect: expect.any(String) }),
    })
    // The OpenCode 2 Effect host adapter compiles against the host's effect: a peer, pinned only for
    // development, and kept external in the V2 build so the published bundle never carries it.
    expect(packageJson.peerDependencies?.effect).toBeDefined()
    expect(bunLock.packages?.effect?.[0]).toBe(`effect@${packageJson.devDependencies?.effect}`)
    const buildNodes = readFileSync(join(REPO_ROOT, "script", "build-nodes.ts"), "utf-8")
    expect(buildNodes).toMatch(/const V2_EXTERNALS = \[[^\]]*"effect"[^\]]*\]/)
  })

  // The scan spawns `git grep -E` over every first-party source and already bounds that spawn at
  // 60s so a stalled grep fails deterministically. The case therefore has to outlive its own
  // guard: on the 5s default the test died before the spawn budget could ever apply, which is the
  // Windows failure. The assertion is unchanged - only the ceiling now exceeds what it wraps.
  it("#given first-party TypeScript sources #when dependency imports are scanned #then only the OpenCode 2 Effect host adapter imports effect", async () => {
    const effectImports = await findFirstPartyEffectImports()

    expect(effectImports.filter((path) => !EFFECT_HOST_ADAPTER_PREFIXES.some((prefix) => path.startsWith(prefix)))).toEqual([])
  }, 90_000)
})
