// The failure-detail distiller is host-neutral and lives in memory-core; worker modules keep importing it here.
export {
  childFailureCause,
  failureFingerprint,
  FAILURE_CAUSE_MAX_CHARS,
  FAILURE_FINGERPRINT_DETAIL_CHARS,
} from "@oh-my-opencode/memory-core/commands/failure-detail"
