import { expect, test } from "bun:test"
import * as nativeDirective from "./directive"
import * as coreDirective from "@oh-my-opencode/skills-loader-core/opencode-skill-loader/native-git-master-directive"
import * as nativeContent from "./skill-content"
import * as coreContent from "@oh-my-opencode/skills-loader-core/opencode-skill-loader/native-git-master-skill-content"

test("Native exports forward the same Core functions and constants", () => {
  expect(nativeDirective.buildGitMasterAttributionDirective).toBe(coreDirective.buildGitMasterAttributionDirective)
  expect(nativeDirective.DEFAULT_COMMIT_FOOTER).toBe(coreDirective.DEFAULT_COMMIT_FOOTER)
  expect(nativeDirective.COMMIT_ATTRIBUTION_OPEN_TAG).toBe(coreDirective.COMMIT_ATTRIBUTION_OPEN_TAG)
  expect(nativeContent.resolveGitMasterSkillAdditions).toBe(coreContent.resolveGitMasterSkillAdditions)
  expect(nativeContent.carriesAttributionDirective).toBe(coreContent.carriesAttributionDirective)
})
