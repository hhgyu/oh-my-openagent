# OpenCode V2 decisions

Status: active

Branch: `feat/opencode-v2-host-scaffold`

Date opened: 2026-10-21

## Purpose

This file records the decisions for the additive OpenCode V2 host. It is the source of truth for scope, architecture, known gaps, and verification. If a later change contradicts a decision here, update this file in the same PR and explain why.

## Context

OpenCode 1 and OpenCode 2 use different plugin APIs. The normal package entry now loads native OmO agent registration and bootstrap RPC through its OpenCode 2 `setup` entry. The V1 runtime remains behind the `server` entry. The project has declined a full upstream V2 port and points users to OmO Native for the complete experience. This branch is a downstream implementation of the current OmO Native runtime for OpenCode 2, preserving source-backed V1 compatibility.

A public reference port exists at `fazulfi/omo-v2` on branch `port/v2`. It is used as behavioral and API reference material, not as a dependency. Its published parity matrix covers an owner-used subset. The current Native inventory defines this branch's target; the reference subset and legacy V1 parity do not define its limits.

## Scope

In scope:

- The OpenCode plugin entry, tools, tool hooks, prompt and context hooks, agents, commands, MCP servers, skills, configuration, background orchestration, team mode, monitor, OpenClaw, and the TUI.
- V1 coexistence. The V1 entry stays unchanged and continues to load on OpenCode 1.
- A real-host parity matrix and an isolated QA harness.

Out of scope:

- The `omo` CLI and the OmO Native binary.
- The Codex and Senpi adapters.
- Desktop application code.
- Publishing a new npm package or changing the release workflow.

## Architecture

The V2 host lives in `packages/omo-opencode/src/v2/`. It is a sibling of the V1 source, not a wrapper around it.

```text
packages/omo-opencode/src/v2/
  index.ts              V2 Plugin.define entry and cleanup composition
  managers/             V2-native background, skill MCP, monitor, tmux managers
  tools/                tool registration and execution
  hooks/                tool, prompt, context, compaction, event, fallback
  agents/               agent definitions and dynamic prompts
  config/               .omo/omo.jsonc loading and domain transforms
  commands/             command registration
  mcp/                  built-in and configured MCP servers
  skills/               shared, user, project, and runtime skills
  orchestration/        background agents, todos, goal, boulder, team, monitor
  tui/                  OpenCode 2 TUI entry
  compat/               event, message, and schema adapters
  rpc/                  diagnostic RPCs
```

The V1 source continues to live in `packages/omo-opencode/src/` and is bundled to `dist/index.js` and `dist/tui.js`. The V2 server is bundled to `dist/v2/index.js`; a V2 TUI entry remains pending. The normal package entry exposes the existing V1 `server` and delegates its V2 `setup` to the same native setup as `dist/v2/index.js`. The native V2 implementation uses the public V2 SDK, harness-neutral workspace packages and proven pure public Native seams; it does not invoke the V1 pipeline.

## Decision log

### D-001: additive dual host

Decision: keep V1 untouched and add a separate V2 host.

Rationale: the project requires zero V1 regressions and the maintainer rejected a V1 import of V2 SDK code. The V1 server export stays independent; both the normal package entry and the separate V2 export reach native V2 setup.

Status: accepted.

### D-002: V2-native host, not a V1 bridge

Decision: implement against the V2 domains directly. Do not translate the V2 context into the V1 plugin context and replay the V1 pipeline.

Rationale: the bridge approach has known semantic holes in command interception, compaction, message identity, and TUI slots. A native host gives each feature an explicit V2 mapping.

Status: accepted.

### D-003: exact current SDK and host runtime identity

Decision: author against the exact `@opencode/plugin` 2.2.6 pin and validate on the installed OpenCode 2.2.6 host. The V1 `@opencode-ai/plugin` and `@opencode-ai/sdk` pins remain 1.18.31. Local Effect types use 4.1.0 with an `effect` peer range of `^4.0.0`; runtime SDK and Effect imports, including public subpaths, stay external so the host supplies their shared instances.

The normal root loads V2 setup lazily through split chunks. Node can import its V1 `server` and named `omoPlugin` without the V2 SDK present; both normal-root V2 setup and `./v2` use the host SDK. Isolated real-host and emitted-bundle checks establish this foundation, not full Native parity.

Status: accepted and verified on 2026-11-08.

### D-004: no V1 imports in the V2 host

Decision: `packages/omo-opencode/src/v2/` must not import `@opencode-ai/*` or the V1 plugin pipeline. It may import harness-neutral workspace packages.

Rationale: the V1 SDK types and client semantics differ from V2. Allowing them in the V2 host would reintroduce the bridge problems and make the host boundary unclear.

Status: accepted.

### D-005: configuration is projected through transforms

Decision: `.omo/omo.jsonc` remains the source of truth. Load and validate it in memory with `omo-config-core`; the agents transform rereads it when the host replays registrations on reload. Apply it through `agent.transform`, `command.transform`, `mcp.transform`, `provider.transform`, `model.transform`, `tool.transform`, and `skill.transform`. Do not rewrite the user's config file.

