// The host-neutral memory palace: the HTML viewer generator, its collectors, and the `/people` read side.
export { collectReflection } from "./collectors"
export type {
  PalaceCommit,
  PalaceCoreEntry,
  PalaceEntryState,
  PalaceExternalEntry,
  PalaceHistory,
  PalaceHistoryCaps,
  PalaceReflection,
  PalaceReflectionOutcome,
} from "./collectors"
export { generatePalaceHtml } from "./generator"
export type {
  GeneratePalaceOptions,
  GeneratePalaceResult,
  PalaceData,
  PalaceIdentityContext,
  PalaceMetadata,
} from "./generator"
export type {
  PalacePeople,
  PalacePeopleDiagnostic,
  PalacePeopleEdge,
  PalacePeopleNode,
  PalacePeopleOptions,
} from "./people"
export { describePersonMiss, resolvePersonQuery, type PersonQueryResolution } from "./people-query"
export { parsePeopleCardLines, renderPersonCard, renderRoster } from "./people-render"
export { OBSERVATIONS_PER_LEVEL, derivePeopleGraph, readPersonFile, selectPersonObservations } from "./people-view"
