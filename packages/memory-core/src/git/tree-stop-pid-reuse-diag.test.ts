import { afterAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createNodeGitExec } from "./exec"

// DIAGNOSTIC ONLY (draft PR, never merged): aborts many short gits around their natural exit while another
// process churns short-lived processes, so a taskkill that starts as git exits can meet a reused pid.
const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe("tree stop pid reuse diagnostic", () => {
  test.skipIf(process.platform !== "win32")(
    "#given aborts racing git's own exit #when the tree is stopped #then the taskkill target is recorded",
    async () => {
      const diagnostics = mkdtempSync(join(tmpdir(), "tree-stop-diag-"))
      const repo = mkdtempSync(join(tmpdir(), "tree-stop-repo-"))
      dirs.push(diagnostics, repo)
      const exec = createNodeGitExec()
      const env = { ...process.env, OMO_GIT_TIMEOUT_DIAGNOSTICS_DIR: diagnostics }
      expect((await exec.run(["init", "-q"], { cwd: repo, timeoutMs: 30_000, env })).code).toBe(0)
      const churn = spawn(
        process.execPath,
        [
          "-e",
          'const { spawn } = require("child_process"); const go = () => spawn(process.env.ComSpec || "cmd.exe", ["/c", "exit"], { stdio: "ignore", windowsHide: true }).once("exit", go); for (let i = 0; i < 6; i++) go()',
        ],
        { stdio: "ignore", windowsHide: true },
      )
      const outcomes: Record<string, number> = {}
      try {
        for (let round = 0; round < 25; round++) {
          await Promise.all(
            Array.from({ length: 8 }, async (_, index) => {
              const controller = new AbortController()
              const delay = (round * 8 + index) % 70
              setTimeout(() => controller.abort(), delay)
              const outcome = await exec
                .run(["rev-parse", "HEAD"], { cwd: repo, timeoutMs: 30_000, signal: controller.signal, env })
                .then(
                  (result) => `exit ${result.code}`,
                  (error: unknown) => (error instanceof Error ? error.name : "error"),
                )
              outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
            }),
          )
        }
      } finally {
        const exited = once(churn, "exit")
        churn.kill("SIGKILL")
        await exited
      }
      await new Promise((resolve) => setTimeout(resolve, 8_000))
      const records = readdirSync(diagnostics)
        .filter((name) => name.startsWith("tree-stop-"))
        .map((name) => JSON.parse(readFileSync(join(diagnostics, name), "utf8")) as Record<string, unknown>)
      const count = (key: string) => records.filter((record) => record[key] === true).length
      console.log(
        `TREE-STOP-DIAG-STRESS outcomes=${JSON.stringify(outcomes)} stops=${records.length} staleAtStop=${count("staleAtStop")} launcherExitedBeforeTaskkillClosed=${count("launcherExitedBeforeTaskkillClosed")} killedForeignProcess=${count("killedForeignProcess")}`,
      )
      for (const record of records.filter(
        (entry) => entry.killedForeignProcess === true || entry.launcherExitedBeforeTaskkillClosed === true,
      ))
        console.log(`TREE-STOP-DIAG-STRESS-RECORD ${JSON.stringify(record)}`)
    },
    300_000,
  )
})