Rationale: V2 has no single `config` mutation hook. Per-domain transforms are the supported surface. In-memory normalization preserves rollback and avoids destructive config edits.

Status: accepted.

### D-006: agents use native transform upsert

Decision: register all eleven OmO role agents through `ctx.agent.transform` and `AgentEditor.update`. The host inserts an absent ID before invoking the update callback; markdown files and a V1 bridge are unnecessary. Hide existing host `build`/`builder` picker entries when a selectable OmO implementation agent is active, and hide `plan` when selectable Prometheus is active. Demote those hidden builtin entries to `mode: subagent`, retaining them for explicit and internal dispatch; without active replacements their native modes remain unchanged. Leave unrelated agents and the configured default untouched: the host skips hidden defaults and selects the first available primary agent; without an enabled replacement, builtin visibility remains unchanged. Dispose the registration on shutdown and roll it back if later setup fails.

Configuration: the core unified loader owns user and walked project `.omo/omo.json[c]` discovery, JSONC validation, harness/profile precedence and model catalog expansion. Shared `agents` fields are supported; OpenCode-only `displayName`, modes, `permissions` rule arrays and `disabled_agents` belong in `[opencode]`. Canonical `permission` maps also project to native rules. Historical `bash` permissions, tool toggles and denylist entries additionally target the native `shell` action; `write`/`apply_patch`/`patch` target the native `edit` permission and delegation aliases target `subagent`. Original action rules remain for older hosts. Read-only and planner restrictions explicitly deny native `shell` after user allowances. `models[0]` is the primary model when an ordered chain is set; fallback execution is not part of this slice. Unconfigured models inherit the host selection. The supplied SDK maps `displayName` to agent `name`.

Roles: Sisyphus, Hephaestus and Atlas are primary execution agents; Prometheus is a primary planner allowed to edit Markdown only under `.omo/plans/`. Sisyphus Junior is a bounded subagent with delegation denied. Oracle, Metis, Momus, Librarian, Explore and Multimodal Looker are read-only subagents with shell, mutation and delegation denied. Restrictions are appended after configured allowances and therefore remain effective. Prompts describe only available host capabilities and explicitly disclose that OmO tools, lifecycle hooks and orchestration are not supplied by registration.

Status: native registration, configuration projection and cleanup covered by behavior tests. Real installed host evidence is captured separately under `.omo/evidence/20261107-v2-agents/`; registration alone does not establish full V1 parity.

### D-007: one ordered context composer

Decision: all context mutation runs through one ordered `session.hook("context")` composer. The order is:

1. runtime agent prompt reconciliation
2. skill and category catalog
3. rules and AGENTS.md injection
4. keyword and mode detection
5. BTW, team, and monitor context
6. tool-pair and message repair
7. model parameter and header projection

Rationale: multiple independent context hooks would produce order-dependent message corruption. One composer makes ordering explicit and testable.

Status: accepted.

### D-008: identity-safe message writes

Decision: when adapting V2 context messages to a transform view, keep a `WeakMap` from the view to the source message. Never write transformed messages back by array index.

Rationale: inserting or removing a message by index moves content between neighboring messages and breaks tool-call/tool-result pairing. A prior bridge implementation hit this bug.

Status: accepted.

### D-009: tools use the V2 tool domain

Decision: register tools with `ctx.tool.transform` and intercept calls with `ctx.tool.hook("execute.before")` and `ctx.tool.hook("execute.after")`. Convert tool input schemas to the V2 JSON schema shape at registration.

Rationale: this is the direct V2 surface for tools and per-call guards.

Status: accepted.

### D-010: own commands only

Decision: register all OmO commands through `ctx.command.transform`. Do not promise interception of third-party slash commands. Own commands implement their behavior directly.

Rationale: the V2 command editor adds commands but does not expose a general pre-execution hook. A documented limitation is better than a silent behavior change.

Status: accepted.

### D-011: compaction uses the session hook

Decision: use `ctx.session.hook("compaction")` for compaction context and todo preservation. Implement auto-continue with an event-driven resume path. If the host cannot support a safe resume, document the limitation at startup.

Rationale: V2 does not expose the V1 `experimental.compaction.autocontinue` flag. The behavior must be rebuilt, not assumed.

Status: accepted. Auto-continue design is pending.

### D-012: todos use session metadata

Decision: store OmO todos in session metadata under a reserved key. Do not assume a native V2 todo API.

Rationale: the V2 client surface does not expose the V1 todo store.

Status: accepted.

### D-013: TUI uses the V2 slot and keymap API

Decision: use `ctx.ui.slot`, `ctx.keymap.layer`, `ctx.data`, `ctx.storage`, and Solid rendering. Do not use raw stdin or renderer internals.

Rationale: the V2 TUI context is the supported surface and is richer than the V1 TUI API object.

Status: accepted.

### D-014: no toast dependency

Decision: do not require a toast API. Route user-facing notifications through the TUI notification surface when available, otherwise log them.

