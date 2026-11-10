import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { Readable } from "node:stream"

import { runCommentChecker } from "./runner"
import { sendAndCloseStdin } from "./stdin-delivery"
import type { CheckResult, RunCommentCheckerInput, SpawnProcess } from "./types"

/** Runs the checker through Node's `child_process.spawn`, the default for hosts that run on Node or Bun. */
export async function runCommentCheckerWithNodeSpawn(input: RunCommentCheckerInput): Promise<CheckResult> {
  return runCommentChecker(input, {
    existsSync,
    spawn: spawnCommentCheckerProcess,
  })
}

export function spawnCommentCheckerProcess(args: readonly string[]): SpawnProcess {
  const [command, ...commandArgs] = args
  if (command === undefined) {
    throw new Error("comment-checker command is required")
  }
  const subprocess = spawn(command, commandArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const exited = new Promise<number>((resolve, reject) => {
    subprocess.on("error", reject)
    subprocess.on("close", (code) => resolve(code ?? 1))
  })
  return {
    stdin: {
      send: (input: string) => sendAndCloseStdin(subprocess.stdin, input),
    },
    stdout: Readable.toWeb(subprocess.stdout),
    stderr: Readable.toWeb(subprocess.stderr),
    exited,
    kill(signal) {
      subprocess.kill(signal)
    },
  }
}
