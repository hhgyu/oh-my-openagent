import { describe, expect, test } from "bun:test"
import * as z from "zod"

import { pruneInvalidConfigPaths, type PruneValidator } from "./prune-invalid-leaves"

// A preprocess that renames a key into one the strict object does not own: zod then reports an
// unrecognized key that is absent from the document the pruner edits.
const EntrySchema = z.preprocess(
  (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value
    const { legacy, ...rest } = value as Record<string, unknown>
    return legacy === undefined ? rest : { ...rest, renamed: legacy }
  },
  z.object({ model: z.string() }).strict(),
)
const DocumentSchema = z.object({ entries: z.record(z.string(), EntrySchema), keep: z.number() }).strict()

const validate: PruneValidator = (candidate) => {
  const parsed = DocumentSchema.safeParse(candidate)
  return parsed.success ? { success: true } : { success: false, issues: parsed.error.issues }
}

describe("pruneInvalidConfigPaths", () => {
  test("#given an unrecognized key that exists only after a preprocess #when pruning #then the entry carrying it is dropped and the rest of the document settles", () => {
    // given
    const document = { entries: { bad: { model: "a/b", legacy: 1 }, good: { model: "c/d" } }, keep: 7 }
    const initial = DocumentSchema.safeParse(document)
    if (initial.success) throw new Error("fixture must fail validation")

    // when
    const result = pruneInvalidConfigPaths(document, initial.error.issues, validate)

    // then
    expect(result).toEqual({
      ok: true,
      config: { entries: { good: { model: "c/d" } }, keep: 7 },
      dropped: [expect.objectContaining({ key: "entries.bad" })],
    })
  })
})