Rationale: V2 has no stable toast API. Missing toasts must not break a tool or hook.

Status: accepted.

### D-015: typed event subscriptions with an explicit name map

Decision: subscribe through the V2 event domain and keep a checked V1-to-V2 event name map. Test renamed and split events.

Rationale: V2 event names and payloads differ from V1. A wildcard assumption would silently drop events.

Status: accepted.

### D-016: model catalog is lazy

Decision: do not snapshot the model catalog during setup. Resolve models and fallbacks lazily after catalog updates.

Rationale: the catalog is empty at setup and populates asynchronously. A setup-time snapshot sends agents to the wrong fallback.

Status: accepted.

### D-017: QA is real-host and isolated

Decision: every slice needs an isolated OpenCode 2 run with its own `HOME` and XDG roots, a behavior assertion, and evidence under `.omo/evidence/`. Unit tests are necessary but not sufficient.

Rationale: the repository QA contract requires proof on the real harness. V2 plugin load alone does not prove feature behavior.

Status: accepted.

### D-018: upstream divergence

Decision: this is a downstream branch. Do not open a full-port upstream PR. If a slice is upstreamable, keep it additive and V1-neutral.

Rationale: upstream has declined the full port and paused the dual-host track. Pretending otherwise wastes review time.

Status: accepted.

### D-019: license and provenance

Decision: preserve the repository license and third-party notices. If code is adapted from `fazulfi/omo-v2`, record the source and attribution in the file header and this document.

Rationale: the reference fork is public under the same license family. Attribution is required and provenance must stay auditable.

Status: accepted.

### D-020: atomic PR slices

Decision: deliver the work as small PRs. The first PR is the scaffold. Each later PR owns one subsystem and flips its parity rows.

Rationale: a full port in one PR cannot be reviewed or tested. The project's review workflow requires small, independently verifiable slices.

Status: accepted.

### D-021: build outputs are additive

Decision: add a `v2-index` build node that emits `dist/v2/index.js`. Add `v2-tui` when the TUI slice lands. Keep the existing build nodes; the normal `index` entry now reaches the native V2 setup as well. The `tui` and `cli` build nodes are unchanged.

Rationale: V1 and V2 must remain independently buildable and rollback-safe.

Status: accepted.

### D-022: rollback stays one config change

Decision: both `dist/index.js` and `dist/v2/index.js` register native V2 agents. To roll back this slice, restore a prior plugin build; changing between those two current entry paths does not disable registration. No user config is rewritten.

Rationale: a failed V2 deploy must not require a rebuild or a config migration.

Status: accepted.

### D-023: the entire current Native runtime is canonical

Decision: use the entire current OmO Native runtime as the target, including its engine facilities. The private source inventory records 248 rows across 34 components and 57 engine groups. The eleven existing legacy roles remain provisional compatibility entries, not the new Native architecture. Preserve aliases only where current source establishes them. Existing live agent-registration and visibility evidence remains valid for that slice.

F05 tool-kernel, F06 owned-session/settlement, and F07 config/model/prompt libraries are staged foundations. Their tests and isolated probes do not make them production Native features or complete the task runtime. Activation requires the canonical consumers, durable ownership and one event/turn normalizer and arbiter; real failure, retry, abort and manual-compaction checks remain gates.

### D-024: public host boundaries and reusable Native seams

Decision: treat `experimental.idle` as the successful model-work boundary immediately before idle: admitted input can continue the same execution. It is not generic Native `agent_settled` and does not cover failure, interruption or manual compaction. Admission is distinct from consumption and terminal outcome. `ctx.session.context` supplies current context, not full transcript history. Missing history/inbox/log operations require an explicitly granted public client binding; never inspect private host APIs, scrape auth files or select a convenient global server. Headless child lifecycle must remain independent of GUI availability.

The pure public `@code-yeongyu/senpi/prompt-presets` seam is ported behind an internal adapter, pending runtime integration. Future codemode reuse must prove the public factory's complete import closure is suitably pure; its narrow signature alone does not establish that. Worker/process mode is not hostile-code isolation; QuickJS WASI isolation needs its own verification. Bunshin redistribution remains restricted to its existing license grants: use an authorized service or a host-equivalent backend rather than copying restricted assets into OpenCode or core. These are source-backed constraints and future integration obligations, not feature claims.

### D-025: child custody uses a durable transactional journal

Decision: the OpenCode child backend has a concrete Bun SQLite journal with full synchronous commits, a dedicated application/version marker, insert-only claims and revision fencing. A claim for existing custody must advance revision even for the same owner. An independent owner can recover only after explicit release or verified process death; PID liveness alone never establishes a different process lifetime. Unknown ownership remains unavailable. Reopening preserves input admission receipts and never authorizes automatic replay.

The database path is trusted private application state, never model input. No-follow opening and ancestor/sidecar checks reject links; this does not claim isolation from a hostile OS user changing filesystem objects concurrently. Join backend work before closing its journal. The port is real-host and process-crash tested, but root registration, canonical task consumers, event normalization and settlement arbitration are still required before activation.

