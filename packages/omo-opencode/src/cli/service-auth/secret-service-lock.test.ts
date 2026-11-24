import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { grant, privateKeys } from "./test-support"
import { credentialId } from "./keystore"
import { classifyProbeFailure, parseLockedReply } from "./secret-service-lock"

const FAKE_SECRET_SERVICE = `
import sys, os
from gi.repository import Gio, GLib
mode = sys.argv[1]
state = {"locked": mode not in ("unlocked", "lookup", "migration", "relock")}
COLLECTION = "/org/freedesktop/secrets/aliases/default"
xml = """<node><interface name="org.freedesktop.Secret.Collection"><property name="Locked" type="b" access="read"/></interface>
<interface name="org.freedesktop.Secret.Service"><method name="Unlock"><arg name="objects" type="ao" direction="in"/><arg name="unlocked" type="ao" direction="out"/><arg name="prompt" type="o" direction="out"/></method></interface></node>"""
xml = xml.replace('<method name="Unlock">','''<method name="SearchItems"><arg type="a{ss}" direction="in"/><arg type="ao" direction="out"/><arg type="ao" direction="out"/></method><method name="OpenSession"><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="v" direction="out"/><arg type="o" direction="out"/></method><method name="Unlock">''').replace('</node>', '''<interface name="org.freedesktop.Secret.Item"><property name="Locked" type="b" access="read"/><method name="GetSecret"><arg type="o" direction="in"/><arg type="(oayays)" direction="out"/></method></interface></node>''')
xml = xml.replace('</node>','<interface name="org.freedesktop.Secret.Session"><method name="Close"/></interface></node>')
node = Gio.DBusNodeInfo.new_for_xml(xml)
def get_property(conn, sender, path, iface, name):
    return GLib.Variant("b", state["locked"])
# Unlock replies by mode: (unlocked paths, prompt, collection unlocked afterwards). "resolved" answers the alias with the
# real collection path (as oo7 does), "raced" lists nothing because another client unlocked first, "stuck" says no prompt
# yet stays locked, "locked" needs a prompt, which nothing may ever open, and "error" fails the call.
REPLIES = {
    "resolved": (["/org/freedesktop/secrets/collection/login"], "/", True),
    "raced": ([], "/", True),
    "stuck": ([], "/", False),
    "locked": ([], "/org/freedesktop/secrets/prompt/u1", False),
}
def unlock(conn, sender, path, iface, method, params, invocation):
    if method == 'Close':
        invocation.return_value(None)
        return
    if method == 'SearchItems':
        expected = {'service':'omo-cli','account':'synthetic','xdg:schema':'com.oven-sh.bun.Secret'}
        if mode in ('migration','relock'):
            expected['account'] = os.environ['TEST_ACCOUNT_SLOT']
            assert params.unpack()[0] == expected
            invocation.return_value(GLib.Variant('(aoao)', (['/item'] if os.path.exists(os.environ['TEST_RING']) else [],[])))
            return
        assert params.unpack()[0] == expected
        invocation.return_value(GLib.Variant('(aoao)', (['/item'],[])))
        return
    if method == 'OpenSession':
        invocation.return_value(GLib.Variant('(vo)', (GLib.Variant('s',''),'/session')))
        return
    if method == 'GetSecret':
        value = b'synthetic-value' if mode == 'lookup' else open(os.environ['TEST_RING'],'rb').read()
        if mode == 'relock': state['locked'] = True
        invocation.return_value(GLib.Variant('((oayays))', (('/session',[],list(value),'text/plain'),)))
        return
    if mode == "error":
        invocation.return_dbus_error("org.freedesktop.Secret.Error.NoSuchObject", "no such collection")
        return
    unlocked, prompt, opened = REPLIES[mode]
    if opened:
        state["locked"] = False
    invocation.return_value(GLib.Variant("(aoo)", (unlocked, prompt)))
def on_bus(conn, name):
    conn.register_object("/session", node.interfaces[3], unlock, None, None)
    conn.register_object("/item", node.interfaces[2], unlock, get_property, None)
    conn.register_object("/org/freedesktop/secrets", node.interfaces[1], unlock, None, None)
    if mode not in ("lookup", "no-default-collection"):
        conn.register_object(COLLECTION, node.interfaces[0], None, get_property, None)
def on_name(conn, name):
    print("READY", flush=True)
Gio.bus_own_name(Gio.BusType.SESSION, "org.freedesktop.secrets", Gio.BusNameOwnerFlags.NONE, on_bus, on_name, None)
GLib.MainLoop().run()
`

