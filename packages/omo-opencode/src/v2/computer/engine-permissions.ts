// `/computer status` while no engine runs: a passive `engine.hello` + `capabilities` probe of the installed engine,
// with no desktop session and no stop listener, as Native's status reports OS permissions.

import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { type EngineLocatorOptions, resolveInstalledEngine } from "./engine"

const PROBE_TIMEOUT_MS = 5_000
const PERMISSIONS = ["capturePermission", "inputPermission", "axPermission"] as const

export type EngineSpawn = (path: string) => import("node:child_process").ChildProcessWithoutNullStreams

const spawnEngine: EngineSpawn = (path) => spawn(path, ["--stdio"], { stdio: "pipe", windowsHide: true })

function probe(path: string, spawnChild: EngineSpawn, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawnChild(path)
    let settled = false
    const finish = (text: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      lines.close()
      child.stdin.end()
      if (child.exitCode === null) child.kill()
      resolve(text)
    }
    const timer = setTimeout(
      () => finish(`OS permissions: unknown (timeout: no answer within ${timeoutMs} ms)`),
      timeoutMs,
    )
    child.on("error", (error) => finish(`OS permissions: unknown (spawn failed: ${error.message})`))
    child.on("close", (code) => finish(`OS permissions: unknown (engine exited with code ${code ?? "null"})`))
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout }).on("line", (line) => {
      let reply: unknown
      try {
        reply = JSON.parse(line)
      } catch (error) {
        if (error instanceof SyntaxError) return finish("OS permissions: unknown (engine emitted non-JSON output)")
        throw error
      }
      if (typeof reply !== "object" || reply === null || Reflect.get(reply, "id") !== 2) return
      const result: unknown = Reflect.get(reply, "result")
      if (typeof result !== "object" || result === null) return finish("OS permissions: unknown (capabilities failed)")
      const fields = PERMISSIONS.map((name) => `${name}=${String(Reflect.get(result, name))}`)
      finish(`OS permissions: ${fields.join(" ")} (passive probe)`)
    })
    child.stdin.on("error", (error) => finish(`OS permissions: unknown (stdin: ${error.message})`))
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "engine.hello", params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "capabilities", params: {} })}\n`)
  })
}

export async function describeEnginePermissions(
  enginePath: string | undefined,
  options: EngineLocatorOptions & { readonly spawn?: EngineSpawn; readonly timeoutMs?: number } = {},
): Promise<string> {
  const source = resolveInstalledEngine(enginePath, options)
  if (source.kind === "missing") return "OS permissions: unknown until first use (no usable installed engine)"
  return probe(source.path, options.spawn ?? spawnEngine, options.timeoutMs ?? PROBE_TIMEOUT_MS)
}
