import { copyFile, mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

const V2_COMPUTER_ASSETS = {
  prelude: "assets.generated.json",
  runWorker: "omo-computer-run-worker.mjs",
  wasm: "quickjs.wasm",
} as const

/**
 * The computer-use prelude JSON is read beside the running chunk, and the `computer.run_sandbox: "quickjs"` cell
 * spawns its worker and wasm from beside it (Native stages the same three files beside `omo-computer-use.js`).
 * The OpenCode builds split chunks into dist/ (root entry, which lazily loads V2) and dist/v2, so both get them.
 */
async function stageV2ComputerAssets(repoRoot: string): Promise<void> {
  const prelude = join(repoRoot, "packages", "senpi-desktop-prelude", "src", V2_COMPUTER_ASSETS.prelude)
  const serviceRoot = join(repoRoot, "packages", "senpi-desktop-service")
  const wasm = createRequire(join(serviceRoot, "package.json")).resolve(`quickjs-wasi/${V2_COMPUTER_ASSETS.wasm}`)
  const worker = await Bun.build({
    entrypoints: [join(serviceRoot, "src", "run", "sandbox", "worker.ts")],
    target: "node",
    format: "esm",
  })
  if (!worker.success || worker.outputs.length !== 1 || worker.outputs[0] === undefined) {
    throw new AggregateError(worker.logs, "computer run worker build failed")
  }
  const workerSource = await worker.outputs[0].text()
  for (const outputDir of [join(repoRoot, "dist"), join(repoRoot, "dist", "v2")]) {
    await mkdir(outputDir, { recursive: true })
    await copyFile(prelude, join(outputDir, V2_COMPUTER_ASSETS.prelude))
    await copyFile(wasm, join(outputDir, V2_COMPUTER_ASSETS.wasm))
    await Bun.write(join(outputDir, V2_COMPUTER_ASSETS.runWorker), workerSource)
  }
}

if (import.meta.main) await stageV2ComputerAssets(resolve(import.meta.dir, ".."))