### D-026: activate the completed Native LSP and mutation subset

Decision: the default and explicit V2 entries now register the six Native LSP tools plus mutation formatting and post-edit diagnostics. Common `formatOnMutation` settings apply. The Native flag identities `omo-senpi-lsp-tools-enabled` and `omo-senpi-lsp-post-edit-diagnostics-enabled` are retained as boolean plugin options; disabling LSP also disables its mutation processing, matching Native registration order.

Only actual host callbacks supply tool/session/message/agent authority. The adapter wraps the real `patch` callback and normalizes its `patchText` for the shared Native formatter; it does not create nested host tool events. File reads and Git/probe/formatter commands use the caller's permission source and lifetime. Owned LSP formatting/diagnostics share a client and refuse stale snapshots, with no global daemon inference. Real notices and post-format diagnostics enrich the model's tool result. A failed postprocessor reports that the original edit was committed; it does not blindly overwrite a concurrent edit to claim rollback.

Workspace mutators, including rename, serialize while the shared edit-plan reservation is incomplete. This is an ordering boundary, not a claim of cross-process filesystem locking. External/unknown automatic-processing scopes retain the original host operation and report that processing was skipped. Comment checking, the other Native hooks, canonical profile consumers, task/team/DAG/workpool and memory/Kibitzer still require implementation and proof. The current Native/Core changes remain local until mandatory Native regression/isolation and delivery gates pass.

### D-027: share Native profile selection without guessing host authentication

Decision: Native's current main-profile resolver, builtin lane table and pure default walk live in delegate-core. Native import paths forward to those public Core subpaths; Native credential rotation/probes, models.json IO, startup provenance, session model application and notices stay in the Native adapter. Existing provider order, exact user-rung matching, explicit declaration exception, launch gates, empty overrides and literal pin behavior remain unchanged. The private workspace's type exports point at real source rather than an absent index.d.ts.

OpenCode binds the same selector/default walk to the actual public model/provider catalog and expanded common config, including exclude_models. Only enabled, provider-listed chat references become candidates. A provider listing is not a custom models.json declaration or a successful credential check. Native reasoning is retained as Native metadata; host variant IDs are reported separately, never guessed from equal names.

The OpenCode facade produces a candidate and authentication unknown; it does not automatically rewrite the main session or host default. Live proof stages an actual owned child with the chosen public reference and verifies the request model and response. Equivalent main-session startup/auth fallback and provenance policy remain P2 work, not a feature silently replaced by catalog-only routing. Actual Native startup selection and CLI pin precedence are verified independently after the forwarding switch. Mandatory Native isolation and delivery gates remain required before committing the affected shared changes.

### D-028: derive child outcomes from owned durable observations

Decision: custody/admission and execution outcomes are separate ports. A private SQLite observation log requires the backend's issued child scope, synchronous current custody-row check and its own binding-token fence. Rebinding preserves observations and invalidates coverage; it never turns historical completion into a fresh task result. Conflicting IDs, corrupt or orphaned records, exhausted bounds, scope loss and incomplete coverage refuse a successful result. This is not a transaction spanning the custody and observation databases.

The direct Promise plugin adapter in OpenCode 2.2.6 does not invoke the advertised onActivity callback. The observer installs the actual task title through the public session API and waits for an observed owned durable event before input admission. It subscribes to all event types for that child. A cursor discontinuity means coverage is insufficient; it does not by itself prove transport loss. There is no private history client or automatic input replay.

Results use real execution-start event IDs, assistant IDs, completed text parts and observed step models. These IDs are not invented host execution IDs. Same-execution continuation returns the last completed assistant response. A repeated assistant start requires its matching scheduled-retry witness; the initial attempt is 1 and its first retry is 2. Tool terminals match observed calls within their step, and unfinished calls cannot imply task success. Counts of observed attempts are distinct from complete executed-tool statistics. Unknown usage remains absent. Raw reasoning, provider error bodies, headers and tool inputs are excluded from this log.

wait() returning, text arriving, a local stop intent, an auxiliary generation, or a control-only compaction execution succeeding cannot establish task success. Empty successful output is an explicit error. Request-kind hooks are metadata, not a fabricated request-to-assistant correlation. Native TaskManager extraction, canonical routing, registered task tools, interruption/detachment and full Stop/Resume remain required consumers of these internal ports; this decision does not activate or claim those features.

### D-029: use joined Effect requests for owned child controls

Decision: the raw child interrupt and detach ports require an opaque cancellation capability produced by the public Effect session bridge. In SDK 2.2.6, direct Promise session methods ignore their options.signal argument. Bare Promise contexts therefore cannot provide these controls or abort-dependent readers; the observer also refuses them before binding, registering hooks or installing its title. This capability records trusted transport composition, not a user permission or host outcome.

The bridge runs thirteen session operations in scoped fibers using the actual plugin's captured Effect context. Abort rejection occurs after the fiber and its finalizers finish. Public protocol 2.2.6 endpoint codecs preserve wire identifiers, attachments, JSON metadata, query values and numeric timestamps. Protocol/schema code bundles with the adapter; Effect and the plugin SDK retain host identity. There is no private client, SDK patch, or abandoned Promise race.

