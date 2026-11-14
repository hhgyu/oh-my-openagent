import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stageNativeSharedSkill } from "../packages/omo-senpi/plugin/scripts/sync-skills.mjs"
import { rewriteSkillForV2 } from "../packages/omo-opencode/src/v2/skills/staged-skill"

/**
 * Stages the OpenCode 2 ulw runtime next to the V2 chunks in dist/ (the root entry lazily loads V2) and dist/v2: the
 * agent-toolkit SDK an eval cell imports from `OMO_AGENT_TOOLKIT_SDK_ROOT`, built from the same shared session SDK the
 * Senpi bundle uses, and the ulw-loop and ulw-execute skills the V2 host registers. Both are the Native (omo-senpi)
 * texts: ulw-loop from its source, ulw-execute through the Senpi sync's own shared-skill adaptation; then only the
 * spellings OpenCode 2 differs on are rewritten (rewriteSkillForV2).
 */
const ULW_LOOP_SOURCE = join("packages", "omo-senpi", "skills", "ulw-loop")
const SDK_ENTRY = join("packages", "omo-codex", "plugin", "components", "ulw-loop", "src", "session-sdk", "index.ts")

async function buildSdk(repoRoot: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(repoRoot, SDK_ENTRY)],
    target: "node",
    format: "esm",
    minify: { syntax: true, whitespace: true },
  })
  const [output] = result.outputs
  if (!result.success || output === undefined || result.outputs.length !== 1)
    throw new AggregateError(result.logs, "agent-toolkit SDK build failed")
  return output.text()
}

async function rewriteTree(target: string): Promise<void> {
  for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const path = join(entry.parentPath, entry.name)
    const text = await readFile(path, "utf8")
    const rewritten = rewriteSkillForV2(text)
    if (rewritten !== text) await writeFile(path, rewritten)
  }
}

async function stageV2UlwLoop(repoRoot: string): Promise<void> {
  const sdk = await buildSdk(repoRoot)
  for (const outputDir of [join(repoRoot, "dist"), join(repoRoot, "dist", "v2")]) {
    await mkdir(join(outputDir, "agent-toolkit-sdk"), { recursive: true })
    await writeFile(join(outputDir, "agent-toolkit-sdk", "sdk.js"), sdk)
    const ulwLoop = join(outputDir, "skills", "ulw-loop")
    await rm(ulwLoop, { recursive: true, force: true })
    await cp(join(repoRoot, ULW_LOOP_SOURCE), ulwLoop, { recursive: true })
    await rewriteTree(ulwLoop)
    const ulwExecute = join(outputDir, "skills", "ulw-execute")
    await rm(ulwExecute, { recursive: true, force: true })
    await stageNativeSharedSkill("ulw-execute", ulwExecute)
    await rewriteTree(ulwExecute)
  }
}

if (import.meta.main) await stageV2UlwLoop(resolve(import.meta.dir, ".."))
