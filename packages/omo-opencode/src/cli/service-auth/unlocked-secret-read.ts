import { execFile } from "node:child_process"

// Use the Secret Service directly for the locked-section recheck. Unlike libsecret's password lookup,
// SearchItems and GetSecret never unlock an item or run a prompt. One connection owns the plain session.
const readUnlocked = `
import json, sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
root = '/org/freedesktop/secrets'
def call(path, interface, method, args):
    return bus.call_sync('org.freedesktop.secrets', path, 'org.freedesktop.Secret.' + interface,
                         method, args, None, Gio.DBusCallFlags.NO_AUTO_START, 1000, None).unpack()
attrs = {'xdg:schema': 'com.oven-sh.bun.Secret', 'service': sys.argv[1], 'account': sys.argv[2]}
items, locked = call(root, 'Service', 'SearchItems', GLib.Variant('(a{ss})', (attrs,)))
if locked or len(items) > 1:
    sys.exit(1)
if not items:
    print('null')
else:
    _, session = call(root, 'Service', 'OpenSession', GLib.Variant('(sv)', ('plain', GLib.Variant('s', ''))))
    secret, = call(items[0], 'Item', 'GetSecret', GLib.Variant('(o)', (session,)))
    print(json.dumps(bytes(secret[2]).decode('utf-8')))
`

export function readUnlockedSecret(key: { service: string; name: string }): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const failed = () =>
      new Error("Cannot verify the unlocked Secret Service item without prompting; its private file was kept.")
    execFile(
      "python3",
      ["-I", "-c", readUnlocked, key.service, key.name],
      { timeout: 3000, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout) => {
        if (error) return reject(failed())
        try {
          const value: unknown = JSON.parse(stdout)
          if (value === null || typeof value === "string") resolve(value)
          else reject(failed())
        } catch {
          reject(failed())
        }
      },
    )
  })
}
