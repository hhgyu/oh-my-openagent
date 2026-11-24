[English](README.md) | [한국어](README.ko.md)

<div align="center">

<img src="./.github/assets/omo-icon-light.svg" alt="OmO" width="160" />

# oh-my-openagent v2

**OmO for OpenCode 2.**

[![License](https://img.shields.io/badge/license-SUL--1.0-white?labelColor=black&style=flat-square)](LICENSE.md)
[![OpenCode](https://img.shields.io/badge/OpenCode-%3E%3D2.2.6-369eff?labelColor=black&style=flat-square)](https://opencode.ai)

</div>

This repository is a downstream fork of [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent). It adds a native **OpenCode 2 host** (`packages/omo-opencode/src/v2/`) that brings the OmO Native runtime to OpenCode 2: agents, `ultrawork`, background tasks, the workflow DAG, teams, threads, Code Mode, memory with Kibitzer, and the shared skills.

Upstream declined the full port and moved on to its own `omo` app, so the two projects have diverged ([D-018](docs/DECISIONS_V2.md#d-018-upstream-divergence)). The integration branch here is `v2/dev`. Upstream changes are ported into it selectively, in reviewed PRs.

> [!IMPORTANT]
> `curl -fsSL https://get.omo.dev/install.sh | bash`, `omo-ai` and `oh-my-openagent@latest` on npm all install **upstream** OmO, not this fork. This fork is not published to npm. Install it from source as shown below.

## Requirements

- [OpenCode](https://opencode.ai) 2.2.6 or newer (stable releases; checked at startup, see [D-041](docs/DECISIONS_V2.md#d-041-runtime-host-versions-have-a-semantic-minimum-not-an-exact-pin-2026-11-16))
- [Bun](https://bun.sh) 1.4.4 and git

## Install

```bash
git clone https://github.com/hhgyu/oh-my-openagent.git
cd oh-my-openagent
bun install
bun run build
```

Then add the absolute path of the checkout to the `plugin` array in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/oh-my-openagent"]
}
```

On Windows use a forward-slash path such as `"D:/Git/oh-my-openagent"`. Restart OpenCode. The package root and the `./v2` export both start the same OpenCode 2 host; the OpenCode 1 host in `packages/omo-opencode/src/` is unchanged and keeps serving OpenCode 1.

**Update:** `git pull`, then `bun install` and `bun run build`, then restart OpenCode.
**Remove:** delete the path from the `plugin` array. Nothing else in your OpenCode config is rewritten.

## What you get on OpenCode 2

- **Agents.** Sisyphus, Hephaestus, Prometheus, Atlas, Oracle, Librarian, Explore and Sisyphus-Junior, registered as OpenCode agents with their tuned prompts and model chains.
- **ultrawork.** Add `ultrawork` (or `ulw`) to a prompt and the agent explores, plans, verifies each step on the real surface, and stops when the work is done. `ulw-loop` and `ulw-execute` run long, checkpointed work.
- **Tasks, workflows and teams.** `task`, `task_output`, `task_send` and `task_cancel` run child agents; `workflow` runs a dependency graph of them; the lead team tools coordinate a team. Children show in OpenCode's own subagent display.
- **Threads.** `thread_*` tools list, read, message and steer other sessions, across OpenCode processes on the same machine.
- **Code Mode.** Independent tool calls run together in one small JavaScript program, so twenty reads are one round trip.
- **Memory and Kibitzer.** Memory lives in a git repository of markdown files. A cheap model watches the session and nudges the main agent before it repeats a mistake.
- **Shared skills.** 18 OmO skills (frontend, debugging, review-work, ulw-plan, ulw-research and more) load on demand. A host, user or project skill with the same name always wins ([D-047](docs/DECISIONS_V2.md#d-047-the-shared-skills-register-through-one-skilltransform-and-never-replace-a-host-user-or-project-skill-2026-11-20)).
- **Commands.** Every OmO slash command is namespaced as `/omo:<name>`, for example `/omo:goal`, `/omo:memory`, `/omo:remember` and `/omo:doctor`, so none collides with an OpenCode command ([D-039](docs/DECISIONS_V2.md#d-039-every-omo-command-on-opencode-2-is-omonative-name-2026-11-14)).
- **Computer use** (experimental). `/omo:computer` drives local app windows.

## Configuration

Settings live in `~/.omo/omo.jsonc`, and a project can add its own `.omo/omo.jsonc`; the closest file wins. The OpenCode 2 host reads the shared keys plus the `[opencode]` block. Keys are listed in the [`omo.json` reference](docs/reference/omo-json.md) and the [configuration reference](docs/reference/configuration.md).

## Differences from OmO Native

Not everything ports one to one. The [OpenCode 2 parity register](docs/reference/opencode-v2-parity.md) lists every known difference from the Native runtime: what is not ported, what OpenCode 2 cannot do yet, and what behaves differently, each with the test that pins it. Design decisions are recorded in [`docs/DECISIONS_V2.md`](docs/DECISIONS_V2.md).

Most other pages under `docs/` come from upstream and describe upstream OmO. Where they disagree with the parity register, the register is correct for this fork.

## Contributing

- Open PRs against `v2/dev` in this repository, not against upstream. PRs are merged with merge commits.
- Work in a separate git worktree. Changes that reach OpenCode need real-host QA with the `opencode-qa` skill, with evidence kept under `.omo/evidence/` (never committed).
- A change that differs from Native behavior adds or updates a row in the parity register in the same PR.
- Repository conventions for agents and humans are in [`AGENTS.md`](AGENTS.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License and credits

[SUL-1.0](LICENSE.md), the same license as upstream. OmO is created by [@code-yeongyu](https://github.com/code-yeongyu) and the upstream contributors; this fork only adds the OpenCode 2 host and its follow-ups. It is not affiliated with OpenCode or any model provider.
