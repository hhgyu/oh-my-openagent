### Added

- OpenCode 2 thread tools: the eighteen Native `thread_*` tools run on the V2 host as eval-only host tools (`tools.thread_send(...)` inside an `eval` cell) between sessions of the same OpenCode server. A message is delivered exactly once through `session.synthetic` with a deterministic id behind the shared gateway store, steers a running turn by default, reports `waiting_on: approval` for a peer parked on a permission, and a woken session can reply to its sender without a permission prompt (a deny rule still wins). Interrupt, close, rename, model and reasoning changes, read, list, create, handoff and the relay tools (bind, unbind, rebind, bindings, report, outbox, ack, answer) work through the session API. Disable with plugin option `omo-native-threads-enabled: false`.

### Changed

- The harness-neutral thread gateway, contracts and tool bodies moved from `omo-senpi` into the new Core package `@oh-my-opencode/thread-core`; the Senpi thread tools import it with unchanged behavior.
