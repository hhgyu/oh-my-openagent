import { afterAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { generatePalaceHtml } from "./generator"
import { collectPeople, type PalacePeopleNode } from "./people"
import { describePersonMiss } from "./people-query"
import {
  cleanupPalaceFixtures,
  createPalaceFixture,
  seedPalacePeople,
  writePalaceWorkingFile,
} from "./palace.test-support"

afterAll(cleanupPalaceFixtures)

const LIMITS = { maxEntries: 40, maxEntryChars: 200 } as const

function inlineJson(html: string): Record<string, unknown> {
  const match = html.match(
    /<script type="application\/json" id="omo-palace-data">([\s\S]*?)<\/script>/,
  )
  if (match?.[1] === undefined) throw new Error("palace html has no inline data script")
  const decoded = match[1]
    .replace(/\\u003c/g, "<")
    .replace(/\\u2028/g, "\u2028")
    .replace(/\\u2029/g, "\u2029")
  const parsed: unknown = JSON.parse(decoded)
  if (parsed === null || typeof parsed !== "object") throw new Error("palace data is not an object")
  return parsed as Record<string, unknown>
}

describe("palace people graph", () => {
  test("#given committed people cards #when the graph is collected #then nodes carry slug, name and kind from card frontmatter", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const people = await collectPeople(fixture.repo, fixture.head, { enabled: true, limits: LIMITS })

    expect(people?.nodes.map((node) => node.slug).sort()).toEqual(["human", "jane-doe", "sam-rivers"])
    const jane = people?.nodes.find((node) => node.slug === "jane-doe")
    expect(jane?.displayName).toBe("Jane Doe")
    expect(jane?.kind).toBe("person")
    expect(jane?.aliases).toEqual(["Jane", "JD"])
  }, 30_000)

  test("#given RELATIONSHIP card lines #when the graph is collected #then edges match those lines and resolve to known slugs", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const people = await collectPeople(fixture.repo, fixture.head, { enabled: true, limits: LIMITS })

    expect(people?.edges).toEqual([
      { source: "human", predicate: "works-with", target: "jane-doe", targetSlug: "jane-doe" },
      { source: "human", predicate: "mentors", target: "sam-rivers", targetSlug: "sam-rivers" },
      { source: "jane-doe", predicate: "reports-to", target: "human", targetSlug: "human" },
      { source: "sam-rivers", predicate: "collaborates", target: "unknown-person", targetSlug: undefined },
    ])
  }, 30_000)

  test("#given a card line that is not a RELATIONSHIP #when the graph is collected #then it produces no edge", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const people = await collectPeople(fixture.repo, fixture.head, { enabled: true, limits: LIMITS })

    expect(people?.edges.some((edge) => edge.predicate === "senior-engineer")).toBe(false)
    expect(people?.edges.every((edge) => edge.target.length > 0)).toBe(true)
  }, 30_000)

  test("#given an uncommitted people card #when the graph is collected #then the node is labelled as absent from the system prompt", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)
    await writePalaceWorkingFile(
      fixture,
      "people/kim-lee/card.md",
      '---\ndescription: Person - Kim Lee\nkind: person\naliases: ["Kim"]\n---\n\nIDENTITY: draft person\n',
    )

    const people = await collectPeople(fixture.repo, fixture.head, { enabled: true, limits: LIMITS })

    const kim = people?.nodes.find((node) => node.slug === "kim-lee")
    expect(kim?.state).toBe("uncommitted - not active in system prompt")
    expect(people?.nodes.find((node) => node.slug === "jane-doe")?.state).toBe("committed")
  }, 30_000)

  test("#given a repo without a people directory #when the graph is collected #then only the primary human node is present and no edges are derived", async () => {
    const fixture = await createPalaceFixture()

    const people = await collectPeople(fixture.repo, fixture.head, { enabled: true, limits: LIMITS })

    expect(people?.nodes.map((node) => node.slug)).toEqual(["human"])
    expect(people?.edges).toEqual([])
  }, 30_000)

  test("#given people.enabled false #when the graph is collected #then no people section is produced", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const people = await collectPeople(fixture.repo, fixture.head, { enabled: false, limits: LIMITS })

    expect(people).toBeUndefined()
  }, 30_000)

  test("#given a card whose entry exceeds the configured limit #when the graph is collected #then the diagnostic is surfaced with its card path", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const people = await collectPeople(fixture.repo, fixture.head, {
      enabled: true,
      limits: { maxEntries: 40, maxEntryChars: 10 },
    })

    expect(people?.diagnostics.some((entry) => entry.path === "people/jane-doe/card.md")).toBe(true)
  }, 30_000)

  test("#given people.enabled true #when the palace is generated #then the inline payload carries the derived graph", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const result = await generatePalaceHtml(fixture.context, { people: { enabled: true, limits: LIMITS } })
    const html = await readFile(result.path, "utf8")
    const data = inlineJson(html)

    const people = data.people
    expect(people).not.toBeUndefined()
    expect(JSON.stringify(people)).toContain("jane-doe")
    expect(html).toContain('data-tab="people"')
  }, 30_000)

  test("#given people.enabled false #when the palace is generated #then the panel and its tab are absent", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture)

    const result = await generatePalaceHtml(fixture.context, { people: { enabled: false, limits: LIMITS } })
    const html = await readFile(result.path, "utf8")
    const data = inlineJson(html)

    expect(data.people).toBeUndefined()
    expect(html).not.toContain('data-tab="people"')
    expect(html).not.toContain('id="panel-people"')
  }, 30_000)

  test("#given a people card carrying a script-breakout payload #when the palace is generated #then the raw payload never reaches the document", async () => {
    const fixture = await createPalaceFixture()
    await seedPalacePeople(fixture, { injection: true })

    const result = await generatePalaceHtml(fixture.context, { people: { enabled: true, limits: LIMITS } })
    const html = await readFile(result.path, "utf8")

    expect(html).not.toContain("</script><img")
    expect(JSON.stringify(inlineJson(html))).toContain("onerror=alert(1)")
  }, 30_000)
})

