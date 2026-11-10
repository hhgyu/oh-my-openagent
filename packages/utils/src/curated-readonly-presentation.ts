import { Buffer } from "node:buffer"

export interface CuratedReadonlyHead {
  readonly content: string
  readonly truncated: boolean
  readonly truncatedBy: "bytes" | "lines" | null
  readonly totalLines: number
  readonly totalBytes: number
  readonly firstLineExceedsLimit: boolean
}

/** Native supplies its real helpers; an explicit pure formatter is available to other hosts. */
export interface CuratedReadonlyFormatter {
  readonly maxBytes: number
  readonly maxLines: number
  readonly truncateHead: (text: string, options: { readonly maxBytes: number; readonly maxLines: number }) => CuratedReadonlyHead
  readonly formatSize: (bytes: number) => string
}

/** Original curated retrieval presentation policy, independent of command execution or host SDK. */
export function capCuratedReadonlyResult(text: string, formatter: CuratedReadonlyFormatter): string {
  const boundary = formatter.truncateHead(text, { maxBytes: formatter.maxBytes, maxLines: formatter.maxLines })
  if (!boundary.truncated) return text

  let notice = buildTruncationNotice(boundary.truncatedBy, "", boundary.totalLines, boundary.totalBytes, formatter)
  let content = ""
  for (let pass = 0; pass < 4; pass += 1) {
    const contentBytes = formatter.maxBytes - Buffer.byteLength(`\n${notice}`)
    const truncation = formatter.truncateHead(text, { maxBytes: contentBytes, maxLines: formatter.maxLines - 1 })
    content = truncation.firstLineExceedsLimit ? truncateUtf8Prefix(text, contentBytes) : truncation.content
    const nextNotice = buildTruncationNotice(boundary.truncatedBy, content, boundary.totalLines, boundary.totalBytes, formatter)
    if (Buffer.byteLength(nextNotice) === Buffer.byteLength(notice)) {
      notice = nextNotice
      break
    }
    notice = nextNotice
  }
  return `${content}\n${notice}`
}

function buildTruncationNotice(
  truncatedBy: "bytes" | "lines" | null, content: string, totalLines: number, totalBytes: number,
  formatter: CuratedReadonlyFormatter,
): string {
  const shown = truncatedBy === "lines"
    ? `${content.length === 0 ? 0 : content.split("\n").length} of ${totalLines} lines`
    : `${formatter.formatSize(Buffer.byteLength(content))} of ${formatter.formatSize(totalBytes)}`
  return `[truncated: ${shown}. Narrow the request before retrying.]`
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  let end = Math.min(maxBytes, bytes.length)
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString("utf8")
}

/** Pure V2 formatter: complete-line head semantics and Native size rounding, not a display stub. */
export const curatedReadonlyFormatter: CuratedReadonlyFormatter = Object.freeze({
  maxBytes: 50 * 1024,
  maxLines: 2000,
  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  },
  truncateHead(text: string, { maxBytes, maxLines }: { readonly maxBytes: number; readonly maxLines: number }): CuratedReadonlyHead {
    const totalBytes = Buffer.byteLength(text, "utf-8")
    const lines = text.length === 0 ? [] : text.split("\n")
    if (text.endsWith("\n")) lines.pop()
    const totalLines = lines.length
    if (totalLines <= maxLines && totalBytes <= maxBytes) {
      return { content: text, truncated: false, truncatedBy: null, totalLines, totalBytes, firstLineExceedsLimit: false }
    }
    if (Buffer.byteLength(lines[0]!, "utf-8") > maxBytes) {
      return { content: "", truncated: true, truncatedBy: "bytes", totalLines, totalBytes, firstLineExceedsLimit: true }
    }
    const output: string[] = []
    let outputBytes = 0
    let truncatedBy: "bytes" | "lines" = "lines"
    for (let index = 0; index < lines.length && index < maxLines; index += 1) {
      const line = lines[index]!
      const bytes = Buffer.byteLength(line, "utf-8") + (index > 0 ? 1 : 0)
      if (outputBytes + bytes > maxBytes) { truncatedBy = "bytes"; break }
      output.push(line)
      outputBytes += bytes
    }
    if (output.length >= maxLines && outputBytes <= maxBytes) truncatedBy = "lines"
    return { content: output.join("\n"), truncated: true, truncatedBy, totalLines, totalBytes, firstLineExceedsLimit: false }
  },
})
