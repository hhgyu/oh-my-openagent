// Report-once bookkeeping for stranded transient identities (issue #8646; moved from omo-senpi transient-stranded.ts).

import { basename, dirname, join } from "node:path"

import { existsSync, mkdir, readdir, rm, writeFile } from "../fs/resilient"
import type { TransientWarn } from "./identity"

/**
 * A stranded identity's conflict is terminal - the sweep never merges into an existing durable
 * identity - so it is reported once and then only counted. The record of that report lives beside
 * the run roots, in this dot-named directory of the transient area, never inside a run: the sweep
 * decides a run is idle from the mtimes under its root, so a record written there would make the
 * run look active and delay its promotion. Dot-named entries are never listed as runs.
 */
export const STRANDED_REPORTS_DIRNAME = ".stranded-reported"

const RECORD_SEPARATOR = "__"

/** The report-once record for one identity of one run: `<area>/.stranded-reported/<token>__<identity>`. */
export function strandedReportPath(runRoot: string, identity: string): string {
  return join(dirname(runRoot), STRANDED_REPORTS_DIRNAME, `${basename(runRoot)}${RECORD_SEPARATOR}${identity}`)
}

export async function reportStrandedOnce(input: {
  readonly from: string
  readonly to: string
  readonly record: string
  readonly warn?: TransientWarn
  readonly logPrefix?: string
}): Promise<void> {
  if (existsSync(input.record)) return
  const prefix = input.logPrefix ?? "memory"
  input.warn?.(`${prefix} transient run holds memory a durable identity already owns`, {
    from: input.from,
    to: input.to,
    promotable: false,
    action: "merge or remove one of the two identity roots by hand; the sweep keeps both and reports this once",
  })
  try {
    await mkdir(dirname(input.record), { recursive: true })
    await writeFile(input.record, `${JSON.stringify({ from: input.from, to: input.to })}\n`)
  } catch (error) {
    input.warn?.(`${prefix} stranded-run report record write failed`, {
      record: input.record,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** A promoted identity is no longer stranded: its report record goes with it. */
export async function clearStrandedReport(record: string, warn?: TransientWarn, logPrefix = "memory"): Promise<void> {
  try {
    await rm(record, { force: true })
  } catch (error) {
    warn?.(`${logPrefix} stranded-run report record cleanup failed`, {
      record,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Drops the records of runs that no longer exist (removed by the sweep or by hand). */
export async function pruneStrandedReports(area: string, warn?: TransientWarn, logPrefix = "memory"): Promise<void> {
  const reports = join(area, STRANDED_REPORTS_DIRNAME)
  let names: string[]
  try {
    names = await readdir(reports)
  } catch {
    return
  }
  for (const name of names) {
    const separator = name.indexOf(RECORD_SEPARATOR)
    if (separator <= 0 || existsSync(join(area, name.slice(0, separator)))) continue
    await clearStrandedReport(join(reports, name), warn, logPrefix)
  }
}
