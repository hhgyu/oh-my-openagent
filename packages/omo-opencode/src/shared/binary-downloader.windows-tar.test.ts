import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "bun"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTarCommand } from "@oh-my-opencode/utils/zip-entry-listing"

// Git for Windows puts GNU tar in usr/bin; first on PATH it reads `C:\...` as a remote host and every Windows
// extraction failed. A stand-in `tar.exe` that cannot list or extract anything takes that slot here.
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function extractInChild(fn: "extractTarGz" | "extractZipArchive", archive: string, dest: string, binDir: string) {
  const driver = [
    `const mod = await import(${JSON.stringify(join(import.meta.dir, "binary-downloader.ts"))})`,
    "try {",
    `\tawait mod.${fn}(process.env.TAR_PROBE_ARCHIVE, process.env.TAR_PROBE_DEST)`,
    '\tconsole.log("extracted")',
    "} catch (error) {",
    "\tconsole.log(error instanceof Error ? error.message : String(error))",
    "}",
  ].join("\n")
  const result = spawnSync([process.execPath, "-e", driver], {
    env: {
      ...process.env,
      PATH: `${binDir};${process.env.PATH ?? ""}`,
      TAR_PROBE_ARCHIVE: archive,
      TAR_PROBE_DEST: dest,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    windowsHide: true,
  })
  return result.stdout.toString().trim()
}

describe.skipIf(process.platform !== "win32")("archive extraction with another tar first on PATH (Windows)", () => {
  for (const [label, fn, archiveName, createArgs] of [
    ["a tar.gz", "extractTarGz", "asset.tar.gz", ["-czf"]],
    ["a zip", "extractZipArchive", "asset.zip", ["-a", "-cf"]],
  ] as const) {
    test(`#given ${label} and a foreign tar.exe first on PATH #when extracted #then the bundled bsdtar extracts it`, () => {
      // given
      const root = mkdtempSync(join(tmpdir(), "omo-windows-tar-"))
      roots.push(root)
      const stage = join(root, "stage")
      const dest = join(root, "dest")
      const binDir = join(root, "foreign-bin")
      for (const dir of [stage, dest, binDir]) mkdirSync(dir)
      writeFileSync(join(stage, "comment-checker.exe"), "fixture-checker")
      const archive = join(root, archiveName)
      const created = spawnSync([resolveTarCommand(), ...createArgs, archive, "-C", stage, "comment-checker.exe"], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      })
      expect(created.exitCode).toBe(0)
      copyFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"), join(binDir, "tar.exe"))

      // when
      const outcome = extractInChild(fn, archive, dest, binDir)

      // then
      expect(outcome).toBe("extracted")
      expect(readFileSync(join(dest, "comment-checker.exe"), "utf8")).toBe("fixture-checker")
    })
  }
})
