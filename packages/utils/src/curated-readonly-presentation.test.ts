import { expect, test } from "bun:test"
import { capCuratedReadonlyResult, curatedReadonlyFormatter, type CuratedReadonlyFormatter } from "./curated-readonly-presentation"

// Test-only actual pinned helper. Resolving the package does not evaluate its engine barrel/UI.
const actual = await import(new URL("./core/tools/truncate.js", import.meta.resolve("@code-yeongyu/senpi")).href)
const native: CuratedReadonlyFormatter = {
  maxBytes: actual.DEFAULT_MAX_BYTES, maxLines: actual.DEFAULT_MAX_LINES,
  truncateHead: actual.truncateHead, formatSize: actual.formatSize,
}
const texts = ["", "a", "\n", "a\n", "a\r\nb\r\n", "a".repeat(51200), "a".repeat(51201),
  "a".repeat(60000), "界".repeat(20000), "😀".repeat(16000), Array(2500).fill("x").join("\n"),
  Array(2000).fill("x").join("\n") + "\n", Array(2001).fill("x").join("\n"),
  ("first\n" + "界😀".repeat(8000) + "\nlast\n"), "\n".repeat(3000)]

test("required Core formatter agrees with actual Native default limits and size rounding", () => {
  expect(curatedReadonlyFormatter.maxBytes).toBe(native.maxBytes)
  expect(curatedReadonlyFormatter.maxLines).toBe(native.maxLines)
  for (const bytes of [0, 1, 1023, 1024, 1025, 51128, 51200, 60000, 1048575, 1048576, 12345678]) {
    expect(curatedReadonlyFormatter.formatSize(bytes)).toBe(native.formatSize(bytes))
  }
})

test("actual Native and pure head formatters agree at byte/line/trailing-newline boundaries", () => {
  for (const text of texts) for (const maxBytes of [1, 3, 7, 1024, 51200]) for (const maxLines of [1, 2, 1999, 2000]) {
    const options = { maxBytes, maxLines }
    const expected = native.truncateHead(text, options)
    const observed = curatedReadonlyFormatter.truncateHead(text, options)
    for (const key of ["content", "truncated", "truncatedBy", "totalLines", "totalBytes", "firstLineExceedsLimit"] as const) {
      expect(observed[key]).toEqual(expected[key])
    }
  }
})

test("Core cap uses actual formatter port and preserves exact Native-compatible output bytes", () => {
  for (const text of texts) {
    const output = capCuratedReadonlyResult(text, curatedReadonlyFormatter)
    expect(output).toBe(capCuratedReadonlyResult(text, native))
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(native.maxBytes)
    if (!native.truncateHead(text, { maxBytes: native.maxBytes, maxLines: native.maxLines }).truncated) expect(output).toBe(text)
    else {
      expect(output).toContain("[truncated:")
      expect(output).not.toContain("\ufffd")
      expect(output.split("\n").length).toBeLessThanOrEqual(native.maxLines)
    }
  }
})

test("line notice and single-line byte notice are exact; multibyte prefixes end on UTF8 boundaries", () => {
  expect(capCuratedReadonlyResult(Array(2500).fill("x").join("\n"), native)).toBe(
    Array(1999).fill("x").join("\n") + "\n[truncated: 1999 of 2500 lines. Narrow the request before retrying.]",
  )
  const notice = "[truncated: 49.9KB of 58.6KB. Narrow the request before retrying.]"
  expect(capCuratedReadonlyResult("a".repeat(60000), native)).toBe(
    "a".repeat(native.maxBytes - Buffer.byteLength("\n" + notice)) + "\n" + notice,
  )
  for (const symbol of ["界", "😀", "é"]) {
    const output = capCuratedReadonlyResult(symbol.repeat(60000), curatedReadonlyFormatter)
    const prefix = output.slice(0, output.lastIndexOf("\n"))
    expect(prefix).toBe(symbol.repeat([...prefix].length))
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(native.maxBytes)
  }
})
