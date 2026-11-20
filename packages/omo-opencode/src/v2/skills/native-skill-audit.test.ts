import { describe, expect, test } from "bun:test"
import { auditNativeSkillText } from "./native-skill-audit"
import { adaptQuestionCallsForV2 } from "./question-call-adaptation"
import { adaptTeamToolsForV2 } from "./team-tool-adaptation"

const ANCHORS = [
  "Call `team_list` and verify no active",
  "a single `team_status` check is acceptable",
  "`team_list` to confirm no residual",
  "`team_shutdown_request` for each member, then `team_approve_shutdown` if members",
  'task_send(team_run_id=<id>, to=\\"lead\\", message=<m>) + task_update(status=completed).',
  'task_send(team_run_id=<id>, to=\\"lead\\", message=<m>) + task_update(status=pending).',
  "retry with `task_update(status=pending)` on the step",
]

describe("Native-only instruction audit of staged skills", () => {
  test("#given a forbidden call field or an unaccepted Native tool outside the banner #when audited #then both are MANDATORY", () => {
    // given
    const text = [
      "ask with `required: true` and waitForAnswer",
      "send with team_send_message",
      "Read `mass-ulw` first",
    ].join("\n")

    // when
    const hits = auditNativeSkillText("x/SKILL.md", text, [])

    // then
    expect(hits.map((hit) => [hit.rule, hit.class])).toEqual([
      ["waitForAnswer", "MANDATORY"],
      ["required-flag", "MANDATORY"],
      ["team_send_message", "MANDATORY"],
      ["mass-ulw-read", "MANDATORY"],
      ["mass-ulw", "MANDATORY"],
    ])
  })

  test("#given the same identifiers inside the banner or accepted by the ledger #when audited #then they are CONDITIONAL, a forbidden one still is not", () => {
    // given
    const text = [
      "## Senpi Harness Tool Compatibility",
      "`monitor` and team_status",
      "## Next",
      "uses `lsp_status`",
      "waitForAnswer",
    ].join("\n")

    // when
    const hits = auditNativeSkillText("x/SKILL.md", text, [
      { file: "x/", rule: "lsp_status", reason: "has a fallback" },
    ])

    // then
    expect(hits.map((hit) => [hit.rule, hit.class])).toEqual([
      ["team_status", "CONDITIONAL"],
      ["monitor", "CONDITIONAL"],
      ["lsp_status", "CONDITIONAL"],
      ["waitForAnswer", "MANDATORY"],
    ])
  })

  test("#given a question call and team text #when adapted #then the Native fields and tools are gone and a drifted anchor throws", () => {
    // given
    const question =
      "with header `Approval` (`승인` in Korean), `required: true` and the wait flag true on that call**:"
    const team = [...ANCHORS, 'team_send_message(teamRunId=<id>, to="*", kind="announcement", body=<x>)'].join("\n")

    // when
    const adaptedQuestion = adaptQuestionCallsForV2("ulw-plan/SKILL.md", question)
    const adaptedTeam = adaptTeamToolsForV2("refactor/SKILL.md", team)

    // then
    expect(adaptedQuestion).not.toContain("required")
    expect(auditNativeSkillText("refactor/SKILL.md", adaptedTeam, [])).toEqual([])
    expect(adaptedTeam).toContain('task_send(team_run_id=<id>, to="*", message=<x>)')
    expect(() => adaptQuestionCallsForV2("ulw-plan/SKILL.md", "other")).toThrow("drifted")
    expect(() => adaptTeamToolsForV2("refactor/SKILL.md", "other")).toThrow("drifted")
  })

  test("#given call-shaped examples with wrong argument shapes #when audited #then each unknown, lead-only or missing argument is MANDATORY", () => {
    // given
    const text = [
      'task_send(team_run_id=<id>, to="a", kind="announcement", message=<m>)',
      '    "prompt": "report via task_send(team_run_id=<id>, to=\\"lead\\", message=<m>) then task_update(status=completed)"',
      "task_create(team_run_id=<id>, subject=<s>, description=<d>, blockedBy=<b>)",
      "task_update(status=pending)",
    ].join("\n")

    // when
    const hits = auditNativeSkillText("x/SKILL.md", text, [])

    // then
    expect(hits.map((hit) => `${hit.line}:${hit.rule}:${hit.text}`)).toEqual([
      "1:arg-unknown:task_send(kind)",
      "2:arg-unknown:task_send(team_run_id)",
      "2:member-tool:task_update(...)",
      "3:arg-unknown:task_create(blockedBy)",
      "4:arg-missing:task_update(team_run_id)",
      "4:arg-missing:task_update(task_id)",
    ])
  })

  test("#given valid delegation, inline-spec and multi-line calls #when audited #then no argument finding is raised", () => {
    // given
    const text = [
      'task(category="deep", load_skills=[], run_in_background=true, prompt=<x + "PASS" or "FAIL:<why>">)',
      'team_create({ inline_spec: { members: [{ kind: "category", category: "quick" }] } })',
      "task_send(",
      '  team_run_id=<id>, to="*", summary="s",',
      "  message=<m>",
      ")",
    ].join("\n")

    // when
    const hits = auditNativeSkillText("x/SKILL.md", text, [])

    // then
    expect(hits).toEqual([])
  })

  test("#given a kind field on the next line and a blockedBy argument #when team text is adapted #then both are rewritten for V2", () => {
    // given
    const text = [
      ...ANCHORS,
      'task_send(\n  kind="announcement",\n  to="*")',
      "task_create(team_run_id=<id>, subject=<s>, description=<d>, blockedBy=<b>)",
    ].join("\n")

    // when
    const adapted = adaptTeamToolsForV2("refactor/SKILL.md", text)

    // then
    expect(adapted).not.toContain("kind=")
    expect(adapted).toContain("blocked_by=<b>")
    expect(adapted).not.toContain('task_send(team_run_id=<id>, to=\\"lead\\"')
    expect(auditNativeSkillText("refactor/SKILL.md", adapted, [])).toEqual([])
  })
})
