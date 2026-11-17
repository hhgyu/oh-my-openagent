// Parsers for `git ls-tree` and `git cat-file --batch` output.

import type { GitTreeBlobEntry, GitTreeSizedEntry } from "./repo-types"

export function parseLsTreeSized(stdout: string): GitTreeSizedEntry[] {
  const entries: GitTreeSizedEntry[] = []
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue
    const tab = record.indexOf("\t")
    if (tab === -1) continue
    const meta = record.slice(0, tab).trim().split(/\s+/)
    const path = record.slice(tab + 1)
    if (meta.length < 4 || path.length === 0) continue
    const size = meta[3]
    if (size === undefined || size === "-") continue
    const bytes = Number.parseInt(size, 10)
    if (!Number.isSafeInteger(bytes) || bytes < 0) continue
    entries.push({ path, bytes })
  }
  return entries
}

export function parseLsTreeBlobs(stdout: string): GitTreeBlobEntry[] {
  const entries: GitTreeBlobEntry[] = []
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t")
    if (tab === -1) continue
    const [, type, oid] = record.slice(0, tab).trim().split(/\s+/)
    const path = record.slice(tab + 1)
    if (type !== "blob" || oid === undefined || path.length === 0) continue
    entries.push({ path, oid })
  }
  return entries
}

export interface CatFileRecord {
  readonly header: string
  readonly oid: string
  readonly type?: string
  readonly content?: string
}

/**
 * `<oid> <type> <size>\n<content>\n` records in input order. A header with fewer than three fields or
 * ending in ` missing` (the query echoed back, which may hold spaces for a `:<path>` query) carries no
 * content.
 */
export function parseCatFileRecords(output: Buffer): CatFileRecord[] {
  const records: CatFileRecord[] = []
  let offset = 0
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset)
    if (newline === -1) throw new Error("git cat-file --batch output ended inside a record header")
    const header = output.toString("utf8", offset, newline)
    offset = newline + 1
    const [oid = "", type, sizeText] = header.split(" ")
    if (sizeText === undefined || header.endsWith(" missing")) {
      records.push({ header, oid })
      continue
    }
    const size = Number.parseInt(sizeText, 10)
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > output.length) {
      throw new Error(`git cat-file --batch output is malformed at "${header}"`)
    }
    records.push({ header, oid, type, content: output.toString("utf8", offset, offset + size) })
    offset += size + 1
  }
  return records
}

export function parseCatFileBatch(output: Buffer): Map<string, string> {
  const blobs = new Map<string, string>()
  for (const { oid, type, content } of parseCatFileRecords(output)) {
    if (type === "blob" && content !== undefined) blobs.set(oid, content)
  }
  return blobs
}
