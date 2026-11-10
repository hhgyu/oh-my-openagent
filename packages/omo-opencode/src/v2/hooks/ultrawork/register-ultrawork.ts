import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/promise/session"
import { resolveVariant, ultraworkPromptVariants, type VariantTable } from "@oh-my-opencode/prompts-core"
import { classifyUltraworkPrompt } from "./classify-prompt"

/*
 * Event mapping (Native Senpi -> OpenCode 2):
 * - Senpi `input` (UserPromptSubmit / before_agent_start) -> `session.hook("prompt")`: the user
 *   prompt is classified with the shared Senpi detector and the session is armed. Nothing is
 *   written to the transcript; `session.prompt` / `promptAsync` are never called.
 * - Senpi hidden custom message + `context` re-selection -> `session.hook("context")`: every
 *   model request of an armed root session carries exactly one directive system part, whose
 *   variant is selected per request from the receiving model and agent.
 * Senpi delivers the directive once into the transcript, so it stays visible to every later
 * request; a re-mention only adds a reminder. OpenCode 2 system parts are rebuilt per request,
 * so the equivalent is one arming per session and one copy per request: a re-mention never
 * duplicates it.
 */

type Host = Pick<Plugin.Context, "session" | "options">

const DIRECTIVE_MARKER = "omo.ultrawork"
const MAX_ARMED_SESSIONS = 1024
const ULTRAWORK_VARIANTS: VariantTable = ultraworkPromptVariants

function isDisabled(host: Host): boolean {
  return host.options?.["omo-senpi-ultrawork-disabled"] === true ||
    host.options?.["omo-senpi-disabled"] === true || process.env.OMO_SENPI_DISABLED === "1"
}

function directiveFor(context: SessionContext): string | undefined {
  const variant = resolveVariant({ modelID: context.model.id, agentName: context.agent, variants: ULTRAWORK_VARIANTS })
  const source = ULTRAWORK_VARIANTS[variant]
  return source?.kind === "bundled" ? source.content : undefined
}

function carriesDirective(context: SessionContext): boolean {
  return context.system.some(part => part.metadata?.[DIRECTIVE_MARKER] === true)
}

/** Registers ultrawork keyword arming and directive injection; the cleanup disposes both hooks. */
export async function registerUltrawork(host: Host): Promise<() => Promise<void>> {
  if (isDisabled(host)) return async () => {}
  const armed = new Set<string>()
  let closed = false

  async function isChildSession(sessionID: SessionPrompt["sessionID"]): Promise<boolean> {
    try {
      const info = await host.session.get({ sessionID })
      return info.parentID !== undefined && info.parentID !== null
    } catch {
      // Senpi's role lookup also treats an unknown role as a root session.
      return false
    }
  }

  async function onPrompt(input: SessionPrompt): Promise<void> {
    if (closed || armed.has(input.sessionID)) return
    if (classifyUltraworkPrompt(input.prompt) !== "arm") return
    if (await isChildSession(input.sessionID) || closed) return
    armed.add(input.sessionID)
    if (armed.size > MAX_ARMED_SESSIONS) {
      const oldest = armed.values().next()
      if (!oldest.done) armed.delete(oldest.value)
    }
  }

  function onContext(context: SessionContext): void {
    if (closed || !armed.has(context.sessionID) || carriesDirective(context)) return
    const directive = directiveFor(context)
    if (directive === undefined) return
    context.system.push({ type: "text", text: directive, metadata: { [DIRECTIVE_MARKER]: true } })
  }

  const registrations: Registration[] = []
  let disposal: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    if (disposal) return disposal
    closed = true
    armed.clear()
    disposal = Promise.all(registrations.map(registration => registration.dispose())).then(() => undefined)
    return disposal
  }
  try {
    registrations.push(await host.session.hook("prompt", onPrompt))
    registrations.push(await host.session.hook("context", onContext))
  } catch (error) {
    await cleanup()
    throw error
  }
  return cleanup
}
