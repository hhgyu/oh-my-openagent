import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const runner = fileURLToPath(new URL("./ci-windows-shard-1.ts", import.meta.url))
const targets = ["omo-opencode", "memory-core"]

describe("Windows shard 1 CLI", () => {
  for (const failing of [[], ["omo-opencode"], ["memory-core"], targets]) {
    test(`#given failing packages ${JSON.stringify(failing)} #when both run #then coverage overlaps and both outcomes are joined`, async () => {
      // given: real package trees, with two discovered files per target.
      const root = mkdtempSync(join(tmpdir(), "windows-shard-1-"))
      try {
        writeFileSync(join(root, "bunfig.toml"), '[test]\npreload = ["./preload.ts"]\n')
        writeFileSync(
          join(root, "preload.ts"),
          'import { appendFileSync } from "node:fs"; appendFileSync("preloads", String(process.pid) + "\\n");',
        )
        for (const target of targets) {
          const directory = join(root, "packages", target)
          mkdirSync(directory, { recursive: true })
          writeFileSync(
            join(directory, "rendezvous.test.ts"),
            `import { test, expect } from "bun:test";
import { existsSync, writeFileSync, appendFileSync } from "node:fs";
test("rendezvous-${target}", async () => {
  writeFileSync(${JSON.stringify(`${target}.started`)}, String(process.pid));
  const deadline = Date.now() + 3000;
  while (!existsSync(${JSON.stringify(`${targets.find((name) => name !== target)}.started`)})) {
    if (Date.now() > deadline) throw new Error("packages did not overlap");
    await Bun.sleep(20);
  }
  await Bun.sleep(${target === "memory-core" ? 300 : 0});
  appendFileSync("receipts", ${JSON.stringify(`${target}:rendezvous\n`)});
  expect(${failing.includes(target)}).toBe(false);
});`,
          )
          writeFileSync(
            join(directory, "nested.test.ts"),
            `import { test } from "bun:test";
import { appendFileSync } from "node:fs";
test("coverage-${target}", () => {
  appendFileSync("receipts", ${JSON.stringify(`${target}:nested\n`)});
  console.log("stdout-${target}");
  console.error("stderr-${target}");
});`,
          )
        }
        // when: use the same CLI as CI, with no injected spawn implementation.
        const child = Bun.spawn([process.execPath, runner, "logs"], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        })
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        // then: a failing sibling cannot short circuit package coverage.
        expect(code, stdout + stderr).toBe(failing.length === 0 ? 0 : 1)
        expect(readFileSync(join(root, "receipts"), "utf8").trim().split("\n").sort()).toEqual(
          targets.flatMap((name) => [`${name}:nested`, `${name}:rendezvous`]).sort(),
        )
        expect(readFileSync(join(root, "preloads"), "utf8").trim().split("\n").sort()).toEqual(
          targets.map((target) => readFileSync(join(root, `${target}.started`), "utf8")).sort(),
        )
        for (const target of targets) {
          const log = readFileSync(join(root, "logs", `${target}.log`), "utf8")
          expect(log).toContain(`stdout-${target}`)
          expect(log).toContain(`stderr-${target}`)
          expect(log).not.toContain(`stdout-${targets.find((name) => name !== target)}`)
          expect(stdout).toContain(`${target}: exit ${failing.includes(target) ? 1 : 0}`)
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 15000)
  }

  test("#given a test exceeding Bun's default budget #when the CLI runs #then the unchanged Windows budget reaches both packages", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "windows-shard-timeout-"))
    try {
      for (const target of targets) {
        const directory = join(root, "packages", target)
        mkdirSync(directory, { recursive: true })
        writeFileSync(
          join(directory, "budget.test.ts"),
          'import { test } from "bun:test"; test("over default budget", async () => { await Bun.sleep(5500) });',
        )
      }
      // when
      const child = Bun.spawn([process.execPath, runner, "logs"], { cwd: root, stdout: "ignore", stderr: "pipe" })
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      // then
      expect(code, stderr).toBe(0)
      const results = JSON.parse(readFileSync(join(root, "logs", "shard-1-packages.json"), "utf8"))
      expect(results.map((result: { value: { args: string[] } }) => result.value.args)).toEqual(
        targets.map((target) => ["test", "--timeout", "30000", `packages/${target}`]),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15000)

  test("#given live package descendants #when the CI process tree is cancelled #then no owned process survives", async () => {
    // given: actual Bun test processes, each owning a long-lived descendant.
    const root = mkdtempSync(join(tmpdir(), "windows-shard-cancel-"))
    let child: ReturnType<typeof Bun.spawn> | undefined
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const cancel = () => {
      if (!child || !alive(child.pid)) return
      if (process.platform === "win32") {
        // Windows TerminateProcess cannot deliver POSIX signals. Exercise the
        // same ancestor-tree termination used when CI kills its outer shell.
        const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" })
        expect(killed.status, killed.stdout + killed.stderr).toBe(0)
      } else {
        child.kill("SIGTERM")
      }
    }
    try {
      for (const target of targets) {
        const directory = join(root, "packages", target)
        mkdirSync(directory, { recursive: true })
        writeFileSync(
          join(directory, "descendant.test.ts"),
          `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("live descendant", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  writeFileSync("${target}.pids", JSON.stringify([process.pid, child.pid]));
  await Bun.sleep(20000);
});`,
        )
      }
      child = Bun.spawn([process.execPath, runner, "logs"], { cwd: root, stdout: "ignore", stderr: "ignore" })
      const deadline = Date.now() + 5000
      while (!targets.every((target) => existsSync(join(root, `${target}.pids`)))) {
        if (Date.now() > deadline) throw new Error("package descendants did not start")
        await Bun.sleep(20)
      }
      const pids: number[] = targets.flatMap((target) => JSON.parse(readFileSync(join(root, `${target}.pids`), "utf8")))
      expect(pids.every(alive)).toBe(true)
      // when
      cancel()
      expect(await child.exited).not.toBe(0)
      // then
      const cleanupDeadline = Date.now() + 3000
      while (pids.some(alive) && Date.now() < cleanupDeadline) await Bun.sleep(20)
      expect(pids.filter(alive)).toEqual([])
    } finally {
      cancel()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15000)
})
