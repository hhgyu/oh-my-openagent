import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CodemodeUnavailableError } from "./codemode-loader"
import { createRpcPeer } from "./codemode-rpc"
import { locateCodemodeWorker, spawnCodemodeWorker } from "./codemode-worker-client"
import { CODEMODE_RPC } from "./codemode-worker-protocol"
import { connectFakeWorker } from "./test-support"

describe("codemode worker client", () => {
  test("#given no eval call yet #when the backend exists #then no worker is spawned, and the first call loads, runs and relays progress", async () => {
    // given
    const fake = connectFakeWorker({
      execute: async (_input, _id, params, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: "text", text: "working" }], details: { fn: "dropped" } })
        return { content: [{ type: "text", text: JSON.stringify(params) }], details: { language: "js" } }
      },
    })
    expect(fake.state.spawned).toBe(0)
    const updates: unknown[] = []

    // when
    await fake.backend.load()
    const session = await fake.backend.acquire("ses_1", new AbortController().signal)
    const result = await session.run("call_1", { code: "6*7" }, new AbortController().signal, (update) =>
      updates.push(update),
    )

    // then
    expect(fake.state.spawned).toBe(1)
    expect(fake.backend.definition()).toEqual({ description: "codemode description", parameters: { type: "object" } })
    expect(result).toEqual({ content: [{ type: "text", text: '{"code":"6*7"}' }], details: { language: "js" } })
    expect(updates).toEqual([{ content: [{ type: "text", text: "working" }] }])
    expect(fake.state.created).toEqual(["ses_1"])
    await fake.backend.dispose()
    fake.close()
  })

  test("#given owned kernel preludes #when a session's calls change which are active #then each call's cells read exactly its own set and the description documents the catalog", async () => {
    // given
    const computer = {
      javascript: "globalThis.computer = {}",
      python: "computer = None",
      documentation: "computer.*",
      exports: ["computer"],
    }
    let active: string[] = ["computer"]
    const fake = connectFakeWorker({
      kernelPreludes: { catalog: [{ name: "computer", contribution: computer }], active: () => active },
      execute: async (input) => ({
        content: [{ type: "text", text: JSON.stringify(input.kernelPreludes?.() ?? null) }],
      }),
    })
    await fake.backend.load()
    const session = await fake.backend.acquire("ses_1", new AbortController().signal)
    const run = async () =>
      ((await session.run("call", {}, new AbortController().signal, () => {})) as { content: { text: string }[] })
        .content[0]?.text

    // when
    const installed = await run()
    active = []
    const removed = await run()

    // then
    expect(JSON.parse(installed ?? "null")).toEqual([computer])
    expect(JSON.parse(removed ?? "null")).toEqual([])
    expect(fake.state.definitionPreludes).toEqual([[computer]])
    await fake.backend.dispose()
    fake.close()
  })

  test("#given a running cell #when the tool signal aborts #then the abort reaches the worker as a message and the cell's own answer returns", async () => {
    // given
    const seen: string[] = []
    const fake = connectFakeWorker({
      execute: (_input, _id, _params, signal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              seen.push(String((signal.reason as Error).message))
              reject(signal.reason)
            },
            { once: true },
          )
        }),
    })
    const session = await fake.backend.acquire("ses_1", new AbortController().signal)
    const controller = new AbortController()

    // when
    const pending = session.run("call_1", {}, controller.signal, () => {})
    await Bun.sleep(5)
    controller.abort(Error("user interrupted"))
    const error = await pending.catch((caught: unknown) => caught)

    // then
    expect(seen).toEqual(["user interrupted"])
    expect((error as Error).message).toBe("user interrupted")
    await fake.backend.dispose()
    fake.close()
  })

  test("#given live sessions #when one is released and the plugin disposes #then kernels go by message and the worker is terminated once", async () => {
    // given
    const fake = connectFakeWorker()
    await fake.backend.acquire("a", new AbortController().signal)
    await fake.backend.acquire("b", new AbortController().signal)

    // when
    await fake.backend.release("a")
    await Promise.all([fake.backend.dispose(), fake.backend.dispose()])
    const refused = await fake.backend.acquire("c", new AbortController().signal).catch((caught: unknown) => caught)

    // then
    expect(fake.state.disposed).toEqual(["a", "b"])
    expect(fake.state.terminated).toBe(1)
    expect((refused as Error).message).toBe("eval is shutting down")
    expect(fake.proc.count("exit")).toBe(0)
    expect(fake.state.killed).toEqual([])
    fake.close()
  })

  test("#given the worker reported subprocess kernels #when the process exits without dispose #then the main thread kills those pids and terminates the worker", async () => {
    // given
    const fake = connectFakeWorker({ kernels: () => [{ pid: 4242, language: "py" }, { language: "js" }, { pid: -1 }] })
    await fake.backend.acquire("ses_1", new AbortController().signal)
    await Bun.sleep(5)

    // when
    fake.proc.emit("exit")

    // then
    expect(fake.state.killed).toEqual([[4242]])
    expect(fake.state.terminated).toBe(1)
    fake.close()
  })

  test("#given the worker crashes mid-call #when the error event fires #then the call fails, its kernels are killed and the next call starts a new worker", async () => {
    // given
    let hang = true
    const fake = connectFakeWorker({
      kernels: () => [{ pid: 777 }],
      execute: () => (hang ? new Promise(() => {}) : Promise.resolve({ content: [] })),
    })
    const session = await fake.backend.acquire("ses_1", new AbortController().signal)
    const pending = session.run("call_1", {}, new AbortController().signal, () => {})
    await Bun.sleep(5)

    // when
    fake.crash("boom")
    const error = await pending.catch((caught: unknown) => caught)
    hang = false
    const again = await session.run("call_2", {}, new AbortController().signal, () => {})

    // then
    expect((error as Error).message).toContain("eval runtime worker stopped: boom")
    expect(fake.state.killed).toEqual([[777]])
    expect(fake.state.spawned).toBe(2)
    expect(again).toEqual({ content: [] })
    await fake.backend.dispose()
    fake.close()
  })
})

