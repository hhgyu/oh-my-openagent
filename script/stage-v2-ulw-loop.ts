import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { rewriteUlwLoopSkillForV2 } from "../packages/omo-opencode/src/v2/ulw-loop/skill"

/**
 * Stages the OpenCode 2 ulw-loop runtime next to the V2 chunks in dist/ (the root entry lazily loads V2) and
 * dist/v2: the agent-toolkit SDK an eval cell imports from `OMO_AGENT_TOOLKIT_SDK_ROOT`, built from the same
 * shared session SDK the Senpi bundle uses, and the ulw-loop skill the V2 host registers, copied from the Senpi
 * skill with only the tool names OpenCode 2 spells differently rewritten.
 */
const SKILL_SOURCE = join("packages", "omo-senpi", "skills", "ulw-loop")
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

async function stageSkill(source: string, target: string): Promise<void> {
  await rm(target, { recursive: true, force: true })
  await cp(source, target, { recursive: true })
  for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue
    const path = join(entry.parentPath, entry.name)
    const text = await readFile(path, "utf8")
    const rewritten = rewriteUlwLoopSkillForV2(text)
    if (rewritten !== text) await writeFile(path, rewritten)
  }
}

async function stageV2UlwLoop(repoRoot: string): Promise<void> {
  const sdk = await buildSdk(repoRoot)
  for (const outputDir of [join(repoRoot, "dist"), join(repoRoot, "dist", "v2")]) {
    await mkdir(join(outputDir, "agent-toolkit-sdk"), { recursive: true })
    await writeFile(join(outputDir, "agent-toolkit-sdk", "sdk.js"), sdk)
    await stageSkill(join(repoRoot, SKILL_SOURCE), join(outputDir, "skills", "ulw-loop"))
  }
}

if (import.meta.main) await stageV2UlwLoop(resolve(import.meta.dir, ".."))
