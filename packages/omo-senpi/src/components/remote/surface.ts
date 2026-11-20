import type { RemoteThreadSurface as CoreRemoteThreadSurface } from "@oh-my-opencode/thread-core/remote/ports"

import type { RemoteClient } from "./types"

/** The thread-core remote surface instantiated with this adapter's remote client. */
export type RemoteThreadSurface = CoreRemoteThreadSurface<RemoteClient>
