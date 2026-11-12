import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createPostMutationSessionState,
  extractMutatedFilePaths,
  MUTATION_TOOL_NAMES,
  runSingleFlight,
} from "./post-mutation"
import {
  createFormatterStep as createCoreFormatterStep,
  detectFormatter,
  resolveFormatMode,
  type FormatterStepOptions,
  type FormatterDaemonPort,
} from "./formatter"

type OptionsWithDaemon = FormatterStepOptions & { readonly daemonFormat: FormatterDaemonPort }
const createFormatterStep = (options: OptionsWithDaemon) => createCoreFormatterStep(options, options.daemonFormat)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-core-mutation-"))
  roots.push(root)
  const a = join(root, "a.ts"),
    b = join(root, "b.ts")
  writeFileSync(a, "const a=1\n")
  writeFileSync(b, "const b=2\n")
  return { root, a, b }
}

describe("extracted post-mutation contract", () => {
  test("path union preserves metadata move targets, ordered dedupe and original mutation set", () => {
    expect([...MUTATION_TOOL_NAMES]).toEqual(["write", "edit", "apply_patch"])
    expect(
      extractMutatedFilePaths({
        toolName: "apply_patch",
        input: {
          path: "a.ts",
          filePath: "a.ts",
          paths: ["b.ts", null],
          filePaths: ["c.ts"],
          files: [{ path: "a.ts", movePath: "moved.ts" }],
        },
        details: {
          files: [
            { filePath: "source.ts", movePath: "moved.ts", before: "old", after: "new", type: "update" },
            { filePath: "deleted.ts", before: "old", after: "", type: "delete" },
          ],
        },
      }),
    ).toEqual(["a.ts", "b.ts", "c.ts", "moved.ts"])
  })
  test("failed single flight is shared and later work can retry", async () => {
    let attempts = 0
    const error = Error("first attempt")
    const first = runSingleFlight("core-retry", async () => {
      attempts++
      await Promise.resolve()
      throw error
    })
    const same = runSingleFlight("core-retry", async () => {
      attempts++
      return 2
    })
    expect(same).toBe(first)
    const results = await Promise.allSettled([first, same])
    expect(results.every((result) => result.status === "rejected" && result.reason === error)).toBe(true)
    expect(
      await runSingleFlight("core-retry", async () => {
        attempts++
        return 3
      }),
    ).toBe(3)
    expect(attempts).toBe(2)
  })
  test("notice resets only the selected session and anonymous reset keeps its existing behavior", () => {
    const state = createPostMutationSessionState()
    expect(state.shouldNotice("a", "one")).toBe(true)
    expect(state.shouldNotice("a", "two")).toBe(true)
    state.reset("one")
    expect(state.shouldNotice("a", "one")).toBe(true)
    expect(state.shouldNotice("a", "two")).toBe(false)
    expect(state.shouldNotice("a")).toBe(true)
    state.reset()
    expect(state.shouldNotice("a")).toBe(false)
  })
})

