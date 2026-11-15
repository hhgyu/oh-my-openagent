/// <reference path="../../../../bun-test.d.ts" />
/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finalizeCachedPluginPayload } from "./codex-cache-payload"

async function createLinkedPackageChain(root: string): Promise<string> {
  const coreDir = join(root, "source", "core")
  const daemonDir = join(root, "source", "daemon")
  const depDir = join(root, "source", "dep")
  const pluginDir = join(root, "plugin")
  await mkdir(join(coreDir, "node_modules"), { recursive: true })
  await mkdir(join(daemonDir, "node_modules"), { recursive: true })
  await mkdir(depDir, { recursive: true })
  await mkdir(join(pluginDir, "node_modules"), { recursive: true })
  await writeFile(join(depDir, "index.js"), "export const dep = 1\n")
  await writeFile(join(coreDir, "index.js"), "export const core = 1\n")
  await writeFile(join(daemonDir, "index.js"), "export const daemon = 1\n")
  // Bun writes workspace links as relative directory symlinks next to the package.
  await symlink(join("..", "..", "dep"), join(coreDir, "node_modules", "dep"), "dir")
  // npm writes file: links as absolute junctions on Windows (plain symlinks elsewhere).
  await symlink(coreDir, join(daemonDir, "node_modules", "core"), "junction")
  await symlink(daemonDir, join(pluginDir, "node_modules", "daemon"), "junction")
  return pluginDir
}

describe("finalizeCachedPluginPayload", () => {
  describe("#given a linked package whose nested link is relative and reached through another link", () => {
    test("#when finalizing the cached payload #then the nested link resolves against its real location", async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), "omo-codex-cache-payload-"))
      try {
        const pluginDir = await createLinkedPackageChain(root)

        // when
        await finalizeCachedPluginPayload(pluginDir)

        // then
        const daemonPath = join(pluginDir, "node_modules", "daemon")
        const nestedDepPath = join(daemonPath, "node_modules", "core", "node_modules", "dep")
        expect((await lstat(daemonPath)).isDirectory()).toBe(true)
        expect((await lstat(nestedDepPath)).isDirectory()).toBe(true)
        expect(await readFile(join(nestedDepPath, "index.js"), "utf8")).toBe("export const dep = 1\n")
        expect(await readFile(join(daemonPath, "index.js"), "utf8")).toBe("export const daemon = 1\n")
        expect(await readFile(join(root, "source", "dep", "index.js"), "utf8")).toBe("export const dep = 1\n")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })

  describe("#given a dangling link outside node_modules/.bin", () => {
    test("#when finalizing the cached payload #then it fails instead of silently dropping the entry", async () => {
      // given
      const root = await mkdtemp(join(tmpdir(), "omo-codex-cache-payload-dangling-"))
      try {
        const pluginDir = join(root, "plugin")
        await mkdir(join(pluginDir, "node_modules"), { recursive: true })
        await symlink(join(root, "missing"), join(pluginDir, "node_modules", "gone"), "junction")

        // when
        const result = finalizeCachedPluginPayload(pluginDir)

        // then
        await expect(result).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})