// A private session bus with no <servicedir>: nothing on it can be D-Bus-activated, so "none" means no Secret Service
// even on a host whose gnome-keyring ships an activatable org.freedesktop.secrets (#12643).
const PRIVATE_BUS_CONFIG = `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`

// What such a host looks like to a session bus that does read service dirs: an activatable Secret Service that never
// answers. Every probe runs with it on its XDG data path.
const HANGING_SECRET_SERVICE = "[D-BUS Service]\nName=org.freedesktop.secrets\nExec=/bin/sleep 600\n"

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0
const canRun =
  process.platform === "linux" &&
  has("dbus-run-session", ["--version"]) &&
  has("gdbus", ["help"]) &&
  has("python3", ["-c", "from gi.repository import Gio"])

describe("probeSecretServiceLock without gdbus", () => {
  // #10658 review: a minimal install without libglib2.0-bin has no gdbus; that says nothing about the keyring.
  test("is unknown, never absent", async () => {
    const path = process.env.PATH
    const emptyBin = mkdtempSync(join(tmpdir(), "omo-no-gdbus-"))
    process.env.PATH = emptyBin
    try {
      const { probeSecretServiceLock } = await import("./secret-service-lock")
      expect(await probeSecretServiceLock()).toBe("unknown")
    } finally {
      process.env.PATH = path
      rmSync(emptyBin, { recursive: true, force: true })
    }
  })
})

// #7185b: only a Secret Service that does not exist sends the sign-in to the private state file, so every other
// gdbus failure (a Secret Service with no default collection, a timeout) must stay "unknown" and keep libsecret.
describe("classifyProbeFailure", () => {
  test("no session bus, or nothing owning org.freedesktop.secrets, is absent; any other failure is unknown", () => {
    expect(classifyProbeFailure("Error connecting: Could not connect: No such file or directory\n")).toBe("absent")
    expect(
      classifyProbeFailure(
        'Error connecting: Failed to execute child process "dbus-launch" (No such file or directory)\n',
      ),
    ).toBe("absent")
    expect(
      classifyProbeFailure(
        "Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files\n",
      ),
    ).toBe("absent")
    expect(classifyProbeFailure("Error: GDBus.Error:org.freedesktop.DBus.Error.NameHasNoOwner: no owner\n")).toBe(
      "absent",
    )
    expect(
      classifyProbeFailure(
        "Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownObject: No such object path '/org/freedesktop/secrets/aliases/default'\n",
      ),
    ).toBe("unknown")
    expect(classifyProbeFailure("Error: Timeout was reached\n")).toBe("unknown")
    // #13640 review M1: a bus that exists but refuses this process (sudo -u with another user's bus address) or stopped
    // answering is no proof that the Secret Service is missing.
    expect(classifyProbeFailure("Error connecting: Could not connect: Permission denied\n")).toBe("unknown")
    expect(classifyProbeFailure("Error connecting: Could not connect: Connection refused\n")).toBe("unknown")
    expect(classifyProbeFailure("Error connecting: Exhausted all available authentication mechanisms\n")).toBe(
      "unknown",
    )
    expect(classifyProbeFailure("")).toBe("unknown")
  })
})