describe("codemode worker spawn", () => {
  test('#given a host process.on("worker") listener that calls worker.on #when the real codemode worker spawns #then the listener gets an EventEmitter Worker and the RPC channel still round-trips', async () => {
    // given
    const seen: { readonly hasOn: boolean; readonly error?: string }[] = []
    const listener = (worker: unknown) => {
      const emitter = worker as { on?: unknown }
      try {
        if (typeof emitter.on !== "function") throw TypeError("worker.on is not a function")
        emitter.on.call(worker, "message", () => {})
        seen.push({ hasOn: true })
      } catch (error) {
        seen.push({ hasOn: false, error: String(error) })
      }
    }
    process.on("worker", listener)
    let port: ReturnType<typeof spawnCodemodeWorker> | undefined
    try {
      // when
      port = spawnCodemodeWorker()
      const exited = new Promise<string | undefined>((resolve) =>
        port?.addEventListener("close", (event) => resolve(event.message)),
      )
      const peer = createRpcPeer(port, {})
      const released = await peer.call(CODEMODE_RPC.release, { sessionID: "ses_spawn" })
      port.terminate()

      // then
      expect(seen).toEqual([{ hasOn: true }])
      expect(released).toBeNull()
      expect(await exited).toMatch(/^exited with code \d+$/)
    } finally {
      process.off("worker", listener)
      port?.terminate()
    }
  })
})

describe("codemode worker entry location", () => {
  test("#given a source checkout #when located from this directory #then the TypeScript entry is found", () => {
    // given / when
    const path = locateCodemodeWorker(import.meta.dir)

    // then
    expect(path.replaceAll("\\", "/").endsWith("/v2/tools/codemode-worker.ts")).toBe(true)
  })

  test("#given a built dist directory #when both names exist or none #then the emitted .js wins and a missing entry is a model-visible error", () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "omo-eval-worker-entry-"))
    try {
      const missing = (() => {
        try {
          return locateCodemodeWorker(dir)
        } catch (caught) {
          return caught
        }
      })()
      writeFileSync(join(dir, "codemode-worker.ts"), "")
      writeFileSync(join(dir, "codemode-worker.js"), "")

      // when
      const found = locateCodemodeWorker(dir)

      // then
      expect(missing).toBeInstanceOf(CodemodeUnavailableError)
      expect((missing as Error).message).toContain("codemode-worker.js is missing")
      expect(found).toBe(join(dir, "codemode-worker.js"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
