// Sidecar retention lives in memory-core retention/sidecars.ts so the maintenance pass can run it
// across sessions; the recall sidecar keeps exporting it from here.
export {
  KIBITZER_SIDECAR_RETENTION_MS,
  pruneKibitzerSidecars,
  type PruneKibitzerSidecarsOptions,
  type PruneKibitzerSidecarsResult,
} from "../../retention/sidecars"