describe("neutral formatter required host port", () => {
  test("marker and language policy remains unchanged", () => {
    expect(detectFormatter(["biome.json", ".prettierrc"], "a.ts")?.tool).toBe("biome")
    expect(detectFormatter(["pyproject.toml"], "a.py", "[tool.ruff]")?.tool).toBe("ruff")
    expect(detectFormatter(["Cargo.toml"], "a.ts")).toBeUndefined()
    expect(resolveFormatMode({ languages: { typescript: false }, mode: "required" }, "typescript")).toBe("off")
  })
  test("daemon result produces exact notice after real file rewrite for every extracted path", async () => {
    const f = fixture()
    const calls: string[] = []
    const step = createFormatterStep({
      markers: () => ["biome.json"],
      daemonFormat: async (path) => {
        calls.push(path)
        writeFileSync(path, "formatted\n\n")
        return { details: { status: "formatted", linesAdded: 1, linesRemoved: 0 } }
      },
    })
    const output = await step({ toolName: "apply_patch", input: { paths: [f.a, f.b, f.a] } }, f.root, "session")
    expect(calls).toEqual([f.a, f.b])
    expect(readFileSync(f.a, "utf8")).toBe("formatted\n\n")
    expect(output.content?.map((part) => part.text)).toEqual([
      "\n\n(OmO) auto-formatted a.ts with biome (+1/-0 lines). File content changed; re-read before exact-text edits.",
      "\n\n(OmO) auto-formatted b.ts with biome (+1/-0 lines). File content changed; re-read before exact-text edits.",
    ])
    expect(output.error).toBeUndefined()
  })
  test("off, oversized, disabled language, unmarked and nonmutation never invoke host port", async () => {
    const f = fixture()
    let calls = 0
    const daemonFormat: FormatterDaemonPort = async () => {
      calls++
      return { details: { status: "formatted" } }
    }
    for (const options of [
      { config: { mode: "off" as const } },
      { config: { maxFileBytes: 1 } },
      { config: { languages: { typescript: false } } },
      { markers: () => [] },
    ]) {
      await createFormatterStep({ markers: () => ["biome.json"], daemonFormat, ...options })(
        { toolName: "write", input: { path: f.a } },
        f.root,
      )
    }
    await createFormatterStep({ markers: () => ["biome.json"], daemonFormat })(
      { toolName: "read", input: { path: f.a } },
      f.root,
    )
    expect(calls).toBe(0)
  })
  test("daemon noncapability errors retain current fail-open unchanged result without CLI fallback", async () => {
    const f = fixture()
    let fallback = 0
    const output = await createFormatterStep({
      markers: () => ["biome.json"],
      daemonFormat: async () => ({ isError: true, details: { status: "failed", reason: "other" } }),
      resolveBinary: () => {
        fallback++
        return null
      },
    })({ toolName: "write", input: { path: f.a } }, f.root)
    expect(output).toEqual({ content: undefined, error: undefined })
    expect(fallback).toBe(0)
  })
  test("missing formatter notice remains per session and required mode reports unavailable", async () => {
    const f = fixture()
    const warnings: string[] = []
    const base: OptionsWithDaemon = {
      markers: () => ["biome.json"],
      daemonFormat: async () => ({ details: { status: "unavailable" } }),
      resolveBinary: () => join(f.root, "not-an-installed-formatter"),
      logger: {
        warn: (text) => {
          warnings.push(text)
        },
      },
      config: { timeoutMs: 10 },
    }
    const step = createFormatterStep(base)
    const event = { toolName: "write", input: { path: f.a } }
    await step(event, f.root, "s1")
    await step(event, f.root, "s1")
    await step(event, f.root, "s2")
    expect(warnings).toEqual([
      "Formatter biome unavailable; install it with bun add -d",
      "Formatter biome unavailable; install it with bun add -d",
    ])
    expect(
      (await createFormatterStep({ ...base, config: { mode: "required", timeoutMs: 10 } })(event, f.root)).error,
    ).toBe(`Formatter biome is unavailable for ${f.a}`)
  })
  test("prettier probes exact Bun path only after applicable language/marker gates", async () => {
    const f = fixture()
    let probes = 0
    const step = createFormatterStep({
      markers: () => [".prettierrc"],
      resolveBunFormat: async () => {
        probes++
        return join(f.root, "probed-bun")
      },
      daemonFormat: async () => ({ details: { status: "formatted", linesAdded: 0, linesRemoved: 0 } }),
    })
    expect((await step({ toolName: "write", input: { path: f.a } }, f.root)).content?.[0]?.text).toContain(
      "with bun format",
    )
    expect(probes).toBe(1)
  })
})

