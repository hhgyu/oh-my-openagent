// The facts child's only tool, `record_fact` (V2 port of omo-senpi `facts-record-tool.ts`). One host
// tool is registered through `tool.transform`; it refuses every caller that is not a live facts child
// issued by this component, and each issued child writes through its own run's recorder: validate
// with memory-core's extraction parser and claim receipt, then append one JSONL line to the run's
// `extraction.jsonl`. The parent parses and applies that file after the child settles.

import { appendFile } from "@oh-my-opencode/memory-core/fs"
import {
  FactsExtractionValidationError,
  parseFactsExtractionRecord,
  resolveClaimReceipt,
  USER_QUOTE_RULE,
  type ConsentExchange,
  type FactsPayload,
  type TranscriptEntry,
} from "@oh-my-opencode/memory-core"
import { Error as ToolError, type Info, type Result } from "@opencode/plugin/promise/tool"
import { z } from "zod"

export const FACTS_RECORD_TOOL_NAME = "record_fact"
const FOREIGN_SESSION_MESSAGE =
  "this tool is available only to a live facts extractor session issued by the memory component"

const factsRecordInput = z
  .object({
    scope: z.enum(["person", "project"]),
    person: z
      .object({ name: z.string(), aliases: z.array(z.string()) })
      .strict()
      .optional()
      .describe("Only for scope person. Omit this field for scope project."),
    text: z.string(),
    date: z.string(),
    source: z
      .enum(["user", "agent", "inferred"])
      .optional()
      .describe(
        "Who the fact came from: user (the user said it), agent (an assistant suggestion or statement), inferred (a conclusion drawn from the conversation). Omitted means inferred.",
      ),
    user_quote: z.string().optional().describe(USER_QUOTE_RULE),
  })
  .strict()

type FactsRecordParams = z.infer<typeof factsRecordInput>

type FactsRecordOutcome =
  { readonly ok: true; readonly count: number } | { readonly ok: false; readonly reason: string }

export interface FactsRecorder {
  record(params: FactsRecordParams): Promise<FactsRecordOutcome>
  /** Stops accepting calls (the run settled or was cancelled). */
  deactivate(): void
  /** Facts appended so far. */
  count(): number
}

export function createFactsRecorder(input: {
  readonly extractionPath: string
  /** Each user reply in the payload that directly answered an assistant message; a `user` claim must quote one. */
  readonly exchanges: readonly ConsentExchange[]
  /** Every call counts, rejected ones too: it bounds the model's tool turns, not only the records kept. */
  readonly maxCalls?: number
}): FactsRecorder {
  let active = true
  let count = 0
  let calls = 0
  let ended = false
  // A model that resends a call the validator already refused would resend it until the deadline.
  // The second identical refusal ends the run instead; the facts recorded so far commit.
  const refused = new Set<string>()
  return {
    count: () => count,
    deactivate: () => {
      active = false
    },
    async record(params) {
      if (!active) return { ok: false, reason: "the facts run is no longer active" }
      if (ended) return { ok: false, reason: "the facts run has ended; stop calling record_fact" }
      if (input.maxCalls !== undefined && calls >= input.maxCalls)
        return { ok: false, reason: `the facts tool-call limit (${input.maxCalls}) has been reached` }
      calls += 1
      try {
        const { source, user_quote: userQuote, ...fact } = params
        const receipt = resolveClaimReceipt({ source, userQuote }, input.exchanges)
        const record = parseFactsExtractionRecord({ ...fact, receipt }, count)
        // Reserve before the asynchronous append: parallel tool calls share the same numbering.
        count += 1
        const recordNumber = count
        await appendFile(input.extractionPath, `${JSON.stringify(record)}\n`, "utf8")
        return { ok: true, count: recordNumber }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        if (!(error instanceof FactsExtractionValidationError)) return { ok: false, reason }
        const call = JSON.stringify(params)
        if (!refused.has(call)) {
          refused.add(call)
          return { ok: false, reason: `${reason}. Fix this call or skip this fact; the same call will not be accepted` }
        }
        ended = true
        return {
          ok: false,
          reason: `${reason}. This exact call was already refused, so the facts run ends here; facts recorded so far are kept`,
        }
      }
    },
  }
}

/** The one registered `record_fact` tool; `resolve` answers only for a live issued facts child. */
export function createFactsRecordTool(
  resolve: (sessionID: string) => FactsRecorder | undefined,
): Info<typeof factsRecordInput> {
  return {
    name: FACTS_RECORD_TOOL_NAME,
    description: "Record one durable fact extracted from the supplied conversation payload.",
    input: factsRecordInput,
    options: { codemode: false, permission: FACTS_RECORD_TOOL_NAME },
    async execute(input, context): Promise<Result> {
      const recorder = resolve(context.sessionID)
      if (recorder === undefined)
        throw new ToolError({ message: `${FACTS_RECORD_TOOL_NAME}: ${FOREIGN_SESSION_MESSAGE}` })
      const outcome = await recorder.record(input)
      if (!outcome.ok) throw new ToolError({ message: `Fact rejected: ${outcome.reason}` })
      return { content: `Fact recorded (${outcome.count}).` }
    },
  }
}

// A user entry counts as a reply only when the entry right before it (reasoning aside) is a non-empty
// assistant message: that text is the proposal it answered. For the first user entry of a queue entry,
// the one before it is the queue entry's lead (the previous delta's last entry).
export function payloadExchanges(payload: FactsPayload): ConsentExchange[] {
  return payload.entries.flatMap((entry) => {
    const exchanges: ConsentExchange[] = []
    let proposal = proposalText(entry.lead)
    for (const item of entry.entries) {
      if (item.kind === "reasoning") continue
      if (item.kind === "user" && proposal !== undefined && item.text.trim().length > 0)
        exchanges.push({ proposal, reply: item.text })
      proposal = proposalText(item)
    }
    return exchanges
  })
}

function proposalText(item: TranscriptEntry | undefined): string | undefined {
  return item?.kind === "assistant" && item.text.trim().length > 0 ? item.text : undefined
}
