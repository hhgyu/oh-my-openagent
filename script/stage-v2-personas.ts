import { mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

type PersonaArtifacts = { stageRuntimePersonas(repoRoot: string, outputDir: string): Promise<void> }

/**
 * memory-core loads persona markdown from the directory of the running bundle chunk. The OpenCode
 * builds split chunks into dist/ (root entry, which lazily loads V2) and dist/v2, so both receive
 * the personas. Without them the Kibitzer agent transform fails and the host disables the plugin.
 */
async function stageV2Personas(repoRoot: string): Promise<void> {
	// The SAME runtime persona list the Senpi plugin build stages next to its bundle (untyped .mjs).
	const artifacts = pathToFileURL(join(repoRoot, "packages", "omo-senpi", "plugin", "scripts", "persona-artifacts.mjs")).href
	const { stageRuntimePersonas } = (await import(artifacts)) as PersonaArtifacts
	for (const outputDir of [join(repoRoot, "dist"), join(repoRoot, "dist", "v2")]) {
		await mkdir(outputDir, { recursive: true })
		await stageRuntimePersonas(repoRoot, outputDir)
	}
}

if (import.meta.main) await stageV2Personas(resolve(import.meta.dir, ".."))
