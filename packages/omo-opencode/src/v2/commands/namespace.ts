// Every slash command OmO registers on the OpenCode 2 host is `/omo:<Native name>` (D-039): one namespace keeps OmO
// apart from the host's own commands (OpenCode 2.2.6 ships `/init`, `/review` and `/goal`). Native (Senpi) keeps the
// bare names, so the shared code and the senpi engine write texts that name the Native commands; V2 rewrites those
// texts where they leave V2 (command output, footer, tool results, staged skills) with `rewriteCommandMentions`.

const OMO_COMMAND_PREFIX = "omo:"

export const NATIVE_COMMAND_NAMES = [
  "memory",
  "memfs",
  "remember",
  "init",
  "recompile",
  "memory-repository",
  "search",
  "facts",
  "agreements",
  "reflect",
  "dream",
  "doctor",
  "sleeptime",
  "people",
  "palace",
  "goal",
] as const

export type NativeCommandName = (typeof NATIVE_COMMAND_NAMES)[number]

export function v2CommandName(name: NativeCommandName): string {
  return `${OMO_COMMAND_PREFIX}${name}`
}

export function v2Slash(name: NativeCommandName): string {
  return `/${v2CommandName(name)}`
}

// A token starts after a line start, whitespace, a quote, a backtick or an opening bracket, and ends before anything
// that would continue a word, a path or a file name, so `~/.omo/memory/`, `</goal_x>` and `/init.d` stay as they are.
const LONGEST_FIRST = [...NATIVE_COMMAND_NAMES].sort((left, right) => right.length - left.length)
const MENTION = new RegExp(`(^|[\\s\`"'(\\[])/(${LONGEST_FIRST.join("|")})(?![\\w/-]|\\.\\w)`, "g")

export function rewriteCommandMentions(text: string): string {
  return text.replace(MENTION, (_match, lead: string, name: string) => `${lead}/${OMO_COMMAND_PREFIX}${name}`)
}