test("core captures original options identity for private-field getters and method receivers", async () => {
  const f = fixture()
  let calls = 0
  class IdentityOptions implements FormatterStepOptions {
    #mode: "off" | "best-effort" = "off"
    get config() {
      return { mode: this.#mode }
    }
    markers() {
      expect(this === options).toBe(true)
      return ["biome.json"]
    }
    enable() {
      this.#mode = "best-effort"
    }
  }
  const options = new IdentityOptions()
  const step = createCoreFormatterStep(options, async () => {
    calls++
    return { details: { status: "formatted" } }
  })
  await step({ toolName: "write", input: { path: f.a } }, f.root)
  expect(calls).toBe(0)
  options.enable()
  await step({ toolName: "write", input: { path: f.a } }, f.root)
  expect(calls).toBe(1)
})

describe("explicit formatter host authority ports", () => {
  test("CLI port receives concrete command and file while daemon remains the first choice", async () => {
    const f = fixture()
    const calls: unknown[] = []
    const step = createCoreFormatterStep(
      { markers: () => ["biome.json"], resolveBinary: () => process.execPath },
      async () => ({ details: { status: "unavailable", reason: "server_unavailable" } }),
      {
        runCli: async (request) => {
          calls.push(request)
          writeFileSync(request.filePath, "formatted\n")
          return { status: "formatted", added: 0, removed: 0 }
        },
      },
    )
    const output = await step({ toolName: "write", input: { path: f.a } }, f.root, "one")
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      binary: process.execPath,
      filePath: f.a,
      cwd: f.root,
      timeoutMs: 3000,
      formatter: { tool: "biome", args: ["format", "--write"] },
    })
    expect(output.content?.[0]?.text).toContain("auto-formatted a.ts with biome")
    const daemonOnly = createCoreFormatterStep(
      { markers: () => ["biome.json"] },
      async () => ({ details: { status: "formatted" } }),
      {
        runCli: async () => {
          throw Error("must not run")
        },
      },
    )
    expect((await daemonOnly({ toolName: "write", input: { path: f.a } }, f.root)).content).toHaveLength(1)
  })
  test("host daemon rejection and CLI failures retain identity instead of becoming fallback success", async () => {
    const f = fixture(),
      rejection = Error("approval rejected"),
      cliError = Error("formatter partial failure")
    let executed = 0
    const options = { markers: () => ["biome.json"], resolveBinary: () => process.execPath }
    const denied = createCoreFormatterStep(
      options,
      async () => {
        throw rejection
      },
      {
        daemonError: (error) => {
          throw error
        },
        runCli: async () => {
          executed++
          return { status: "unchanged", added: 0, removed: 0 }
        },
      },
    )
    expect(await denied({ toolName: "write", input: { path: f.a } }, f.root).catch((error) => error)).toBe(rejection)
    expect(executed).toBe(0)
    const failed = createCoreFormatterStep(options, async () => ({ details: { status: "unavailable" } }), {
      runCli: async () => {
        throw cliError
      },
    })
    expect(await failed({ toolName: "write", input: { path: f.a } }, f.root).catch((error) => error)).toBe(cliError)
  })
  test("host flight policy does not merge authority or results between callers", async () => {
    const f = fixture()
    let daemonCalls = 0,
      flights = 0
    const step = createCoreFormatterStep(
      { markers: () => ["biome.json"] },
      async () => {
        daemonCalls++
        await Promise.resolve()
        return { details: { status: "formatted" } }
      },
      {
        singleFlight: async (_path, work) => {
          flights++
          return work()
        },
      },
    )
    await Promise.all([
      step({ toolName: "write", input: { path: f.a } }, f.root, "one"),
      step({ toolName: "write", input: { path: f.a } }, f.root, "two"),
    ])
    expect(daemonCalls).toBe(2)
    expect(flights).toBe(2)
  })
})

test("owned ignore and binary discovery are authoritative, with rejection preserved", async () => {
  const f = fixture()
  let daemonCalls = 0,
    cliCalls = 0
  const denied = Error("git approval rejected")
  const options = {
    markers: () => ["biome.json"],
    config: { mode: "required" as const },
    resolveBinary: () => process.execPath,
  }
  const step = createCoreFormatterStep(
    options,
    async () => {
      daemonCalls++
      return { details: { status: "unavailable" } }
    },
    {
      isIgnored: async () => {
        throw denied
      },
      runCli: async () => {
        cliCalls++
        return { status: "unchanged", added: 0, removed: 0 }
      },
    },
  )
  expect(await step({ toolName: "write", input: { path: f.a } }, f.root).catch((error) => error)).toBe(denied)
  expect(daemonCalls).toBe(0)
  const missing = createCoreFormatterStep(options, async () => ({ details: { status: "unavailable" } }), {
    isIgnored: async () => false,
    resolveBinary: () => null,
    runCli: async () => {
      cliCalls++
      return { status: "unchanged", added: 0, removed: 0 }
    },
  })
  expect((await missing({ toolName: "write", input: { path: f.a } }, f.root)).error).toContain("unavailable")
  expect(cliCalls).toBe(0)
})
