import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { locateSharedSkillFiles, NATIVE_SKILLS_DIRECTORY, registerSharedSkills } from "./shared-skills"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function bundleDirectory(skills: Record<string, string | null>): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-shared-skills-"))
  roots.push(directory)
  for (const [name, text] of Object.entries(skills)) {
    const skillDirectory = join(directory, NATIVE_SKILLS_DIRECTORY, name)
    mkdirSync(skillDirectory, { recursive: true })
    if (text !== null) writeFileSync(join(skillDirectory, "SKILL.md"), text)
  }
  return directory
}

function skillText(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n${body}\n`
}

function fakeSkillDomain(existing: { name: string }[] = []) {
  const catalog = [...existing] as Record<string, unknown>[]
  return {
    catalog,
    domain: {
      transform: async (callback: (editor: never) => void) => {
        callback({ list: () => catalog, add: (info: Record<string, unknown>) => catalog.push(info) } as never)
        return { dispose: async () => {} }
      },
    },
  }
}

describe("V2 shared skills", () => {
  test("#given staged skills #when located #then each with a SKILL.md is listed by name in order, and ulw-execute is left to its component", () => {
    // given
    const directory = bundleDirectory({
      programming: skillText("programming", "p"),
      "review-work": skillText("review-work", "r"),
      "ulw-execute": skillText("ulw-execute", "u"),
      "no-skill-file": null,
    })

    // when
    const files = locateSharedSkillFiles(directory)

    // then
    expect(files.map(({ name }) => name)).toEqual(["programming", "review-work"])
    expect(files[1]?.file).toBe(join(directory, NATIVE_SKILLS_DIRECTORY, "review-work", "SKILL.md"))
  })

  test("#given a bundle without staged skills #when located #then nothing is listed", () => {
    // given
    const directory = bundleDirectory({})

    // when
    const files = locateSharedSkillFiles(directory)

    // then
    expect(files).toEqual([])
  })

  test("#given staged skills #when they register #then OpenCode gets their frontmatter, real file path and the V2 text rewrites", async () => {
    // given
    const directory = bundleDirectory({
      "review-work": skillText("review-work", "run `todo`, record `senpi:<session_id>`, then `/goal clear`"),
    })
    const { catalog, domain } = fakeSkillDomain()

    // when
    await registerSharedSkills(domain, locateSharedSkillFiles(directory))

    // then
    expect(catalog).toEqual([
      {
        id: "review-work",
        name: "review-work",
        description: "review-work description",
        path: join(directory, NATIVE_SKILLS_DIRECTORY, "review-work", "SKILL.md"),
        content: "run `todowrite`, record `opencode:<session_id>`, then `/omo:goal clear`\n",
      },
    ])
  })

  test("#given the catalog already has some of the names #when they register #then those are kept, the others are added once, and no name is duplicated", async () => {
    // given
    const directory = bundleDirectory({
      debugging: skillText("debugging", "d"),
      "ulw-loop": skillText("ulw-loop", "staged loop"),
      programming: skillText("programming", "p"),
    })
    const { catalog, domain } = fakeSkillDomain([{ name: "debugging" }, { name: "ulw-loop" }])
    const files = locateSharedSkillFiles(directory)

    // when
    await registerSharedSkills(domain, files)
    await registerSharedSkills(domain, files)

    // then
    expect(catalog.map((skill) => skill.name)).toEqual(["debugging", "ulw-loop", "programming"])
    expect(catalog[0]).toEqual({ name: "debugging" })
  })

  test("#given the host's own skill has the same id under a display name #when a shared skill of that id registers #then the host's skill is kept", async () => {
    // given
    const directory = bundleDirectory({ browser: skillText("browser", "shared browser") })
    const { catalog, domain } = fakeSkillDomain([{ id: "browser", name: "Browser" } as { name: string }])

    // when
    await registerSharedSkills(domain, locateSharedSkillFiles(directory))

    // then
    expect(catalog).toEqual([{ id: "browser", name: "Browser" }])
  })

  test("#given nothing staged #when registering #then no catalog edit is made and the missing build is reported", async () => {
    // given
    const { catalog, domain } = fakeSkillDomain()
    const warn = spyOn(console, "warn").mockImplementation(() => {})

    // when
    const registration = await registerSharedSkills(domain, [])

    // then
    expect(registration).toBeUndefined()
    expect(catalog).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
