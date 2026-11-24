import { openGio, type GioPointer as Pointer } from "./bun-gio-shim"

const failed = () =>
  new Error("Cannot verify the unlocked Secret Service item without prompting; the operation was stopped.")
const destination = "org.freedesktop.secrets"
const root = "/org/freedesktop/secrets"
const c = (value: string) => Buffer.from(value + "\0")
const quote = (value: string) => "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'"

let gio: ReturnType<typeof openGio> | undefined

export async function readUnlockedSecret(key: { service: string; name: string }): Promise<string | null> {
  const { g, toArrayBuffer } = await (gio ??= openGio())
  const bus = g.g_bus_get_sync(2, null, null) // G_BUS_TYPE_SESSION
  if (!bus) throw failed()
  const owned: Pointer[] = []
  const own = (p: Pointer | bigint | null) => {
    if (!p || typeof p !== "number") throw failed()
    owned.push(p)
    return p
  }
  const child = (p: Pointer, i: number) => own(g.g_variant_get_child_value(p, i))
  const call = (path: string, iface: string, method: string, args: string, resultType: string) => {
    const params = own(g.g_variant_parse(null, c(args), null, null, null))
    const type = g.g_variant_type_new(c(resultType))
    try {
      return own(
        g.g_dbus_connection_call_sync(
          bus,
          c(destination),
          c(path),
          c(iface),
          c(method),
          params,
          type,
          1,
          1000,
          null,
          null,
        ),
      )
    } finally {
      g.g_variant_type_free(type)
    }
  }
  const pathOf = (value: Pointer) => {
    const str = g.g_variant_get_string(value, null)
    if (!str) throw failed()
    return str.toString()
  }
  let session: string | undefined
  try {
    const requireUnlocked = (path: string, kind: "Collection" | "Item") => {
      const locked = own(
        g.g_variant_get_variant(
          child(
            call(
              path,
              "org.freedesktop.DBus.Properties",
              "Get",
              "('org.freedesktop.Secret." + kind + "','Locked')",
              "(v)",
            ),
            0,
          ),
        ),
      )
      const bool = g.g_variant_type_new(c("b"))
      try {
        if (!g.g_variant_is_of_type(locked, bool) || g.g_variant_get_boolean(locked)) throw failed()
      } finally {
        g.g_variant_type_free(bool)
      }
    }
    const iface = "org.freedesktop.Secret."
    const items = call(
      root,
      iface + "Service",
      "SearchItems",
      "({'xdg:schema':'com.oven-sh.bun.Secret','service':" +
        quote(key.service) +
        ",'account':" +
        quote(key.name) +
        "},)",
      "(aoao)",
    )
    const unlocked = child(items, 0),
      count = Number(g.g_variant_n_children(unlocked))
    if (Number(g.g_variant_n_children(child(items, 1))) !== 0 || count > 1) throw failed()
    if (count === 0) {
      requireUnlocked(root + "/aliases/default", "Collection")
      return null
    }
    const item = pathOf(child(unlocked, 0))
    requireUnlocked(item, "Item")
    session = pathOf(child(call(root, iface + "Service", "OpenSession", "('plain', <''>)", "(vo)"), 1))
    const secret = child(
      call(item, iface + "Item", "GetSecret", "(objectpath " + quote(session) + ",)", "((oayays))"),
      0,
    )
    if (pathOf(child(secret, 0)) !== session) throw failed()
    const bytes = child(secret, 2),
      size = Number(g.g_variant_get_size(bytes))
    if (!size) return ""
    const data = g.g_variant_get_data(bytes)
    if (!data) throw failed()
    return new TextDecoder("utf-8", { fatal: true }).decode(toArrayBuffer(data, 0, size))
  } finally {
    try {
      if (session) call(session, "org.freedesktop.Secret.Session", "Close", "()", "()")
    } finally {
      for (const value of owned.reverse()) g.g_variant_unref(value)
      g.g_object_unref(bus)
    }
  }
}
