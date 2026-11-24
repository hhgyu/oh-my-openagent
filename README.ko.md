[English](README.md) | [한국어](README.ko.md)

<div align="center">

<img src="./.github/assets/omo-icon-light.svg" alt="OmO" width="160" />

# oh-my-openagent v2

**OpenCode 2를 위한 OmO.**

[![License](https://img.shields.io/badge/license-SUL--1.0-white?labelColor=black&style=flat-square)](LICENSE.md)
[![OpenCode](https://img.shields.io/badge/OpenCode-%3E%3D2.2.6-369eff?labelColor=black&style=flat-square)](https://opencode.ai)

</div>

이 저장소는 [code-yeongyu/oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)의 다운스트림 포크입니다. OmO Native 런타임을 OpenCode 2로 옮긴 네이티브 **OpenCode 2 호스트**(`packages/omo-opencode/src/v2/`)를 더했습니다. 에이전트, `ultrawork`, 백그라운드 태스크, 워크플로 DAG, 팀, 스레드, Code Mode, Kibitzer가 포함된 메모리, 공유 스킬을 OpenCode 2에서 쓸 수 있습니다.

업스트림은 전체 포팅을 받지 않기로 하고 자체 `omo` 앱으로 방향을 바꿨기 때문에 두 프로젝트는 갈라졌습니다([D-018](docs/DECISIONS_V2.md#d-018-upstream-divergence)). 이 저장소의 통합 브랜치는 `v2/dev`이고, 업스트림 변경은 필요한 것만 골라 리뷰를 거친 PR로 포팅합니다.

> [!IMPORTANT]
> `curl -fsSL https://get.omo.dev/install.sh | bash`, npm의 `omo-ai`와 `oh-my-openagent@latest`는 모두 이 포크가 아니라 **업스트림** OmO를 설치합니다. 이 포크는 npm에 배포하지 않으므로 아래처럼 소스에서 설치하세요.

## 요구 사항

- [OpenCode](https://opencode.ai) 2.2.6 이상 (정식 릴리스만, 시작할 때 확인합니다. [D-041](docs/DECISIONS_V2.md#d-041-runtime-host-versions-have-a-semantic-minimum-not-an-exact-pin-2026-11-16) 참고)
- [Bun](https://bun.sh) 1.4.4, git

## 설치

```bash
git clone https://github.com/hhgyu/oh-my-openagent.git
cd oh-my-openagent
bun install
bun run build
```

그다음 `~/.config/opencode/opencode.json`의 `plugin` 배열에 체크아웃의 절대 경로를 추가합니다.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/path/to/oh-my-openagent"]
}
```

Windows에서는 `"D:/Git/oh-my-openagent"`처럼 슬래시 경로를 쓰세요. 추가한 뒤 OpenCode를 다시 시작합니다. 패키지 루트와 `./v2` export는 같은 OpenCode 2 호스트를 띄웁니다. `packages/omo-opencode/src/`의 OpenCode 1 호스트는 바뀌지 않았고 계속 OpenCode 1을 지원합니다.

**업데이트:** `git pull` 후 `bun install`, `bun run build`를 실행하고 OpenCode를 다시 시작합니다.
**제거:** `plugin` 배열에서 경로를 지우면 됩니다. OpenCode 설정의 다른 부분은 건드리지 않습니다.

## OpenCode 2에서 쓸 수 있는 것

- **에이전트.** Sisyphus, Hephaestus, Prometheus, Atlas, Oracle, Librarian, Explore, Sisyphus-Junior가 각자의 프롬프트와 모델 체인으로 OpenCode 에이전트에 등록됩니다.
- **ultrawork.** 프롬프트에 `ultrawork`(또는 `ulw`)를 넣으면 에이전트가 코드베이스를 먼저 읽고, 계획하고, 실제 환경에서 단계마다 검증한 뒤 일이 끝나면 멈춥니다. 오래 걸리는 작업은 `ulw-loop`와 `ulw-execute`가 체크포인트를 남기며 진행합니다.
- **태스크, 워크플로, 팀.** `task`, `task_output`, `task_send`, `task_cancel`로 자식 에이전트를 돌리고, `workflow`로 의존성 그래프를 실행하고, 리드 팀 도구로 팀을 조율합니다. 자식 세션은 OpenCode의 서브에이전트 화면에 그대로 보입니다.
- **스레드.** `thread_*` 도구로 같은 머신의 다른 OpenCode 프로세스에 있는 세션까지 목록 보기, 읽기, 메시지 보내기, 조종이 가능합니다.
- **Code Mode.** 서로 독립적인 도구 호출을 작은 JavaScript 프로그램 하나로 묶어 실행합니다. 파일 스무 개를 읽어도 왕복은 한 번입니다.
- **메모리와 Kibitzer.** 메모리는 마크다운 파일로 된 git 저장소에 저장됩니다. 저렴한 모델이 세션을 지켜보다가 메인 에이전트가 같은 실수를 반복하기 전에 알려줍니다.
- **공유 스킬.** OmO 스킬 18개(frontend, debugging, review-work, ulw-plan, ulw-research 등)를 필요할 때만 불러옵니다. 이름이 같은 호스트, 사용자, 프로젝트 스킬이 있으면 항상 그쪽이 우선입니다([D-047](docs/DECISIONS_V2.md#d-047-the-shared-skills-register-through-one-skilltransform-and-never-replace-a-host-user-or-project-skill-2026-11-20)).
- **명령어.** OmO의 슬래시 명령어는 모두 `/omo:<이름>` 형태입니다. 예: `/omo:goal`, `/omo:memory`, `/omo:remember`, `/omo:doctor`. OpenCode 명령어와 겹치지 않습니다([D-039](docs/DECISIONS_V2.md#d-039-every-omo-command-on-opencode-2-is-omonative-name-2026-11-14)).
- **컴퓨터 사용**(실험 기능). `/omo:computer`로 로컬 앱 창을 조작합니다.

## 설정

설정은 `~/.omo/omo.jsonc`에 두고, 프로젝트마다 `.omo/omo.jsonc`를 따로 둘 수 있습니다. 가장 가까운 파일이 우선합니다. OpenCode 2 호스트는 공통 키와 `[opencode]` 블록을 읽습니다. 전체 키는 [`omo.json` 레퍼런스](docs/reference/omo-json.md)와 [설정 레퍼런스](docs/reference/configuration.md)에 있습니다.

## OmO Native와 다른 점

모든 기능이 똑같이 옮겨지지는 않습니다. [OpenCode 2 패리티 레지스터](docs/reference/opencode-v2-parity.md)에 Native 런타임과 다른 점이 전부 정리돼 있습니다. 포팅하지 않은 것, OpenCode 2가 아직 지원하지 않는 것, 동작이 다른 것을 항목별로 적고, 각 항목을 고정하는 테스트도 함께 적었습니다. 설계 결정은 [`docs/DECISIONS_V2.md`](docs/DECISIONS_V2.md)에 기록합니다.

`docs/` 아래 다른 문서는 대부분 업스트림에서 온 것이라 업스트림 OmO를 설명합니다. 패리티 레지스터와 내용이 다르면 이 포크에서는 레지스터가 맞습니다.

## 기여

- PR은 업스트림이 아니라 이 저장소의 `v2/dev`로 보내 주세요. 머지는 머지 커밋으로 합니다.
- 작업은 별도 git 워크트리에서 합니다. OpenCode에 닿는 변경은 `opencode-qa` 스킬로 실제 호스트 QA를 하고, 증거는 `.omo/evidence/`에 남깁니다(커밋하지 않습니다).
- Native와 동작이 달라지는 변경은 같은 PR에서 패리티 레지스터 항목을 추가하거나 고칩니다.
- 에이전트와 사람 모두를 위한 저장소 규칙은 [`AGENTS.md`](AGENTS.md)와 [`CONTRIBUTING.md`](CONTRIBUTING.md)에 있습니다.

## 라이선스와 크레딧

라이선스는 업스트림과 같은 [SUL-1.0](LICENSE.md)입니다. OmO는 [@code-yeongyu](https://github.com/code-yeongyu)와 업스트림 기여자들이 만들었고, 이 포크는 OpenCode 2 호스트와 그 후속 작업만 더합니다. OpenCode나 모델 제공사와는 관계가 없습니다.
