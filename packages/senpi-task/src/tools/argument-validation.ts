import type { Static, TSchema } from "typebox"
import { Compile } from "typebox/compile"

export interface ToolArgumentDiagnostic {
  readonly code: "invalid_arguments"
  readonly fields: readonly string[]
  readonly expected_fields: readonly string[]
  readonly issues: readonly { readonly code: string; readonly path: string; readonly fields: readonly string[]; readonly expected_type?: string | readonly string[] }[]
}

/** Only schema locations and field names cross the host boundary, never argument values. */
export class ToolArgumentValidationError extends Error {
  constructor(readonly diagnostic: ToolArgumentDiagnostic) {
    super(JSON.stringify({ message: "Invalid tool arguments", ...diagnostic }))
    this.name = "ToolArgumentValidationError"
  }
}

export function createToolArgumentValidator<T extends TSchema>(schema: T): (value: unknown) => Static<T> {
  const compiled = Compile(schema)
  const expected_fields = Object.keys("properties" in schema && typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {})
  return value => {
    if (compiled.Check(value)) return value
    const issues = compiled.Errors(value).filter(issue => issue.keyword !== "boolean").map(issue => {
      const names = issue.keyword === "required" ? issue.params.requiredProperties
        : issue.keyword === "additionalProperties" ? issue.params.additionalProperties : undefined
      const path = issue.instancePath
      const fields = Array.isArray(names) ? names.map(name => `${path}/${String(name)}`) : [path || "/"]
      return {
        code: issue.keyword, path, fields,
        ...(issue.keyword === "type" ? { expected_type: issue.params.type } : {}),
      }
    })
    const fields = [...new Set(issues.flatMap(issue => issue.fields))].map(field => field.slice(1).replaceAll("~1", "/").replaceAll("~0", "~"))
    throw new ToolArgumentValidationError({ code: "invalid_arguments", fields, expected_fields, issues })
  }
}
