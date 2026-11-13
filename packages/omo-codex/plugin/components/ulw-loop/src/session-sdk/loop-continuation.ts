// Host-neutral continuation policy for a session-bound ulw-loop run, shared by the omo-senpi `ulw-loop` component
// and the OpenCode 2 host. It classifies one session-scoped status read and decides whether the settle edge that
// follows a finished turn should start a continuation turn. Pure: it never imports the toolkit engine, so a host
// bundle can embed it without the engine.

const ULW_LOOP_CONTINUATION_LIMIT = 8;

export const ULW_LOOP_STEERING_REMINDER = [
	"<omo-senpi-ulw-loop>",
	"An active ulw-loop run is present in this working directory.",
	'Before continuing, read it from a JS eval cell through the SDK: const { agentToolkit } = await import(`${env("OMO_AGENT_TOOLKIT_SDK_ROOT")}/sdk.js`); print(await agentToolkit.status()). The session id is bound from the host env, so pass no session id or plan path, call no tool named omo_agent_toolkit, and spawn no CLI.',
	"Use the returned plan plus its structured nextActions, and the existing .omo/ulw-loop ledger, as the source of truth.",
	"Continue the current ulw-loop story with evidence-bound execution; do not start unrelated work until the active run is complete or checkpointed.",
	"</omo-senpi-ulw-loop>",
].join("\n");

export const ULW_LOOP_CONTINUATION_PROMPT = [
	"Continue the active ulw-loop run.",
	'In a JS eval cell run: const { agentToolkit } = await import(`${env("OMO_AGENT_TOOLKIT_SDK_ROOT")}/sdk.js`); print(await agentToolkit.status()). Inspect the active incomplete goals and the structured nextActions, and keep working until the run is complete or safely checkpointed.',
].join("\n");

export interface LoopPlanSnapshot {
	readonly createdAt: string | undefined;
	readonly aggregateComplete: boolean;
}

export interface LoopStatus {
	readonly raw: string;
	readonly active: boolean;
	/** false marks a probe that never ran because the host could not prove which run it owns. */
	readonly sessionScoped?: boolean;
	/** The plan this status read, for run completion; absent when the session has no readable plan. */
	readonly plan?: LoopPlanSnapshot;
	/**
	 * true only when the read positively showed there is no plan (no scoped goals.json, or ULW_LOOP_PLAN_MISSING). A
	 * failed or unparseable read leaves both `plan` and this unset: unknown, which run completion must not count.
	 */
	readonly noPlan?: boolean;
}

export type LoopStatusIgnored =
	| { readonly reason: "non-zero-exit"; readonly code: number; readonly errorCode: string | undefined }
	| { readonly reason: "malformed-json" };

export interface ClassifiedLoopStatus {
	readonly status: LoopStatus;
	readonly ignored?: LoopStatusIgnored;
}

export const UNSCOPED_LOOP_STATUS: LoopStatus = { raw: "", active: false, sessionScoped: false };
export const NO_PLAN_LOOP_STATUS: LoopStatus = { raw: "", active: false, noPlan: true };

export function classifyLoopStatusRead(result: {
	readonly code: number;
	readonly stdout: string;
}): ClassifiedLoopStatus {
	if (result.code !== 0) {
		const errorCode = toolkitErrorCode(result.stdout);
		const ignored: LoopStatusIgnored = { reason: "non-zero-exit", code: result.code, errorCode };
		if (errorCode === "ULW_LOOP_PLAN_MISSING")
			return { status: { raw: result.stdout, active: false, noPlan: true }, ignored };
		return { status: { raw: result.stdout, active: false }, ignored };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return { status: { raw: result.stdout, active: false }, ignored: { reason: "malformed-json" } };
	}
	const plan = loopPlanSnapshot(parsed);
	return {
		status: {
			raw: result.stdout,
			active: statusHasActiveIncompleteRun(parsed),
			...(plan === undefined ? {} : { plan }),
		},
	};
}

function loopPlanSnapshot(value: unknown): LoopPlanSnapshot | undefined {
	if (!isRecord(value) || value["ok"] !== true || !isRecord(value["plan"])) return undefined;
	const plan = value["plan"];
	const createdAt = typeof plan["createdAt"] === "string" ? plan["createdAt"] : undefined;
	const aggregateComplete =
		isRecord(plan["aggregateCompletion"]) && plan["aggregateCompletion"]["status"] === "complete";
	return { createdAt, aggregateComplete };
}

function statusHasActiveIncompleteRun(value: unknown): boolean {
	if (!isRecord(value) || value["ok"] !== true || !isRecord(value["plan"])) return false;
	const plan = value["plan"];
	if (isRecord(plan["aggregateCompletion"]) && plan["aggregateCompletion"]["status"] === "complete") return false;
	const goals = plan["goals"];
	if (!Array.isArray(goals)) return false;
	return goals.some(isIncompleteGoal);
}

export type LoopContinuationSkip = "session-id-unavailable" | "inactive" | "stale-status";
export type LoopContinuationDecision =
	| { readonly continue: true; readonly count: number }
	| { readonly continue: false; readonly reason: LoopContinuationSkip };

export interface LoopContinuationState {
	capReached(): boolean;
	readonly count: number;
	reset(): void;
	decide(status: LoopStatus): LoopContinuationDecision;
}

export function createLoopContinuationState(limit: number = ULW_LOOP_CONTINUATION_LIMIT): LoopContinuationState {
	let consecutive = 0;
	let previousRaw: string | undefined;
	return {
		capReached: () => consecutive >= limit,
		get count() {
			return consecutive;
		},
		reset() {
			consecutive = 0;
			previousRaw = undefined;
		},
		decide(status) {
			if (status.sessionScoped === false) return { continue: false, reason: "session-id-unavailable" };
			if (!status.active) {
				previousRaw = undefined;
				return { continue: false, reason: "inactive" };
			}
			if (previousRaw === status.raw) return { continue: false, reason: "stale-status" };
			previousRaw = status.raw;
			consecutive += 1;
			return { continue: true, count: consecutive };
		},
	};
}

function toolkitErrorCode(stdout: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (!isRecord(parsed) || !isRecord(parsed["error"])) return undefined;
		const code = parsed["error"]["code"];
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}

function isIncompleteGoal(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value["steeringStatus"] === "superseded" || value["steeringStatus"] === "blocked") return false;
	if (value["status"] !== "pending" && value["status"] !== "in_progress") return false;
	const criteria = value["successCriteria"];
	if (!Array.isArray(criteria) || criteria.length === 0) return true;
	return criteria.some((criterion) => !isRecord(criterion) || criterion["status"] !== "pass");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
