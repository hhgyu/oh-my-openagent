# memory palace

Self-contained HTML memory viewer: one generated artifact with embedded data, script, and styles - no external assets, no server. Distinct domain (pure generation/rendering, no git mutation), score ~16.

## Anatomy

| Path | Purpose |
|------|---------|
| `command.ts` | `/palace` registration shell (`registerPalaceCommand`, wired from memory wiring); its handler loads the runtime sidecar on first use and reports a load failure as an actionable error. |
| `report.ts` | The shared context types and `reportPalace`, used by both the shell and the sidecar runtime; it must not import `runtime-loader.ts`, so the sidecar carries no loader of its own. |
| `command-runtime.ts` | `runPalaceCommand`: generates the artifact and reports/opens it. Command output text NEVER enters model context when no UI is attached. |
| `runtime.ts` / `runtime-loader.ts` | Sidecar entry (`#omo-memory-palace-runtime` -> `extensions/omo-memory-palace.js`) exporting the `/palace` and `/people` runtimes, and the shared once-per-process loader both registrations use. Nothing in the entry bundle may import `runtime.ts`, `command-runtime.ts`, `generator.ts` or the collectors statically. |
| memory-core `./palace` | The generator (`generatePalaceHtml` / `renderPalaceHtml` / `encodePalaceData`), `template.ts`, `client-script.ts`, `styles.ts`, the collectors (entry, history, reflection, people) and their tests moved to `packages/memory-core/src/palace/`, shared with the OpenCode 2 host. This directory keeps the command shell, the report seam and the sidecar entry. |
| `palace.test-support.ts` | Shared fixtures. |
| `lazy-runtime-probe.test-support.ts` | Fresh-process probe for `lazy-runtime.test.ts`: counts sidecar evaluations around startup, a settled turn and the first `/palace` and `/people`. |

## Conventions

- Artifact permissions 0600/0700; inline-JSON embedding is machine-gated with escaping/injection tests.
- Consumers import the narrow `./command` path; the generator and people graph come from `@oh-my-opencode/memory-core/palace`.
- Colocated Bun tests (`*.test.ts`) pin escaping, caps, and rendered structure.

## Commands

```bash
bun test packages/omo-senpi/src/components/memory/palace
```
