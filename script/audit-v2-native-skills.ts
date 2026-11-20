import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { auditStagedSkills } from "../packages/omo-opencode/src/v2/skills/native-skill-audit"

const root = resolve(import.meta.dir, "..", "dist", "v2", "native-skills")
const reportIndex = process.argv.indexOf("--report")
const reportPath = reportIndex === -1 ? undefined : process.argv[reportIndex + 1]

const hits = auditStagedSkills(root)
const mandatory = hits.filter((hit) => hit.class === "MANDATORY")
const lines = ["| class | rule | file:line | reason |", "| --- | --- | --- | --- |"]
for (const hit of [...hits].sort((a, b) => a.class.localeCompare(b.class) || a.rule.localeCompare(b.rule)))
  lines.push(`| ${hit.class} | ${hit.rule} | ${hit.file}:${hit.line} | ${hit.reason} |`)

if (reportPath !== undefined) {
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${lines.join("\n")}\n`)
}
console.log(`audit: ${hits.length} hits, ${mandatory.length} MANDATORY`)
for (const hit of mandatory) console.error(`MANDATORY ${hit.rule} ${hit.file}:${hit.line}: ${hit.text}`)
process.exit(mandatory.length === 0 ? 0 : 1)
