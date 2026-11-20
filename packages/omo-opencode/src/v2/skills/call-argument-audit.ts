import {
  MemberTaskSendParams,
  TaskCancelParams,
  TaskOutputParams,
  TaskSendParams,
  TaskToolParams,
} from "@oh-my-opencode/senpi-task/task-operations"
import { DagToolParams } from "@oh-my-opencode/senpi-task/dag-operations"
import {
  TeamCreateParams,
  TeamDeleteParams,
  TeamTaskCreateParams,
  TeamTaskGetParams,
  TeamTaskListParams,
  TeamTaskUpdateParams,
} from "@oh-my-opencode/senpi-task/team-operations"
import { findToolCalls, parseEntries, splitElements, type ParsedArgument, type ParsedCall } from "./tool-call-parser"

type Schema = Readonly<Record<string, unknown>>
type SchemaSource = object

export interface ArgumentFinding {
  readonly line: number
  readonly rule: "arg-unknown" | "arg-missing" | "member-tool"
  readonly text: string
  readonly reason: string
}

const QUESTION_SCHEMA: SchemaSource = {
  properties: {
    questions: {
      type: "array",
      items: {
        properties: {
          question: {},
          header: {},
          options: {
            type: "array",
            items: {
              properties: { label: {}, description: {} },
              required: ["label", "description"],
              additionalProperties: false,
            },
          },
          multiple: {},
        },
        required: ["question", "header", "options"],
        additionalProperties: false,
      },
    },
  },
  required: ["questions"],
  additionalProperties: false,
}

const LEAD_SCHEMAS: Readonly<Record<string, SchemaSource>> = {
  task: TaskToolParams,
  task_send: TaskSendParams,
  task_output: TaskOutputParams,
  task_cancel: TaskCancelParams,
  team_create: TeamCreateParams,
  team_delete: TeamDeleteParams,
  task_create: TeamTaskCreateParams,
  task_get: TeamTaskGetParams,
  task_list: TeamTaskListParams,
  task_update: TeamTaskUpdateParams,
  workflow: DagToolParams,
  question: QUESTION_SCHEMA,
}
const MEMBER_SEND_SCHEMA: SchemaSource = MemberTaskSendParams
const LEAD_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "team_create",
  "team_delete",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
])
const AUDITED_CALL_TOOLS: readonly string[] = Object.keys(LEAD_SCHEMAS)

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function variants(schema: Schema): Schema[] {
  const nested = [schema.anyOf, schema.oneOf].flatMap((group) => (Array.isArray(group) ? group.filter(isSchema) : []))
  return [schema, ...nested.flatMap(variants)]
}

interface Shape {
  readonly properties: ReadonlyMap<string, Schema>
  readonly closed: boolean
  readonly required: readonly string[]
}

function shapeOf(schema: Schema): Shape | undefined {
  const objects = variants(schema).filter((variant) => isSchema(variant.properties))
  if (objects.length === 0) return undefined
  const properties = new Map<string, Schema>()
  for (const object of objects)
    for (const [name, child] of Object.entries(object.properties as Schema))
      if (isSchema(child)) properties.set(name, child)
  const requiredSets = objects.map((object) => (Array.isArray(object.required) ? (object.required as string[]) : []))
  return {
    properties,
    closed: objects.every((object) => object.additionalProperties === false),
    required: (requiredSets[0] ?? []).filter((name) => requiredSets.every((set) => set.includes(name))),
  }
}

function checkEntries(schema: Schema, entries: readonly ParsedArgument[], path: string, unknown: string[]): void {
  const shape = shapeOf(schema)
  if (shape === undefined) return
  for (const entry of entries) {
    const child = shape.properties.get(entry.name)
    if (child === undefined) {
      if (shape.closed) unknown.push(`${path}${entry.name}`)
      continue
    }
    checkValue(child, entry.value, `${path}${entry.name}.`, unknown)
  }
}

function checkValue(schema: Schema, value: string, path: string, unknown: string[]): void {
  const text = value.trim()
  if (text.startsWith("{") && text.endsWith("}")) {
    const parsed = parseEntries(text.slice(1, -1), true)
    if (parsed !== undefined) checkEntries(schema, parsed.entries, path, unknown)
  } else if (text.startsWith("[") && text.endsWith("]")) {
    const items = variants(schema).find((variant) => isSchema(variant.items))?.items
    if (!isSchema(items)) return
    for (const element of splitElements(text.slice(1, -1)))
      if (element.startsWith("{")) checkValue(items, element, path, unknown)
  }
}

function lineWithin(call: ParsedCall, name: string): number {
  const found = new RegExp(`["']?${name.split(".").at(-1)}["']?\\s*[=:]`).exec(call.raw)
  return call.line + (found === null ? 0 : call.raw.slice(0, found.index).split("\n").length - 1)
}

function isMemberPromptLine(line: string): boolean {
  return /^\s*"prompt"\s*:/.test(line)
}

function findingsFor(call: ParsedCall, member: boolean): ArgumentFinding[] {
  const context = member ? "team member" : "lead"
  if (member && LEAD_ONLY_TOOLS.has(call.tool))
    return [
      {
        line: call.line,
        rule: "member-tool",
        text: `${call.tool}(...)`,
        reason: `${call.tool} is a lead-only tool; a V2 team member can only call task_send`,
      },
    ]
  const source = member && call.tool === "task_send" ? MEMBER_SEND_SCHEMA : LEAD_SCHEMAS[call.tool]
  if (source === undefined || call.parsed === undefined) return []
  const schema = source as Schema
  const unknown: string[] = []
  checkEntries(schema, call.parsed.entries, "", unknown)
  const findings: ArgumentFinding[] = unknown.map((name) => ({
    line: lineWithin(call, name),
    rule: "arg-unknown",
    text: `${call.tool}(${name})`,
    reason: `${name} is not a parameter of the V2 ${context} ${call.tool} schema`,
  }))
  const shape = shapeOf(schema)
  if (shape !== undefined && !call.parsed.elided && call.parsed.entries.length > 0)
    for (const name of shape.required)
      if (!call.parsed.entries.some((entry) => entry.name === name))
        findings.push({
          line: call.line,
          rule: "arg-missing",
          text: `${call.tool}(${name})`,
          reason: `${name} is required by the V2 ${context} ${call.tool} schema`,
        })
  return findings
}

export function auditCallArguments(text: string, skipLine: (line: number) => boolean): ArgumentFinding[] {
  const lines = text.split("\n")
  return findToolCalls(text, AUDITED_CALL_TOOLS).flatMap((call) =>
    skipLine(call.line) ? [] : findingsFor(call, isMemberPromptLine(lines[call.line - 1] ?? "")),
  )
}
