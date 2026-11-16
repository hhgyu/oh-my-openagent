import { createInterface } from "node:readline"
import { permissionOwner } from "./permission-child.test-support"
import { capture } from "./permission-event.test-support"

const root = process.argv[2] ?? ""
const depth = process.argv[3] ?? "1"
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
// The real rpc host answers its protocol probe from the first line, while the session boots behind it. Booting the
// fixture session first made the parent's 10s designated-chain deadline race a cold senpi import graph.
const booting = permissionOwner({ role: "child", root_session_id: root, depth }).then((owner) => {
  owner.session.extensionRunner?.onRpcEvent((event) => {
    if (event.name === "computer.permission_required") send({ type: "extension_event", ...event })
  })
  return owner
})
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()

for (let next = await lines.next(); next.done !== true; next = await lines.next()) {
  const command = JSON.parse(next.value)
  // A task child's engine must hold its designated model chain before its first prompt (#12759).
  if (command.type === "get_protocol_info") {
    send({
      type: "response",
      command: command.type,
      id: command.id,
      success: true,
      data: { protocolVersion: 1, capabilities: ["retry_fallback_command"] },
    })
    continue
  }
  const fixture = await booting
  if (command.type === "abort") {
    send({ type: "response", command: command.type, id: command.id, success: true })
    break
  }
  if (command.type === "get_state") {
    send({
      type: "response",
      command: command.type,
      id: command.id,
      success: true,
      data: { sessionId: fixture.session.sessionId, isStreaming: false, isCompacting: false },
    })
    continue
  }
  if (command.type !== "prompt") {
    send({ type: "response", command: command.type, id: command.id, success: true })
    continue
  }
  // The response deliberately follows the denial: the owner must retain startup events.
  if (command.message === "nested") await fixture.child("process")
  else if (command.message === "invalid") {
    send({
      type: "extension_event",
      name: "computer.permission_required",
      data: { type: "computer.permission_required", permission: "camera", app: "Test App" },
    })
  } else await fixture.execute("computer", capture)
  send({ type: "response", command: command.type, id: command.id, success: true })
  send({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
  })
  send({ type: "agent_end", messages: [], willRetry: false })
  send({ type: "agent_idle" })
}
await (await booting).close()
process.exit(0)