Interrupt requests resume:false and preserves the session and lease. Its actual boolean acknowledgement remains settlement-unconfirmed. Detach revokes only the issued local handle, retires its lease and joins existing child readers before returning; it issues no new host interrupt/wait/remove request. Backend disposal joins tracked parent listings too and excludes detached children from deletion. Explicit recovery renews custody and preserves admission receipts; historical observation is still uncertain and original input is never replayed. Permanent close remains a separate end-and-remove operation. These raw controls do not supply Native's durable Stop/Resume policy.

Durable journal commits and the corresponding local revision update occur in one JavaScript turn through the same synchronous SQLite CAS implementation. Observation requires both synchronous current-row validation and synchronous commit. Both methods must return undefined; asynchronous or non-undefined substitutes are refused before granting observation or admitting new model input. This fixes a reproduced same-owner stale-revision window without relaxing fences or changing the database schema. The observation and custody databases remain separate transactions.

This completes the internal raw-control prerequisite identified in D-028. Default root Effect composition, the existing Native TaskManager extraction and consumers, canonical routing, task tools and full orchestration remain separate implementation and verification work. Candidate-loader proof alone does not establish their activation.

### D-030: activate the scoped Effect producer at both V2 roots

Decision: normal and explicit V2 entries expose effect beside the existing setup. The normal root keeps its V1 server and named omoPlugin identity. Its Effect runtime load remains inside an invocation-only thunk followed by a lazy V2 import, so importing the V1 root requires no optional V2 SDK or Effect runtime. Installed OpenCode 2.2.6 chooses effect when both fields exist. The Effect route requires that verified version before registering domains; legacy setup remains available without claiming equivalent cancellation for a raw Promise context.

The genuine Effect program acquires the scoped session API before composing existing Promise components through the SDK's public fromPromise adapter. The verified API overrides mapped session methods after the original session spread. Its owner pretracks requests before host callbacks can start or reenter teardown, combines owner and caller cancellation, and closes against new calls when its Scope finalizer runs. Later component finalizers may perform permanent cleanup first; the owner then aborts and joins remaining mapped request fibers and asynchronous finalizers. No fake Effect environment or private client is introduced. Other SDK domains are not silently assigned this session-specific cancellation contract.

Current emitted normal and explicit entries select Effect and retain their existing working-tree agent, LSP and mutation behavior. The same emitted normal entry retains actual V1 agent/tool/model behavior. A separate SDK file-watcher replacement probe delegates the emitted production Effect function a genuine public session wait behind an active mutation authorization. An explicit release barrier proves request finalization precedes old Scope completion and replacement activation; the old file operation never runs. The independent producer commit excludes the still-gated C02 mutation setup and its dependent integration-test block, while their working-tree integration proof is retained separately.

This activates the transport prerequisite; it does not register Native task tools or complete the existing Native TaskManager extraction, canonical model/auth routing, durable Stop/Resume, teams/DAG/workpool or memory/Kibitzer. Those remain required under the full Native parity goal.

## V1 to V2 mapping

| V1 surface | V2 surface | Notes |
|---|---|---|
| `PluginModule { id, server }` | `Plugin.define({ id, setup })` | Separate entry, not a V1 wrapper |
| `config` hook | domain `transform` calls | No single config hook |
| `tool` record | `ctx.tool.transform` | Schema conversion at registration |
| `tool.execute.before/after` | `ctx.tool.hook` | Direct mapping |
| `tool.definition` | `ctx.tool.transform` update | Per-tool definition changes |
| `chat.message` | `ctx.session.hook("prompt")` | Prompt and command detection |
| `chat.params` | `ctx.session.hook("context")` options | Provider-specific knobs |
| `chat.headers` | `ctx.session.hook("http.request")` | Request headers |
| `experimental.chat.messages.transform` | `ctx.session.hook("context")` | Identity-safe writes |
| `experimental.chat.system.transform` | `ctx.session.hook("context")` | System parts |
| `experimental.session.compacting` | `ctx.session.hook("compaction")` | Context and todo preservation |
| `experimental.compaction.autocontinue` | event-driven resume | No direct flag |
| `command.execute.before` | `ctx.command.transform` for own commands | Foreign interception is a gap |
| `event` | `ctx.event.subscribe` | Typed events and name map |
| `config` agents | `ctx.agent.transform` | Native update upserts absent IDs |
| `config` commands | `ctx.command.transform` | Add commands |
| `config` MCPs | `ctx.mcp.transform` | Add and override servers |
| `config` providers/models | `ctx.provider.transform` / `ctx.model.transform` | Lazy catalog |
| `config` tools | `ctx.tool.transform` | Enable, disable, trim |
| `config` skills | `ctx.skill.transform` | Shared and runtime skills |
| TUI slots and keymaps | `ctx.ui.slot` / `ctx.keymap.layer` | No raw stdin |

## Parity matrix

