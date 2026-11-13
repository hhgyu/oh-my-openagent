import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { TranscriptJournal } from "@oh-my-opencode/memory-core"
import type { DreamFireOutcome, DreamRequest } from "./dream-fire"
import { createDreamCommand } from "./dream-command"
import { createBoundIdentity } from "./reflection.test-support"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(outcome: DreamFireOutcome = { fired: true, runId: "dream-1", status: "active" }) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  mkdirSync(identity.bound.paths.repo, { recursive: true })
  const requests: DreamRequest[] = []
  const command = createDreamCommand({
    request: async (_bound, request) => {
      requests.push(request)
      return outcome
    },
    settings: () => ({
      enabled: true,
      idleMinutes: 30,
      minHoursBetween: 24,
      shutdownLaunch: false,
      autoSelectMax: 5,
      autoSelectMaxChars: 150_000,
    }),
  })
  return { bound: identity.bound, command, requests }
}

describe("/dream", () => {
  test("#given a bound session #when /dream runs with a target, ids and focus #then one manual request is made and its reservation is reported", async () => {
    // given
    const { bound, command, requests } = setup()
    // when
    const result = await command.run(bound, "--conversation ses_a,ses_b,ses_a --to reference/build.md build notes")
    // then
    expect(command.name).toBe("dream")
    expect(requests).toEqual([
      { focus: "build notes", conversationIds: ["ses_a", "ses_b"], targetDoc: "reference/build.md" },
    ])
    expect(result).toEqual({ text: "dream run dream-1 reserved", level: "info" })
  })

  test("#given a busy slot #when /dream runs #then the queued answer is reported", async () => {
    // given
    const { bound, command } = setup({ fired: true, runId: "dream-2", status: "pending" })
    // when
    const result = await command.run(bound, "--auto")
    // then
    expect(result).toEqual({ text: "dream request queued as dream-2; another memory run is active", level: "info" })
  })

  test("#given recent journals #when /dream --recent 1 runs #then the most recently active unreflected journal is requested", async () => {
    // given
    const { bound, command, requests } = setup()
    for (const [id, at] of [
      ["ses_old", "2026-11-01T00:00:00.000Z"],
      ["ses_new", "2026-11-10T00:00:00.000Z"],
    ] as const) {
      await new TranscriptJournal({ journalDir: join(bound.paths.transcripts, id), now: () => new Date(at) }).reconcile(
        [
          { kind: "user", messageId: `${id}-u`, text: "question" },
          { kind: "assistant", messageId: `${id}-a`, textBlocks: ["answer"], reasoningBlocks: [], toolCalls: [] },
        ],
      )
    }
    // when
    await command.run(bound, "--recent 1")
    // then
    expect(requests).toEqual([{ conversationIds: ["ses_new"] }])
  })

  test("#given invalid arguments or no binding #when /dream runs #then it refuses with Native's texts and requests nothing", async () => {
    // given
    const { bound, command, requests } = setup()
    const cases: [string, string][] = [
      ["--auto --recent 2", "choose exactly one of --auto, --recent, --conversation, or --from"],
      ["--to /etc/passwd.md", "--to must be a memory-repo-relative document path"],
      ["--to ../outside.md", "--to must be a memory-repo-relative document path without traversal"],
      ["--to reference/notes.txt", "--to must target a .md document in the memory repo"],
      ["--recent 0", "--recent expects a positive integer"],
      ["--recent 3", "--recent found no unreflected conversations"],
      ["--conversation ../x", "--conversation ids must be plain conversation ids"],
      [
        "--from transcript:a.jsonl",
        "--from transcript:<path> stages Senpi session JSONL and is not available on OpenCode; use --conversation or --recent",
      ],
    ]
    // when
    const results = await Promise.all(cases.map(([args]) => command.run(bound, args)))
    const unbound = await command.run(undefined, "")
    // then
    expect(results.map((result) => result.text)).toEqual(cases.map(([, text]) => text))
    expect(results.every((result) => result.level === "error")).toBe(true)
    expect(unbound).toEqual({ text: "dreaming is not available without a bound memory session", level: "error" })
    expect(requests).toEqual([])
  })

  test("#given a refused request #when /dream runs #then the rejection is reported as an error", async () => {
    for (const [rejection, text] of [
      ["no_unreflected_content", "dream found no unreflected content to process"],
      ["parked", "automatic memory reflection is paused after repeated failures; run /reflect to retry now"],
    ] as const) {
      // given
      const { bound, command } = setup({ fired: false, rejection })
      // when
      const result = await command.run(bound, "")
      // then
      expect(result).toEqual({ text, level: "error" })
    }
  })
})
