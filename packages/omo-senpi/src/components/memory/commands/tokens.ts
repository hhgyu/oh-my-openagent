// The bytes/4 system-prompt estimate lives in memory-core; the doctor and the reflection worker read it here.
export { estimateSystemTokens, type SystemTokenEstimate } from "@oh-my-opencode/memory-core/commands/tokens"
