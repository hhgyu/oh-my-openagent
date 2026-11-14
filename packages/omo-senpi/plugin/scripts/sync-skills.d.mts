export function getSkillOutputManifest(): Promise<{
  readonly root: string
  readonly names: readonly string[]
}>
export function stageNativeSharedSkill(skillName: string, destination: string): Promise<void>
export function syncSkills(): Promise<void>
