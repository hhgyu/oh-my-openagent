# OpenCode 2 parity register

This register lists every known place where the OpenCode 2 host (`packages/omo-opencode/src/v2/`) does not behave exactly like the OmO Native runtime (Senpi). Every port slice must update it in the same PR, and every PR's "Residual risk" section must reference the rows it adds or closes.

## Rules

- **No silent difference.** A behavior that is dropped, unsupported or different must be visible to the model or the user: an explicit refusal, a tool-guide sentence, or a documented output shape. Silent no-ops are defects.
- **Pin it.** Each row names the test or QA case that pins the V2 behavior, so a regression or an upstream host change is caught.
- **Close it or own it.** Each row has a follow-up: a planned slice, an upstream dependency, or "accepted" with a reason.

## Categories

- **A. Senpi-only, not ported.** The feature depends on Senpi surfaces that have no OpenCode 2 counterpart (TUI widgets, Senpi RPC, Senpi session files, process launch).
- **B. Host limit.** OpenCode 2.2.6 lacks the capability; V2 uses the closest honest substitute.
- **C. Different behavior.** Same feature, observably different shape or timing.
- **D. Verification gap.** Implemented, but not proven on the real host on some platform.

## Register

| ID | Area | Cat | Native (Senpi) | OpenCode 2 | User impact | Visible as / pinned by | Follow-up |
|----|------|-----|----------------|------------|-------------|------------------------|-----------|
| P-01 | DAG | B | The scheduler admits dependent nodes as soon as their dependencies settle, with or without a live tool call. | A node can start only inside a `workflow` call. Since S6c, `start` and `wait` with `detach=false` block and keep admitting for the whole call; when the call ends first, admission is held, the scheduler retires without cancelling children, and the next blocking call reattaches them and admits the rest. Detached start/wait are refused until S6d adds the wake. | A run advances only while a blocking `workflow` call is in progress. | Tool guide sentence; `native-dag/drive.test.ts` (no node starts after the call ends; the next call admits); S6d QA (detached start, one wake, next call admits). | S6d. Accepted: the host has no authority after the call returns (`service.ts` `currentInvocation()`). |
| P-02 | DAG | A | Nodes can run in process execution mode. | A `start` whose node resolves to process mode (through the Native resolver) is refused with an explicit message. A mode that changes after start fails the node at admission (V2 has no process runner). | Agents configured for process mode cannot be DAG nodes. | `native-dag/workflow-call.test.ts` refusal (S6c). | Accepted. |
| P-03 | DAG | A | Runs recover from forked Senpi session files. | Not available. | A forked conversation does not carry its DAG runs. | Listed only. | Accepted. |
| P-04 | DAG | A | TUI status panel, RPC viewer bridge. | Not available; `workflow action=snapshot` is the only view. | No live DAG panel. | Listed only. | Accepted; revisit with the V2 TUI slot API. |
| P-05 | DAG | C | The run lease is the host pid; a reload means a new pid. | Since S6c the V2 scheduler gets a generation-keyed `DagLeasePort`: the holder is a number above the pid range, alive only while the component generation that claimed it is live in this process. `amend-safety.ts` and the store's lock-holder checks still probe the pid. | Until S6f, nothing claims a V2 run lease (no recovery); the pid-probing checks would misread a reload. | S6b introduced `DagLeasePort`; `native-dag/lease.ts`; S6f QA. | S6f. |
| P-06 | Tasks | B | `session.update` writes are guarded by Senpi's own state. | No compare-and-set; an external write between read and write is not detected. | Rare lost update on child session permissions. | `docs/DECISIONS_V2.md`. | Upstream. |
| P-07 | Tasks | D | Graceful shutdown parks children (`suspended` receipts). | Implemented, but Windows always hard-kills the host, so parking during shutdown is unit-tested only. | Unknown on POSIX hosts until proven. | Unit tests (S5e). | Prove on Linux/macOS. |
| P-08 | Teams | A | Members can launch as separate processes. | Members are in-process owned sessions only. | No per-member process isolation. | S5b refusal. | Accepted. |
| P-09 | Teams | C | A member's task ends after its turn. | An in-process member stays `resident`; `task_cancel` releases it (not `cancelled`), and `team_delete` reports `cancelled 0` when idle members were disposed. | Confusing counts in tool output. | S5c/S5d QA. | Open: align the wording. |
| P-10 | Teams | C | Member sends record `team_message_sent` task events. | Not recorded yet. | Missing audit trail in task events. | Listed. | Open. |
| P-11 | Teams | C | After a restart, lead delivery resumes for every lead. | Startup discovery reads only the project's Native state dirs; other leads resume on their next team call. | Delayed mail for leads stored elsewhere. | S5e QA. | Accepted. |
| P-12 | Teams | D | Intents move to a respawned member and are dropped for members who left. | Implemented; the move is unit-tested only. | Unknown real-host behavior for respawned members. | Unit tests (S5e). | Prove in a later teams QA. |
| P-13 | Memory | C | Memory commands print into the Senpi UI. | Output goes through an `rpc.omo-memory.command.output` event plus a history record the model never sees (`msg_omo_memory_output_` prefix). `init` is renamed `memory-init`. | Headless clients see output only as history or by subscribing. A host change to message ids would leak dumps to the model. | S3 QA. | Accepted. |
| P-14 | Memory | B | The final facts batch is reconciled at `session_shutdown`. | No shutdown hook; the final batch is reconciled at the next bind. | Facts from the last turn land on the next session start. | S4 QA (kill and reload). | Accepted. |
| P-15 | Memory | C | Old terminal facts run directories are pruned by retention. | Not pruned yet. | Disk growth. | Listed. | S7. |
| P-16 | Memory | C | `doctor`, `people`, `reflect`, `dream`, `sleeptime`, `palace` commands. | Not available yet. | Commands missing. | Listed. | S7. |
| P-17 | Memory | C | The user-turn counter and the ultrawork/todo-fanout arming ledgers are shared. | The counter is process-local and the ledgers are separate. | Counters reset on reload. | Listed. | Open. |
| P-18 | Hooks | B | `question-gates` sees a dismissed question through `execute.after`. | 2.2.6 emits no `execute.after` on dismissal; the next request gets `GATED_NO_ANSWER`. | The model learns of the dismissal one request later. | PR #1 QA. | Upstream. |
| P-19 | Skills | C | Native has no skill permission. | One `permission.assert` per distinct skill id per call; a single deny refuses the whole batch. | Stricter than Native. | S2 QA. | Accepted. |
| P-20 | CodeMode | B | Guarded children use CodeMode `execute` with leaf policy and a network guard. | Every stock tool is `codemode:false` in 2.2.6, so these guard paths are not reachable yet. Selections that need them are refused. | No CodeMode in V2 children. | Refusal in `owned-runner`. | S9. |
| P-21 | Kernel | C | Kernel tool bindings for children. | Not bound; selections that need them are refused. | Kernel tools unavailable to children. | Refusal in `owned-runner`. | S9. |
| P-22 | Sync | C | Memory sync runner and device sessions. | Not available yet. | No memory sync from OpenCode 2. | Listed. | S8. |
| P-23 | QA | D | Senpi isolation certification is complete on POSIX. | On Windows it is incomplete (`DIRECTORY_IDENTITY_UNAVAILABLE`); several Senpi live drivers fail on this Windows host at HEAD as well. | Weaker isolation proof on Windows. | Evidence READMEs. | Accepted for Windows. |
| P-24 | DAG | C | `cancel`, `cancel_node`, `retry`, `send` and `amend` steer a run. | Refused with an explicit message naming S6e. | Runs cannot be cancelled, retried, steered or amended from OpenCode 2 yet. | `native-dag/workflow-call.test.ts`. | S6e. |
| P-25 | DAG | C | Nodes can name `load_skills`, materialized into their prompts. | A `start` whose node names skills is refused with an explicit message. | Skill-bearing graphs must drop `load_skills` on OpenCode 2. | `native-dag/workflow-call.test.ts`. | S6g. |
| P-26 | DAG | C | The session is woken as each node completes and when the run settles. | Nodes run attached (`run_in_background:false`, so `notify_on_terminal` is off) and the blocking call returns the result; no run-level wake exists yet. A node finishing after an interrupted call posts nothing until the next blocking call folds it. | No wake after an interrupted call. | Tool guide sentence. | S6d. |
| P-27 | DAG | C | Recovery resolves a node whose admission was cut off by its owner (`findOwnedTask`). | Re-entry reattaches a node by its recorded task or its owned task; a node still with neither is refused with an explicit message naming S6f. | Such a run cannot be continued until recovery lands. | `native-dag/drive.ts` `admittedChildren`. | S6f. |
