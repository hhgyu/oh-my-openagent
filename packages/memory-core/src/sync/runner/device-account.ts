// The signed-in device as memory sync sees it: the service origin, the account its sync records
// are bound to, the key pair it registered at sign-in, and a bearer token that refreshes. A host
// supplies one DeviceAccountSource; everything after it is the same code for the TUI, the CLI and
// the desktop. Private keys stay in the credential store and reach only the keyring built from them.

import type { DesktopSyncAccount, DesktopSyncDescriptor, DesktopSyncOperation, SyncOperationAuthority } from "../engine"
import type { DeviceKeyMaterial, DeviceKeyring } from "../keyring-port"

export type KeyringFactory = (material: DeviceKeyMaterial) => Promise<DeviceKeyring>

export interface CliDeviceAccount {
  readonly kind: "cli"
  readonly descriptor: DesktopSyncDescriptor
  readonly signal: AbortSignal
  boundary<T>(dispatch: () => T): Promise<T>
  forOperation(authority: SyncOperationAuthority): Promise<DesktopSyncOperation>
  readonly api: string
  readonly accountId: string
  readonly serviceDeviceId: string
  readonly keyring: (build: KeyringFactory) => Promise<DeviceKeyring>
  readonly accessToken: () => Promise<string>
  /** True once the device's credentials are gone (signed out, or the service revoked the device). */
  readonly signedOut: () => Promise<boolean>
  readonly isCurrent: () => Promise<boolean>
}

/** A desktop host whose private sync channel is missing or refused: sync stays idle and diagnosable, never the CLI. */
export interface DesktopSyncUnavailable {
  readonly kind: "unavailable"
  readonly reason: "private_channel_unavailable" | "port_absent" | "selection_failed" | "host_bootstrap_absent"
}

export type DeviceAccount = CliDeviceAccount | DesktopSyncAccount | DesktopSyncUnavailable
export type DeviceAccountSource = () => Promise<DeviceAccount | null>
