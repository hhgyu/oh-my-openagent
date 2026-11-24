import { beforeAll, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import { chmod, chown, lstat, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { credentialId } from "./keystore"
import { credentialSchema } from "./protocol"
import { fakeApi, grant, minted, temporaryHome } from "./test-support"

// #7185b: on a Linux machine with no Secret Service, `omo login` keeps the shared sign-in in the private state file, a
// second process uses the same device instead of registering a new one, and `omo logout` removes the file. Use the shipped launcher and bundle without rebuilding either.
const launcher = resolve(import.meta.dir, "../../../../../packages/omo-native/bin/omo.js")

type Run = {
  readonly args: readonly string[]
  readonly code: number
  readonly keystoreCalls: boolean
  readonly stderr: string
  readonly stdout: string
}
type Observed = {
  readonly runs: readonly Run[]
  readonly fileModeAfterLogin: number
  readonly fileDeviceAfterLogin: string
  readonly requests: readonly string[]
}

// The four launcher processes are the slow shared setup, so they run in this hook (a hook may take as long as the
// launcher needs on a loaded machine; a test may not raise its own timeout) and the test asserts what they observed.
let observed: Observed | undefined
beforeAll(async () => {
  if (process.platform !== "linux") return
  const home = await temporaryHome()
  const runtimeDir = join(home, "xdg-run")
  mkdirSync(runtimeDir, { recursive: true })
  const requests: string[] = []
  const api = fakeApi(async (request) => {
    const path = new URL(request.url).pathname
    requests.push(`${request.method} ${path}`)
    if (path === "/v1/health") return Response.json({ ok: true })
    if (path === "/v1/device/code")
      return Response.json({ ...minted, intervalSeconds: 1, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    if (path === "/v1/device/token") return Response.json(grant)
    if (path === "/v1/devices/device-1" && request.method === "DELETE") return new Response(null, { status: 204 })
    return new Response(null, { status: 404 })
  })
  const runs: Run[] = []
  const run = async (args: readonly string[]): Promise<string> => {
    const child = Bun.spawn(
      [process.execPath, "--preload", join(import.meta.dir, "state-file-cli.fixture.ts"), launcher, ...args],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          XDG_RUNTIME_DIR: runtimeDir,
          OMO_RUNTIME: "bun",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
          OMO_SERVICE_API_URL: api,
          // The child's own lock home: the test preload's account seam does not reach a child process (#12978).
          OMO_TEST_CREDENTIAL_LOCK_HOME: home,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      runs.push({ args, code, keystoreCalls: stderr.includes("KEYSTORE_CALL"), stdout, stderr })
      return stdout
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
    }
  }
  const file = join(home, ".omo", "account-state", `omo-cli-${credentialId(api)}.json`)

  await run(["login", "--device", "--no-browser"])
  const fileModeAfterLogin = (await stat(file)).mode & 0o777
  const fileDeviceAfterLogin = credentialSchema.parse(JSON.parse(await readFile(file, "utf8"))).device.id
  await run(["whoami"])
  await run(["account", "show"])
  await run(["logout"])
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" })
  await writeFile(file, "{", { mode: 0o600 })
  await run(["account", "forget"])
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" })
  const normalRuns = runs.slice()
  await writeFile(file, "unsafe synthetic credential", { mode: 0o600 })
  await chmod(file, 0o640)
  await run(["account", "forget"])
  expect(runs.at(-1)?.code).toBe(0)
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" })
  await writeFile(file, "synthetic logout", { mode: 0o600 })
  await chmod(file, 0o640)
  await run(["logout"])
  await expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" })
  const neighbor = join(home, "neighbor.json")
  await writeFile(neighbor, "synthetic neighbor")
  await symlink(neighbor, file)
  for (const kind of process.getuid?.() === 0 ? ["symlink", "foreign"] : ["symlink"]) {
    if (kind === "foreign") {
      await rm(file)
      await writeFile(file, "foreign synthetic", { mode: 0o600 })
      await chown(file, 65534, 65534)
    }
    await run(["account", "forget"])
    const result = runs.at(-1)
    expect(result?.code).not.toBe(0)
    expect(result?.stderr).toContain(file)
    expect(result?.stderr).toContain(kind === "foreign" ? "0600" : "0777")
    expect(result?.stderr).toContain(kind === "foreign" ? "owner" : "symlink")
    expect(result?.stderr).toContain("Inspect")
    if (kind === "foreign") expect(await readFile(file, "utf8")).toBe("foreign synthetic")
    else expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(await readFile(neighbor, "utf8")).toBe("synthetic neighbor")
  }
  observed = {
    runs: normalRuns,
    fileModeAfterLogin,
    fileDeviceAfterLogin,
    requests,
  }
}, 120_000)

test.skipIf(process.platform !== "linux")(
  "#given no Secret Service #when omo logs in, runs again and logs out #then one device lives in the 0600 file until logout",
  () => {
    if (observed === undefined) throw new Error("the launcher runs in beforeAll did not complete")
    const { runs, requests } = observed
    expect(runs.map(({ args, code, keystoreCalls }) => ({ args, code, keystoreCalls }))).toEqual(
      [["login", "--device", "--no-browser"], ["whoami"], ["account", "show"], ["logout"], ["account", "forget"]].map(
        (args) => ({
          args,
          code: 0,
          keystoreCalls: false,
        }),
      ),
    )
    const [login, whoami, show] = runs
    expect(login?.stdout).toContain(minted.userCode)
    expect(observed.fileModeAfterLogin).toBe(0o600)
    expect(observed.fileDeviceAfterLogin).toBe(grant.device.id)

    expect(whoami?.stdout).toContain(grant.device.name)
    expect(JSON.parse((show?.stdout ?? "").trim())).toMatchObject({
      signedIn: true,
      device: { id: grant.device.id },
      storage: "file",
    })
    expect(requests.filter((line) => line === "POST /v1/device/code")).toHaveLength(1)

    expect(requests).toContain("DELETE /v1/devices/device-1")
  },
)
