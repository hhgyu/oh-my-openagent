// The V2 sync host's signed-in device: the CLI account source both hosts share, told about this machine's
// running device service the way Senpi's `device-session/account-runtime.ts` (`engineDeviceService`) tells it.
// Loaded only with the sync host chunk (`./host.ts`).

import packageJson from "../../../../../../package.json" with { type: "json" }
import {
  connectDeviceService,
  type DeviceService,
  deviceServiceStateDir,
  forgetDeviceService,
  handDeviceKeys,
} from "@oh-my-opencode/device-service-core"
import type { DeviceAccountSource } from "@oh-my-opencode/memory-core/sync-runner"
import { createCliAccountSource, type HeldCredentialRelay } from "../../../cli/service-auth/sync-account"

/** This machine's running device service, never installed or started from here (design D r9 section 3). */
function deviceServiceRelay(stateDir: string, log?: (line: string) => void): HeldCredentialRelay {
  const connect = (): Promise<DeviceService> =>
    connectDeviceService({ version: packageJson.version, stateDir, background: true })
  return {
    readopt: async (credential) =>
      (await handDeviceKeys({ stateDir, connect, credential, when: "not_adopted", log })) !== "not_running",
    forget: async () => {
      await forgetDeviceService({ stateDir, connect, log })
    },
  }
}

type CliAccountOptions = Parameters<typeof createCliAccountSource>[0]

/**
 * Built on the first resolve, so an invalid OMO_SERVICE_API_URL reaches the runner as a typed `sync-config-invalid`
 * status instead of failing the host load. The relay's state directory follows the host's environment.
 */
export function hostAccountSource(
  options: CliAccountOptions & { readonly deviceServiceStateDir?: string },
): DeviceAccountSource {
  let built: DeviceAccountSource | undefined
  return async () => {
    if (built === undefined) {
      const { deviceServiceStateDir: stateDir, ...cli } = options
      const warn = options.logger === undefined ? undefined : (line: string) => options.logger?.warn(line)
      built = createCliAccountSource({
        relay: deviceServiceRelay(
          stateDir ?? deviceServiceStateDir(process.platform, options.env ?? process.env),
          warn,
        ),
        ...cli,
      })
    }
    return built()
  }
}
