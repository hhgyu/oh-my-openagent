export type GioPointer = import("bun:ffi").Pointer

export async function openGio() {
  const { dlopen, toArrayBuffer } = await import("bun:ffi")
  // libgio is part of the GLib stack already loaded by Bun's libsecret backend. No helper process.
  const library = dlopen("libgio-2.0.so.0", {
    g_bus_get_sync: { args: ["i32", "ptr", "ptr"], returns: "ptr" },
    g_object_unref: { args: ["ptr"], returns: "void" },
    g_variant_parse: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "ptr" },
    g_variant_type_new: { args: ["ptr"], returns: "ptr" },
    g_variant_type_free: { args: ["ptr"], returns: "void" },
    g_variant_unref: { args: ["ptr"], returns: "void" },
    g_variant_get_child_value: { args: ["ptr", "usize"], returns: "ptr" },
    g_variant_get_variant: { args: ["ptr"], returns: "ptr" },
    g_variant_is_of_type: { args: ["ptr", "ptr"], returns: "i32" },
    g_variant_get_boolean: { args: ["ptr"], returns: "i32" },
    g_variant_n_children: { args: ["ptr"], returns: "usize" },
    g_variant_get_string: { args: ["ptr", "ptr"], returns: "cstring" },
    g_variant_get_data: { args: ["ptr"], returns: "ptr" },
    g_variant_get_size: { args: ["ptr"], returns: "usize" },
    g_dbus_connection_call_sync: {
      args: ["ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "i32", "i32", "ptr", "ptr"],
      returns: "ptr",
    },
  })
  return { g: library.symbols, toArrayBuffer }
}
