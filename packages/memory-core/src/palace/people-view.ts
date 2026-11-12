// The read side of `/people`, moved here from omo-senpi `components/memory/commands/people-runtime.ts` so
// every host derives the same roster, card and observations. The graph is DERIVED on every read from the
// `RELATIONSHIP: <predicate>: <target>` lines of `system/human.md` and `people/*/card.md` through the
// palace collector, so the panel and the command share one parser; it is never stored.

import { join } from "node:path"

import { readFile } from "../fs/resilient"
import type { GitMemoryRepo } from "../git/repo"
import type { ObservationGroup, PeopleLimits } from "../people"
import { collectPeople, type PalacePeople } from "./people"
import { parsePeopleObservations } from "./people-render"

/** Fixed render budget per observation level; deliberately NOT a config knob. */
export const OBSERVATIONS_PER_LEVEL = 20

/** Derives the roster and the adjacency graph from the person cards in the repository. */
export async function derivePeopleGraph(repo: GitMemoryRepo, limits: PeopleLimits): Promise<PalacePeople> {
  const head = await repo.head()
  const people = await collectPeople(repo, head, { enabled: true, limits })
  return people ?? { nodes: [], edges: [], diagnostics: [] }
}

/** A person file from the working tree, else from HEAD; undefined when neither has it. */
export async function readPersonFile(repo: GitMemoryRepo, path: string): Promise<string | undefined> {
  const working = await readFile(join(repo.dir, path), "utf8").catch(() => undefined)
  if (working !== undefined) return working
  const head = await repo.head()
  if (head === null) return undefined
  return repo.show(head, path).catch(() => undefined)
}

/** Newest-first per level, capped at OBSERVATIONS_PER_LEVEL unless `all` is set. */
export async function selectPersonObservations(
  repo: GitMemoryRepo,
  slug: string,
  limits: PeopleLimits,
  options: { readonly all: boolean },
): Promise<readonly ObservationGroup[]> {
  const raw = await readPersonFile(repo, `people/${slug}/observations.md`)
  if (raw === undefined) return []
  const groups = parsePeopleObservations(raw, limits)
  return groups.map((group) => {
    const sorted = [...group.entries].sort(byDateDescending)
    return { section: group.section, entries: options.all ? sorted : sorted.slice(0, OBSERVATIONS_PER_LEVEL) }
  })
}

function byDateDescending(left: { readonly date: string }, right: { readonly date: string }): number {
  return right.date.localeCompare(left.date)
}
