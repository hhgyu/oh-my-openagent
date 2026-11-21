export const THREAD_OPEN_BLOCK = "omo-thread"

export const THREAD_OPEN_GUIDANCE = [
  "In the OpenCode 2 TUI with the OmO TUI plugin, show the thread title as plain text, then render a clickable Open session button using this format:",
  `\`\`\`${THREAD_OPEN_BLOCK}`,
  "omo-thread://v1/<session ID>",
  "```",
  "Use only the URL from the actual thread result inside the fence. Do not paste it as an ordinary Markdown link in OpenCode. If the button is unavailable, give the title and suggest /sessions.",
].join("\n")
