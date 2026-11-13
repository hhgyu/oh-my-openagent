import { existsSync } from "node:fs";
import { normalizeUlwLoopSessionId, ulwLoopGoalsPath } from "../paths.js";
import { createAgentToolkit } from "../sdk.js";
import {
	type ClassifiedLoopStatus,
	classifyLoopStatusRead,
	NO_PLAN_LOOP_STATUS,
	UNSCOPED_LOOP_STATUS,
} from "./loop-continuation.js";

// A host-side read of one session's loop, keyed by the host's own session id: the same scope the eval SDK binds
// from PI_SESSION_ID, so the host and the session's cells always read one plan.
export async function readHostLoopStatus(cwd: string, hostSessionId: string): Promise<ClassifiedLoopStatus> {
	const sessionId = normalizeUlwLoopSessionId(hostSessionId);
	if (sessionId === null) return { status: UNSCOPED_LOOP_STATUS };
	if (!existsSync(ulwLoopGoalsPath(cwd, { sessionId }))) return { status: NO_PLAN_LOOP_STATUS };
	const response = await createAgentToolkit({ cwd, sessionId, surface: "omo-senpi" }).status();
	if (!response.ok) return classifyLoopStatusRead({ code: 1, stdout: JSON.stringify(response) });
	return classifyLoopStatusRead({ code: 0, stdout: JSON.stringify({ ok: true, ...response.result }) });
}
