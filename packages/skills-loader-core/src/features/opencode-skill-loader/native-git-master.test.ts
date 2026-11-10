import { expect, test } from "bun:test"
import { buildGitMasterAttributionDirective, DEFAULT_COMMIT_FOOTER } from "./native-git-master-directive"
import { carriesAttributionDirective, resolveGitMasterSkillAdditions } from "./native-git-master-skill-content"

for (const footer of [false, true, "CUSTOM_FOOTER"] as const) {
  for (const coauthor of [false, true]) {
    for (const prefix of ["", "NATIVE=1"]) {
      test(`exact attribution settings footer=${footer} coauthor=${coauthor} prefix=${prefix}`, () => {
        const settings = { commit_footer: footer, include_co_authored_by: coauthor, git_env_prefix: prefix }
        const directive = buildGitMasterAttributionDirective(settings, prefix)
        const additions = resolveGitMasterSkillAdditions(settings)
        expect(directive === undefined).toBe(footer === false && !coauthor)
        expect(additions === undefined).toBe(footer === false && !coauthor && prefix === "")
        if (directive) {
          expect(directive.includes("Co-authored-by: sisyphus-dev-ai <")).toBe(coauthor)
          if (footer !== false) expect(directive).toContain(footer === true ? DEFAULT_COMMIT_FOOTER : footer)
          expect(carriesAttributionDirective(["plain", directive])).toBe(true)
        }
        if (additions) {
          const original = "---\r\nname: git-master\r\n---\r\n```bash\ngit status\n```"
          const result = additions.rewriteSkillText(original)
          expect(result).toStartWith("---\r\nname: git-master\r\n---\r\n")
          expect(result).not.toContain("<commit_attribution>")
          if (prefix) expect(result).toContain(`${prefix} git status`)
          else expect(result).toBe(original)
        }
      })
    }
  }
}