The matrix records behavior tests and captured real-host assertions. Each row has a status and an owning slice; a live QA pass does not silently convert an automated test TODO into a pass.

| Row | Behavior | Owner | Status |
|---|---|---|---|
| 1 | V1 entry loads unchanged | scaffold | pending |
| 2 | V2 entry loads and exposes `id` + `setup` | scaffold | pending |
| 3 | `omo.status` RPC returns the bootstrap response | scaffold | pending |
| 4 | `glob` tool call | tools | pending |
| 5 | `grep` tool call | tools | pending |
| 6 | tool execute before/after hooks fire | tools | pending |
| 7 | prompt hook sees and mutates a prompt | prompt | pending |
| 8 | context hook mutates system and messages | prompt | pending |
| 9 | tool-call/tool-result pairing survives a message insert | prompt | pending |
| 10 | compaction hook preserves context and todos | prompt | pending |
| 11 | agents list contains the OmO agents | agents | unit pass; installed 2.2.6 live pass |
| 12 | agent dispatch reaches an OmO agent | agents | installed 2.2.6 live pass; automated live test pending |
| 13 | unknown agent returns a clear error | agents | installed 2.2.6 live pass; automated live test pending |
| 14 | commands list contains the OmO commands | commands | pending |
| 15 | built-in MCP servers connect | mcp | pending |
| 16 | shared skills load | skills | pending |
| 17 | config projects agents, commands, MCPs, and skills | config | pending |
| 18 | background task spawn/collect/cancel | orchestration | pending |
| 19 | todo write/read roundtrip | orchestration | pending |
| 20 | goal and boulder continuation | orchestration | pending |
| 21 | model fallback moves to the next model | orchestration | pending |
| 22 | team mode mailbox and tools | orchestration | pending |
| 23 | monitor lifecycle | orchestration | pending |
| 24 | TUI sidebar slot renders | tui | pending |
| 25 | TUI keymap layer dispatches | tui | pending |

### Agent slice evidence (2026-11-07)

The isolated installed OpenCode 2.2.6 host loaded the normal `dist/index.js` entry. `GET /api/agent` returned the enabled OmO roles alongside the preserved host Build agent; the configured disabled role was absent. A real Sisyphus prompt reached the loopback mock provider with `QA_AGENT_SENTINEL`, and session-message readback identified the completed Sisyphus assistant response with `finish: stop` and `OMO_AGENT_DISPATCH_OK`. Dispatching `omo-unknown-qa` produced the host's `Session.AgentNotFoundError`.

Local evidence under `.omo/evidence/20261107-v2-agents/` includes `dispatch-http.json`, `dispatch-run.txt`, `dispatch-server.log`, `dispatch-summary.md` and artifact hashes in `dispatch-hashes.json`. All twelve live checks passed. The real database session count remained 4733 before and after; the server and mock stopped and the sandbox was removed. The fixture uses the installed host's provider schema, recorded in `installed-openapi.json`, and a loopback provider with QA-only credentials.

A reviewer forced the native `shell` tool and reproduced a read-only Oracle bypass before this action mapping fix. The corrected real-host probes reject the same forced call for Oracle even with explicit shell allowances, and reject Sisyphus shell execution when canonical `permission.bash` is denied. Captures `permission-fixed-oracle-http.json` and `permission-fixed-sisyphus-http.json` record tool error states, no completed shell execution, unchanged session counts and cleanup. This proves enforcement uses actual host actions rather than prompt-only restrictions.

The builtin-visibility correction is verified separately in `visibility-enabled-http.json` and `visibility-disabled-http.json`: Build and Plan are hidden with enabled replacements, a no-agent session completes under Sisyphus, explicit Build selection remains accepted, and disabling every OmO role leaves builtins visible with default completion under Build. OpenCode defers no-agent session selection until prompt execution, so the assertion reads the completed assistant agent rather than expecting a stored agent at creation. Both probes preserve the real session count and clean up their servers and sandboxes.

The automated agent-list parity test passes. The dispatch and unknown-agent unit TODOs remain until the real-host driver is integrated into the automated test harness; the live evidence above establishes their observed behavior without claiming those TODOs passed. OmO tools, hooks and orchestration remain outside this completed registration slice.

## Known gaps and mitigations

| Gap | Mitigation | Status |
|---|---|---|
| No general slash-command interception | Own commands register their behavior; foreign interception is documented as unsupported | accepted |
| No compaction auto-continue flag | Event-driven resume; if unsafe, log a startup warning and leave auto-continue off | open |
| No single config hook | Per-domain transforms with in-memory config | accepted |
| Agent registration | Native editor update upserts absent IDs | resolved |
| No toast API | TUI notification or log | accepted |
| No native todo API | Session metadata | accepted |
| No `session_prompt` TUI slot | `prompt.footer` plus reactive data | accepted |
| Model catalog empty at setup | Lazy resolution and catalog updates | accepted |
| Event renames and splits | Explicit checked event map | accepted |

## QA plan

Every slice runs:

