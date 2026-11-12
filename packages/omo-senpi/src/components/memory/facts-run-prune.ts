// Retention pruning for terminal facts run dirs lives in memory-core (shared with the OpenCode 2 host);
// the senpi facts runner and its tests keep importing it here.
export {
  FACTS_RUN_KEEP_LAST,
  FACTS_RUN_MAX_TOTAL_BYTES,
  pruneTerminalFactsRuns,
  type PruneTerminalFactsRunsOptions,
  type PruneTerminalFactsRunsResult,
} from "@oh-my-opencode/memory-core/facts-run-prune"
