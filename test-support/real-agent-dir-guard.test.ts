import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { projectStateKey } from "../packages/senpi-task/src/store/project-state-directory"
import { isInside, testProjectStateCreatedIn } from "./real-agent-dir-guard"

describe("testProjectStateCreatedIn", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function scratch(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }

  test("#given a state folder keyed by a project under a temp root #when it was created during this run #then it is reported", () => {
    // given
    const tempRoot = scratch("omo-guard-temp-")
    const projects = scratch("omo-guard-projects-")
    const key = projectStateKey(join(tempRoot, "C2G-cold-abc123"))
    mkdirSync(join(projects, key, "senpi-task"), { recursive: true })

    // when
    const leaked = testProjectStateCreatedIn(projects, [tempRoot], Date.now() - 60_000)

    // then
    expect(leaked).toEqual([join(projects, key)])
  })

  test("#given a temp-keyed state folder older than this run #when the guard scans #then it is not reported", () => {
    // given
    const tempRoot = scratch("omo-guard-temp-")
    const projects = scratch("omo-guard-projects-")
    mkdirSync(join(projects, projectStateKey(join(tempRoot, "omo-a5-cold-xyz789"))))

    // when
    const leaked = testProjectStateCreatedIn(projects, [tempRoot], Date.now() + 60_000)

    // then
    expect(leaked).toEqual([])
  })

  test("#given a state folder for a project outside every temp root #when the guard scans #then it is not reported", () => {
    // given
    const tempRoot = scratch("omo-guard-temp-")
    const projects = scratch("omo-guard-projects-")
    mkdirSync(join(projects, projectStateKey(join(scratch("omo-guard-elsewhere-"), "real-project"))))
    mkdirSync(join(projects, "not-a-project-key"))

    // when
    const leaked = testProjectStateCreatedIn(projects, [tempRoot], Date.now() - 60_000)

    // then
    expect(leaked).toEqual([])
  })

  test("#given no projects folder #when the guard scans #then nothing is reported", () => {
    expect(testProjectStateCreatedIn(join(scratch("omo-guard-empty-"), "projects"), [tmpdir()])).toEqual([])
  })
})

describe("isInside", () => {
  test("#given paths below, equal to and beside a root #when compared #then only the path below counts", () => {
    const root = join(tmpdir(), "root")
    expect(isInside(root, join(root, "a", "b"))).toBe(true)
    expect(isInside(root, root)).toBe(false)
    expect(isInside(root, join(tmpdir(), "root-sibling"))).toBe(false)
  })
})
