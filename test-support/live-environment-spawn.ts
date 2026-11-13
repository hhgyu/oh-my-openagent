// Bun.spawn and Bun.spawnSync started without an `env` hand the child the environment this process
// STARTED with, not process.env as the preloads changed it (measured on Bun 1.4.4, Windows). A test child
// spawned that way ran with the developer's real home and temp dir and no agent dir, so it wrote task
// records into the real ~/.omo/agent. node:child_process and Bun.$ pass the live process.env, so a
// Bun.spawn or Bun.spawnSync call without its own env gets a copy of it as well; a call that names its
// env keeps it unchanged.

const installed = Symbol.for("omo.test.liveEnvironmentSpawn")

function withLiveEnvironment(options: unknown): unknown {
  if (options === undefined || options === null) return { env: { ...process.env } }
  if (typeof options !== "object") return options
  if (Reflect.get(options, "env") !== undefined) return options
  return { ...options, env: { ...process.env } }
}

export function liveEnvironmentSpawnArguments(args: readonly unknown[]): unknown[] {
  const [first, second, ...rest] = args
  if (Array.isArray(first)) return [first, withLiveEnvironment(second), ...rest]
  return [withLiveEnvironment(first), ...args.slice(1)]
}

function wrap(name: "spawn" | "spawnSync"): void {
  const original: unknown = Reflect.get(Bun, name)
  if (typeof original !== "function" || Reflect.get(original, installed) === true) return
  const wrapped = (...args: unknown[]): unknown => Reflect.apply(original, Bun, liveEnvironmentSpawnArguments(args))
  Reflect.set(wrapped, installed, true)
  if (!Reflect.set(Bun, name, wrapped)) throw new Error(`could not install the live-environment Bun.${name}`)
}

export function installLiveEnvironmentSpawn(): void {
  wrap("spawn")
  wrap("spawnSync")
}
