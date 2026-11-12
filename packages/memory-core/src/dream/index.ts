// Dream conversation selection (scoring, focus, selector). The gates ship apart as `./dream-gates`, so a
// host entry bundle can gate a dream without loading the selector.
export {
  scoreDreamCandidate,
  type DreamScoreInput,
  type DreamScoreOperands,
  type DreamScoredConversation,
  type DreamSelection,
} from "./scoring"
export {
  computeUnreflectedVolumeFast,
  loadConversations,
  selectLoadedConversations,
  selectRecentDreamConversations,
  type DreamSelectionMode,
  type DreamSelectorOptions,
  type LoadedConversation,
} from "./selector"
