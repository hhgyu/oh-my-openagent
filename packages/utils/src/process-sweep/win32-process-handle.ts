// kernel32 through bun:ffi: exact process identity (pid + creation FILETIME) and termination by handle, so a
// pid that was reused by another process is never signalled. Any failure (not Windows, no bun:ffi, access
// denied, process gone) answers null/false, which callers treat as "identity not proven".

const PROCESS_TERMINATE = 0x0001
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const SYNCHRONIZE = 0x0010_0000

type Handle = import("bun:ffi").Pointer | bigint

type Kernel32 = {
  readonly OpenProcess: (access: number, inheritHandle: number, pid: number) => Handle | null
  readonly GetProcessTimes: (
    handle: Handle,
    creation: BigUint64Array,
    exit: BigUint64Array,
    kernel: BigUint64Array,
    user: BigUint64Array,
  ) => number
  readonly TerminateProcess: (handle: Handle, exitCode: number) => number
  readonly CloseHandle: (handle: Handle) => number
}

let kernel32Lookup: Promise<Kernel32 | null> | null = null

async function kernel32(): Promise<Kernel32 | null> {
  if (process.platform !== "win32") return null
  kernel32Lookup ??= (async () => {
    try {
      const { dlopen, FFIType } = await import("bun:ffi")
      return dlopen("kernel32.dll", {
        OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
        GetProcessTimes: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.i32,
        },
        TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
        CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      }).symbols
    } catch {
      return null
    }
  })()
  return kernel32Lookup
}

function isNullHandle(handle: Handle | null): handle is null {
  return handle === null || handle === 0 || handle === 0n
}

function timesOf(api: Kernel32, handle: Handle): { readonly creation: bigint; readonly exit: bigint } | null {
  const creation = new BigUint64Array(1)
  const exit = new BigUint64Array(1)
  const ok = api.GetProcessTimes(handle, creation, exit, new BigUint64Array(1), new BigUint64Array(1))
  const filetime = creation[0] ?? 0n
  return ok === 0 || filetime === 0n ? null : { creation: filetime, exit: exit[0] ?? 0n }
}

function creationOf(api: Kernel32, handle: Handle): bigint | null {
  return timesOf(api, handle)?.creation ?? null
}

export interface HeldProcess {
  readonly pid: number
  readonly creationTicks: bigint
  /** The exit FILETIME once the process ended, null while it runs or when it cannot be read. */
  exitTicks(): bigint | null
  release(): void
}

/** Opens and keeps a handle to `pid`: while it is held Windows cannot hand the pid to another process. */
export async function holdProcess(pid: number): Promise<HeldProcess | null> {
  const api = await kernel32()
  if (api === null || !Number.isSafeInteger(pid) || pid <= 0) return null
  const handle = api.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNullHandle(handle)) return null
  const creationTicks = creationOf(api, handle)
  if (creationTicks === null) {
    api.CloseHandle(handle)
    return null
  }
  let released = false
  return {
    pid,
    creationTicks,
    exitTicks() {
      if (released) return null
      const exit = timesOf(api, handle)?.exit ?? 0n
      return exit === 0n ? null : exit
    },
    release() {
      if (released) return
      released = true
      api.CloseHandle(handle)
    },
  }
}

/** Terminates `pid` only if the process holding it now was created at `creationTicks` (within `toleranceTicks`). */
export async function terminateExactProcess(
  pid: number,
  creationTicks: bigint,
  toleranceTicks: bigint,
): Promise<boolean> {
  const api = await kernel32()
  if (api === null) return false
  const handle = api.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
  if (isNullHandle(handle)) return false
  try {
    const actual = creationOf(api, handle)
    if (actual === null) return false
    const delta = actual > creationTicks ? actual - creationTicks : creationTicks - actual
    if (delta > toleranceTicks) return false
    return api.TerminateProcess(handle, 1) !== 0
  } finally {
    api.CloseHandle(handle)
  }
}