function personNode(slug: string): PalacePeopleNode {
  return { slug, path: `people/${slug}/card.md`, displayName: slug, kind: "person", aliases: [], state: "committed" }
}

describe("/people miss line", () => {
  test("#given an empty roster #when a name misses #then it says no people records exist yet", () => {
    // given
    const nodes: readonly PalacePeopleNode[] = []

    // when
    const line = describePersonMiss(nodes, "nobody-here", [])

    // then
    expect(line).toBe('no person matches "nobody-here"; no people records exist yet')
  })

  test("#given close slugs #when a name misses #then it names the closest slugs", () => {
    // given
    const nodes = [personNode("human"), personNode("jane-doe")]

    // when
    const line = describePersonMiss(nodes, "jane-do", ["jane-doe"])

    // then
    expect(line).toBe('no person matches "jane-do"; closest slugs: jane-doe')
  })

  test("#given records but no close slug #when a name misses #then it lists the known slugs, capped with a remainder count", () => {
    // given
    const few = [personNode("human"), personNode("jane-doe"), personNode("sam-rivers")]
    const many = Array.from({ length: 12 }, (_, index) => personNode(`person-${String(index).padStart(2, "0")}`))

    // when
    const fewLine = describePersonMiss(few, "nobody-here", [])
    const manyLine = describePersonMiss(many, "nobody-here", [])

    // then
    expect(fewLine).toBe('no person matches "nobody-here"; known slugs: human, jane-doe, sam-rivers')
    expect(manyLine).toBe(
      `no person matches "nobody-here"; known slugs: ${many.slice(0, 10).map((node) => node.slug).join(", ")} (+2 more)`,
    )
  })
})
