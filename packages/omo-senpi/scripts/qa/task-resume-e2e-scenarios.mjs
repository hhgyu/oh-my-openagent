#!/usr/bin/env node
// Scripted parent turns + token contract for task-resume-e2e.mjs (lane-private). Child turns are
// content-routed inside task-resume-e2e-mock-provider.ts; these tokens MUST mirror the provider's
// constants (resume-e2e-runtime.test.mjs pins the equality).
import { waitForFileCommand, waitForRecordStatusCommand } from "./resume-e2e-runtime.mjs"

export const CONTINUATION_MARKER = "interrupted by a host process restart"
export const PING_TOKEN = "RESUME_PING_TOKEN"
export const PONG_TOKEN = "RESUME_PONG_TOKEN"
export const MIDTURN_CONTINUED_TOKEN = "MIDTURN_CONTINUED_TOKEN"
export const FINISHED_CHILD_TOKEN = "FINISHED_CHILD_DONE"

// Senpi withholds `bash` from the direct tool list while codemode's `eval` is registered, so every
// agent-side wait runs inside an eval cell the way a model calls it. The cell timeout outlasts the
// waits' own 60 s bound so a wedged drive fails on that bound, never on the 30 s cell default.
const WAIT_CELL_TIMEOUT_SECONDS = 120
const bash = (command) => ({
  type: "tool_call",
  name: "eval",
  arguments: {
    language: "js",
    summary: "agent-side driver wait",
    timeout: WAIT_CELL_TIMEOUT_SECONDS,
    code: `const r = await tool.bash(${JSON.stringify({ command })}); print(r.text)`,
  },
})
const text = (value) => ({ type: "text", text: value })
const spawnBackground = (prompt, name) => ({
  type: "tool_call",
  name: "task",
  arguments: { category: "mockcat", prompt, run_in_background: true, name },
})

export const RESUME_OMO_CONFIG = {
  categories: {
    mockcat: { description: "Local mock category pinned to the mock provider.", model: "omo-mock/mock-1" },
  },
}

export function resumeOmoConfig(taskOverrides) {
  return taskOverrides === undefined ? RESUME_OMO_CONFIG : { ...RESUME_OMO_CONFIG, task: taskOverrides }
}

// Run 1: spawn the mid-turn child and the finished child, then hold until the driver has observed
// both required states (midchild owns an assistant message, finchild completed) and releases the quit.
export function happyRun1Script(sentinel) {
  return {
    parentSteps: [
      spawnBackground("midturn-child first unit", "midchild"),
      spawnBackground("finished-child second unit", "finchild"),
      bash(waitForFileCommand(sentinel)),
      text("run one settled, quitting"),
    ],
  }
}

// Run 2 (resume same session): steer the revived finished child with a unique probe, then hold
// until the driver observes the mid-turn child's continuation landing.
export function happyRun2Script(sentinel) {
  return {
    parentSteps: [
      {
        type: "tool_call",
        name: "task_send",
        arguments: { to: "finchild", message: `${PING_TOKEN} post-resume steerability probe` },
      },
      bash(waitForFileCommand(sentinel)),
      text("run two settled, quitting"),
    ],
  }
}

// The doomed child must still be RUNNING when task_cancel lands (a completed child is a cancel
// noop), so it follows the mid-turn route: instant read, then a model-level hang. Every witness is a
// mid-turn child too: a resume eagerly revives only non-terminal children (a completed one waits
// for task_send, #7550), so only a mid-turn witness proves the resume's revival pass ran.
export function cancelRun1Script(sentinel) {
  return {
    parentSteps: [
      spawnBackground("midturn-child doomed unit", "cancelchild"),
      { type: "tool_call", name: "task_cancel", arguments: { name: "cancelchild" } },
      spawnBackground("midturn-child cancel witness", "cancelwitness"),
      bash(waitForFileCommand(sentinel)),
      text("cancel run settled, quitting"),
    ],
  }
}

// The kill target is mid-turn as well, so `killed: true` is the only thing keeping it suspended.
export function killRun1Script(sentinel) {
  return {
    parentSteps: [
      spawnBackground("midturn-child external kill target", "killchild"),
      spawnBackground("midturn-child kill witness", "killwitness"),
      bash(waitForFileCommand(sentinel)),
      text("kill run settled, quitting"),
    ],
  }
}

// Cap-1 LRU lane: the agent-side record wait guarantees lruone is a terminal idle resident before
// lrutwo's spawn forces the eviction (only terminal idle residents are evictable). lrutwo stays
// mid-turn so the resume revives it into the single slot.
export function lruRun1Script(sandbox, sentinel) {
  return {
    parentSteps: [
      spawnBackground("lru-child oldest unit", "lruone"),
      bash(waitForRecordStatusCommand(sandbox, "lruone", "completed")),
      spawnBackground("midturn-child lru newest witness", "lrutwo"),
      bash(waitForFileCommand(sentinel)),
      text("lru run settled, quitting"),
    ],
  }
}

export function ttlRun1Script(sandbox, sentinel) {
  return {
    parentSteps: [
      spawnBackground("ttl-child expiring unit", "ttlchild"),
      spawnBackground("midturn-child ttl witness", "ttlwitness"),
      bash(waitForRecordStatusCommand(sandbox, "ttlchild", "completed")),
      bash(waitForFileCommand(sentinel)),
      text("ttl run settled, quitting"),
    ],
  }
}

// Resume verification runs need no child spawns; the hold lets the witness continuation land.
export function resumeProbeScript(sentinel) {
  return {
    parentSteps: [bash(waitForFileCommand(sentinel)), text("resume probe settled, quitting")],
  }
}

export const UNRELATED_SESSION_SCRIPT = {
  parentSteps: [text("unrelated session boot complete")],
}