1. Unit tests for the new modules and the parity rows it owns.
2. `bun run typecheck:packages`.
3. A real OpenCode 2 run in an isolated home and XDG sandbox.
4. A behavior assertion for each flipped parity row.
5. Evidence written under `.omo/evidence/<date>-<slug>/` and summarized in the PR body.
6. A V1 regression check that the V1 entry still loads and still exposes `server`.

The real-host harness uses the installed OpenCode binary, a temporary config root, and a temporary data root. It never reads or writes the user's real OpenCode database.

## Open decisions

- The exact auto-continue mechanism after compaction.
- The minimum TUI surface for the first TUI slice.
- Whether the V2 host ships as a package `./v2` export, a separate `dist/v2` directory, or both. The current plan is both: the export for package consumers and the directory for local plugin configs.


## Temporary Native task kernel support edge (2026-11-08)

The OpenCode V2 owned-session task consumer may depend directly on the narrow senpi-task/manager-kernel export. The existing TaskManager remains the sole manager; Native wrappers keep defaults. Owned-session identity, uncertainty, admission and lifetime are explicit ports. Core never imports an adapter. Full pause/resume, continuous observation recovery and execution-mode parity remain explicit capability requirements, not implied by this internal binding. No public task namespace is enabled merely by this edge.


## Staged completion admission journal (2026-11-09)

The OpenCode completion path keeps canonical Native notification epochs separate from host input admission. A dedicated completion-intent journal will record queued custody, dispatching uncertainty, accepted input and unfinished canonical bookkeeping. Dispatching must be durable before the original SDK invocation; accepted bookkeeping follows a genuine validated SDK admission response. Queue acceptance, input admission and model consumption are different observations. An uncertain input must not become a new submission merely because a callback, component or process restarted; a later genuine ACK can repair the same intent without resending it.

Logical source uniqueness uses stable task/run/receiver identity in the trusted project journal namespace. Journal owners, revisions, claims, lease and registry generations and host versions are historical custody checks, not material for minting a new logical source after recovery. Accepted or uncertain membership remains reserved; definitive non-admission retry requires an explicit atomic attempt and bookkeeping policy. The existing child-custody journal and its schema remain unchanged.

A journal row or ownership claim is not parent notification authority. A separate restricted grant must come from the actual Kernel registry, exact receiving lease and genuine accepted Native task/run custody; persisted task data, a retained raw caller or a future-start permission cannot supply it. New-dispatch revocation and already-owned transport/receipt cleanup remain distinct, and resource release must join that cleanup. Trusted state-path checks do not claim isolation from a hostile OS user changing filesystem objects concurrently.

This is a staged internal foundation. The journal, authority and actual host completion owner must pass their scoped tests and isolated real-host gates before activation. It does not register a public task namespace, establish SDK idempotency or remote-incarnation proof, or complete the Native runtime port. Missing public receiver-query, lifecycle/state and recovery evidence remains explicit; no private host API, guessed server/auth binding or fabricated receipt fills those gaps.


## Temporary completion eligibility support edge (2026-11-09)

The private V2 parent-notification authority may import the existing pure `senpi-task/src/completion/routing.ts` helper `shouldNotifyRecord` directly while the actual task kernel remains in adapter support. It uses the same Native notification eligibility, including externally caused interrupted tasks; it does not copy that algorithm, load the wide Native/SDK barrel or add a new package dependency/export. Native source behavior stays unchanged. This narrow dependency is temporary until its real reusable boundary moves; it is not a Core facade or public background-notification activation. The separate authority, actual custody readers, parent lifecycle and delivery integration still require their own implementation and real-host evidence.

## Durable parking of guarded Native children on close (2026-11-10)

Native shutdown semantics suspend descendant children; they are never ended on plugin unload/reload. A guarded owned child is therefore PARKED on detach: the runner revokes and joins its original guard admissions, Effect fibers and any original Promise producer custody, the backend interrupts the child (`resume:false`) and waits for host idle, then updates only that child's OWN session through the joined public `session.update` with its original rules plus a wildcard deny rule appended last and an own namespaced metadata marker (`omo.native-task.parking`), reads the session back, and checkpoints a parking descriptor in the SAME child journal. Parked is not closed: the record phase stays truthful. The backend mints an opaque WeakMap receipt, and the guard's distinct `retireParked` accepts only that receipt after its original work has joined, keeping the owned-ID deny tombstone. Close then completes.

The public update has no expected revision, so conflict detection is optimistic, not compare-and-set: a rule, agent or metadata change OBSERVED during quiescence, before the write, or on readback records a `conflict` descriptor, keeps custody and fails close with an explicit error. Observed user changes are never overwritten. An external last writer between the final read and the update remains possible and is not certified. Parked children admit no input or plain execution recovery; only the fresh-action restore below lifts the deny, and explicit END cleanup still removes them.

## Fresh-action restore of parked guarded children (2026-11-10)