describe.skipIf(process.platform !== "linux" || !has("gdbus", ["help"]))(
  "probeSecretServiceLock with no session bus",
  () => {
    test("is absent", async () => {
      const dir = mkdtempSync(join(tmpdir(), "omo-no-bus-"))
      const before = process.env.DBUS_SESSION_BUS_ADDRESS
      process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${join(dir, "missing-bus")}`
      try {
        const { probeSecretServiceLock } = await import("./secret-service-lock")
        expect(await probeSecretServiceLock()).toBe("absent")
      } finally {
        if (before === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS
        else process.env.DBUS_SESSION_BUS_ADDRESS = before
        rmSync(dir, { recursive: true, force: true })
      }
    })
  },
)

describe("parseLockedReply", () => {
  test("reads gdbus's Locked property reply", () => {
    expect(parseLockedReply("(<true>,)\n")).toBe("locked")
    expect(parseLockedReply("(<false>,)\n")).toBe("unlocked")
    expect(parseLockedReply("garbage")).toBeNull()
  })
})

describe.skipIf(!canRun)(
  "probeSecretServiceLock against a fake Secret Service on a private D-Bus (desktop#3509)",
  () => {
    const probeIn = (
      fake:
        | "migration"
        | "relock"
        | "lookup"
        | "locked"
        | "resolved"
        | "raced"
        | "stuck"
        | "error"
        | "unlocked"
        | "none"
        | "no-default-collection",
    ): string => {
      const dir = mkdtempSync(join(tmpdir(), "omo-secret-service-"))
      try {
        const fakePath = join(dir, "fake.py")
        writeFileSync(fakePath, FAKE_SECRET_SERVICE)
        const busConfig = join(dir, "bus.conf")
        writeFileSync(busConfig, PRIVATE_BUS_CONFIG)
        const services = join(dir, "data", "dbus-1", "services")
        mkdirSync(services, { recursive: true })
        writeFileSync(join(services, "org.freedesktop.secrets.service"), HANGING_SECRET_SERVICE)
        const probeModule = join(import.meta.dir, "secret-service-lock.ts")
        const command =
          fake === "lookup"
            ? `process.env.PATH = "/no-client-binaries"; const {readUnlockedSecret} = await import(${JSON.stringify(join(import.meta.dir, "unlocked-secret-read.ts"))}); console.log(await readUnlockedSecret({service:"omo-cli", name:"synthetic"}))`
            : `const { probeSecretServiceLock } = await import(${JSON.stringify(probeModule)}); console.log(await probeSecretServiceLock())`
        const cli = fake === "migration" || fake === "relock"
        const api = "http://127.0.0.1:1"
        const name = credentialId(api)
        const privateDir = join(dir, ".omo", "account-state"),
          privateFile = join(privateDir, `omo-cli-${name}.json`),
          ring = join(dir, "ring"),
          preload = join(dir, "fixture.ts"),
          bin = join(dir, "bin")
        if (cli) {
          mkdirSync(privateDir, { recursive: true, mode: 0o700 })
          mkdirSync(bin)
          symlinkSync(Bun.which("gdbus")!, join(bin, "gdbus"))
          symlinkSync(process.execPath, join(bin, "bun"))
          const record = { ...grant, ...privateKeys }
          writeFileSync(privateFile, JSON.stringify(record), { mode: 0o600 })
          if (fake === "relock")
            writeFileSync(ring, JSON.stringify({ ...record, device: { ...record.device, id: "other" } }))
          writeFileSync(
            preload,
            `import fs,{existsSync,readFileSync,writeFileSync,appendFileSync,unlinkSync} from "node:fs"; import {mock} from "bun:test"; const originalRead=fs.readFileSync; mock.module("node:fs",()=>({...fs,readFileSync:(name,...args)=>name==="/etc/passwd" ? "fixture:x:"+process.getuid()+":0::"+process.env.HOME+":/bin/sh" : originalRead(name,...args)})); const path=${JSON.stringify(ring)}; Object.defineProperty(Bun,"secrets",{value:{ get:async()=>{appendFileSync(path+".reads","g");return existsSync(path)?readFileSync(path,"utf8"):null},set:async({value})=>writeFileSync(path,value),delete:async()=>{unlinkSync(path);return true}}}); Object.assign(globalThis,{[Symbol.for("omo.test.serviceAccountsOpen")]:true})`,
          )
        }
        const start =
          fake === "none"
            ? ""
            : `python3 ${JSON.stringify(fakePath)} ${fake} > "$D/ready" & until grep -q READY "$D/ready" 2>/dev/null; do :; done;`
        const run = spawnSync(
          "dbus-run-session",
          [
            `--config-file=${busConfig}`,
            "--",
            "bash",
            "-c",
            `D=${JSON.stringify(dir)}; ${start} ${cli ? `PATH=${JSON.stringify(bin)} ${JSON.stringify(process.execPath)} --preload ${JSON.stringify(preload)} ${JSON.stringify(join(import.meta.dir, "../../../../../packages/omo-native/bin/omo.js"))} account ${fake === "migration" ? "show" : "forget"}` : `bun -e '${command}'`}`,
          ],
          {
            cwd: dir,
            encoding: "utf8",
            timeout: 20_000,
            env: {
              ...process.env,
              HOME: dir,
              USERPROFILE: dir,
              OMO_RUNTIME: "bun",
              OMO_TEST_CREDENTIAL_LOCK_HOME: dir,
              OMO_SERVICE_API_URL: api,
              TEST_ACCOUNT_SLOT: name,
              TEST_RING: ring,
              XDG_DATA_HOME: join(dir, "data"),
            },
          },
        )
        if (cli) {
          expect(Bun.which("python3", { PATH: bin })).toBeNull()
          if (fake === "migration") {
            expect(run.status).toBe(0)
            expect(JSON.parse(run.stdout)).toMatchObject({ signedIn: true, storage: "keyring" })
            expect(existsSync(privateFile)).toBe(false)
            expect(JSON.parse(readFileSync(ring, "utf8")).device).toEqual(grant.device)
          } else {
            expect(run.status).not.toBe(0)
            expect(existsSync(privateFile)).toBe(true)
            expect(JSON.parse(readFileSync(ring, "utf8")).device.id).toBe("other")
            expect(readFileSync(ring + ".reads", "utf8")).toBe("g")
            expect(run.stderr).toContain("could not be verified")
          }
          return "checked"
        }
        return run.stdout.trim().split("\n").at(-1) ?? ""
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test.each(["migration", "relock"] as const)("shipped account CLI without Python: %s", (mode) =>
      expect(probeIn(mode)).toBe("checked"),
    )

    test("reads an unlocked synthetic item without Unlock or Prompt", () => {
      expect(probeIn("lookup")).toBe("synthetic-value")
    })

    // #14039: a locked collection is asked to Unlock; only a finished unlock (prompt "/") followed by Locked=false counts.
    test.each([
      ["answers with the real collection path", "unlocked", "resolved"],
      ["lists nothing because another client unlocked it first", "unlocked", "raced"],
      ["finishes without a prompt but the collection stays locked", "locked", "stuck"],
      ["needs a prompt", "locked", "locked"],
      ["fails with a D-Bus error", "locked", "error"],
    ] as const)("a locked default collection whose Unlock %s is %s", (_case, expected, fake) => {
      expect(probeIn(fake)).toBe(expected)
    })
    test("an unlocked default collection is unlocked", () => {
      expect(probeIn("unlocked")).toBe("unlocked")
    })
    test("no Secret Service on the bus is absent, also where the host could activate one (#12643)", () => {
      expect(probeIn("none")).toBe("absent")
    })
    test("a Secret Service with no default collection is unknown, never absent (#7185b)", () => {
      expect(probeIn("no-default-collection")).toBe("unknown")
    })
  },
)