A parked guarded child is revived only inside a genuine CURRENT parent action (public `task_send`, or explicit recover). Before any residency admission, claim or reattach, the runtime rebuilds the persisted spec once and obtains a fresh approval from that call's own G2 authorizer (`authorizeRecovery`: the same pure host-grant selection over the rebuilt `ManagedStartSpec`, no fabricated plan, no rerun of Native model distribution, and the call's real joined `subagent` permission request). Stale pre-reload custody, persisted names or the recorded rule snapshot never authorize; autonomous recovery has no current call and refuses. Owned recovery passes the SAME rebuilt spec object to verification before `beforeLaunch` and the runner claim, and a persona/tool/ancestry/model drift refuses.

The runner reacquires the child under a new guard generation (`renewStage` replaces this guard's joined parked tombstone with a new Scope; a fresh guard after reload begins one), binds the original producer, installs the context policy and observer, and only then restores. The restore checks that the host still shows exactly our deny-last rule and marker, checkpoints `restoring`, writes the recorded original rules (absent restores as `[]`) with metadata minus our marker, reads back, and checkpoints `restored`. If the host keeps an omitted metadata key (merge-patch semantics), only our key is set to `null`. Any other observed difference is a conflict: no write, host rules preserved, durable `conflict`, explicit refusal, and the guard claim stays unretired until explicit END. A failed restore re-parks rather than ending the preserved SDK child. Tool calls capture the guard generation when created, so a lazy Effect of the parked generation stays denied after renewal. Native revive semantics then deliver the new input (`Revived ... (run epoch N)`) through the existing gated prompt path; the original prompt is never replayed.

### D-031: owned children use their actual agent permission identity (2026-11-12)

Status: accepted.

Decision: authorize and stage a named Native persona under the SAME registered OpenCode agent ID, selected from the current host roster. Only an unnamed persona defaults to `build`. Fresh recovery selects the persisted `agentType` again. The existing internal `buildAgentID` field carries this actual approved ID through stage, producer and guard bindings, and the restore identity check; its historical name does not select Build. The parent's genuine joined `subagent` request names the actual child agent, not `build` or a category. A missing or ambiguous named host agent fails before approval or child creation, never falls back to Build.

Evidence: the public `AgentEditor.update` and `Session.create.agent` contracts support this on OpenCode 2.2.6. An isolated capability probe stored `explore` as the session agent and enforced its agent-only `read` deny while Build and Sisyphus stayed allowed. Real Native task QA then reproduced the old Build bypass and verified the named-child fix for both unified `omo.json` rules and OpenCode agent rules, including reload and fresh-action restore. Captures are local under `.omo/evidence/20261112-v2-agent-perms/`.

Registration: derive the additional identity set through Native's actual `resolveTaskAgents` over the same canonical expanded `omo.json` agents record consumed by task preparation. All seven Native builtin overlays and enabled custom definitions get an identity; no manual OpenCode agent entry is required. The existing eleven OmO roles retain their picker behavior. Native-only builtins and custom identities are hidden and fixed to subagent mode, including the planner pair and the three `omo-native-*` reviewers. Disabled definitions are removed. A definition that cannot be projected reports a named, actionable configuration error rather than silently running as Build.

Precedence: the host evaluates its own global and agent rules under the actual child identity; the plugin neither copies those rules into session allowances nor replaces the user's policy. All four Native curated roles receive defaults for the dedicated `omo_native_readonly` and `omo_native_ls` actions before unified user overrides, so the host's builtin Explore wildcard deny does not accidentally remove Native's curated broker. Tool defaults precede explicit permission rules: a custom agent's `tools.read: true` cannot weaken its `permission.read: deny`. Explicit disallowed tools and curated stock shell/edit/delegation denies remain last. The independent Native grant floor and final-leaf guard still narrow every child. The parking wildcard deny stays last until the original child rules and identity pass the existing restore checks.

Rejected: copying agent rules onto Build child session rules. That would duplicate the host's wildcard ordering, default rules, global/agent precedence and reload semantics, and session-written allows could weaken a user deny. Running under the host identity uses the existing evaluator instead.

Verification after coordinator review: the owner regression enumerates the canonical Native roster, including a custom and disabled custom definition, and stages each enabled target under its own genuine approval. With an admitted Native plan-workflow state, `plan-consultant` and `plan-reviewer` pass the actual invocation guard and retain their own staged identities, agent-only read denies and curated shell/edit denies. Real-host custom-agent and picker checks cover the new registration path. Live planner-child QA is blocked by the unchanged pre-existing plan gate, not by registration: V2 supplies no `resolveSkillInvocations` resolver. Per coordinator decision, retain that guard here and port the Native invocation tracker separately (P-45). Exact baseline-source and real refusal evidence is local at `.omo/evidence/20261112-v2-agent-perms/r2/preexisting-plan-gate.txt`.

Compatibility: unknown, disabled or unrepresentable targets still fail explicitly; valid Native builtin and custom targets no longer need separate host registration. A pre-fix parked named child stored as Build is not silently relabeled during restore: its identity conflicts and it must be ended and recreated. Rules intentionally scoped only to Build no longer restrict named children; use a global rule or the actual agent name. Plan-gated agents remain unavailable through public V2 task/DAG calls until the separate P-45 tracker port.
