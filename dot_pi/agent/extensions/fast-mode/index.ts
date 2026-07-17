import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXTENSION_ID = "fast-mode";
const STATE_ENTRY_TYPE = "fast-mode-state";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_CODEX_RESPONSES_API = "openai-codex-responses";
const FAST_SERVICE_TIER = "priority";
const FAST_MODE_ENVIRONMENT_VARIABLE = "PI_FAST_MODE_ENABLED";

// OpenAI's Codex catalog advertises the priority/Fast tier for these model slugs:
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
export const SUPPORTED_OPENAI_CODEX_MODELS = [
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
] as const;

const SUPPORTED_MODEL_IDS = new Set<string>(SUPPORTED_OPENAI_CODEX_MODELS);
const COMMAND_ACTIONS = ["on", "off", "status", "models"] as const;

export interface FastModeModel {
	provider: string;
	api: string;
	id: string;
}

export interface FastModeEligibility {
	eligible: boolean;
	modelKey: string;
	reason?: string;
}

interface PersistedFastModeState {
	version: 1;
	enabled: boolean;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatModelKey(model: FastModeModel | undefined): string {
	return model ? `${model.provider}/${model.id}` : "no model";
}

export function getFastModeEligibility(
	model: FastModeModel | undefined,
	usingOAuth: boolean,
): FastModeEligibility {
	const modelKey = formatModelKey(model);

	if (!model) {
		return { eligible: false, modelKey, reason: "no model is selected" };
	}

	if (model.provider !== OPENAI_CODEX_PROVIDER) {
		return {
			eligible: false,
			modelKey,
			reason: `provider ${model.provider} does not expose ChatGPT Fast mode`,
		};
	}

	if (model.api !== OPENAI_CODEX_RESPONSES_API) {
		return {
			eligible: false,
			modelKey,
			reason: `API ${model.api} does not expose ChatGPT Fast mode`,
		};
	}

	if (!SUPPORTED_MODEL_IDS.has(model.id)) {
		return {
			eligible: false,
			modelKey,
			reason: `${model.id} does not advertise the Fast service tier`,
		};
	}

	if (!usingOAuth) {
		return {
			eligible: false,
			modelKey,
			reason: "ChatGPT OAuth authentication is required",
		};
	}

	return { eligible: true, modelKey };
}

export function addFastServiceTier(
	payload: unknown,
	model: FastModeModel | undefined,
	usingOAuth: boolean,
	enabled: boolean,
): UnknownRecord | undefined {
	if (!enabled || !getFastModeEligibility(model, usingOAuth).eligible || !isRecord(payload)) {
		return undefined;
	}

	if (payload.model !== model?.id || Object.hasOwn(payload, "service_tier")) {
		return undefined;
	}

	return {
		...payload,
		service_tier: FAST_SERVICE_TIER,
	};
}

export function restoreFastModeEnabled(
	entries: readonly unknown[],
	defaultEnabled = false,
): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) {
			continue;
		}

		if (isRecord(entry.data) && typeof entry.data.enabled === "boolean") {
			return entry.data.enabled;
		}
	}

	return defaultEnabled;
}

export function parseInheritedFastMode(value: string | undefined): boolean {
	if (value === undefined) return true;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function synchronizeChildProcessDefault(enabled: boolean): void {
	process.env[FAST_MODE_ENVIRONMENT_VARIABLE] = enabled ? "1" : "0";
}

function getEligibilityForContext(ctx: ExtensionContext): FastModeEligibility {
	const usingOAuth = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	return getFastModeEligibility(ctx.model, usingOAuth);
}

function updateStatus(ctx: ExtensionContext, enabled: boolean): void {
	if (!ctx.hasUI) return;

	if (!enabled) {
		ctx.ui.setStatus(EXTENSION_ID, undefined);
		return;
	}

	const eligibility = getEligibilityForContext(ctx);
	const status = eligibility.eligible
		? ctx.ui.theme.fg("accent", "⚡ fast")
		: ctx.ui.theme.fg("muted", "⚡ fast (armed)");
	ctx.ui.setStatus(EXTENSION_ID, status);
}

function describeStatus(ctx: ExtensionContext, enabled: boolean): string {
	const eligibility = getEligibilityForContext(ctx);

	if (!enabled) {
		return `Fast mode is off. Current agent: ${eligibility.modelKey}.`;
	}

	if (eligibility.eligible) {
		return `Fast mode is on and active for ${eligibility.modelKey}. Requests use service_tier=${FAST_SERVICE_TIER}, which consumes ChatGPT credits at the Fast-mode rate.`;
	}

	return `Fast mode is on but inactive for ${eligibility.modelKey}: ${eligibility.reason}. It remains armed and will activate automatically when you select a supported agent.`;
}

function supportedModelsMessage(): string {
	return `Supported ChatGPT agents: ${SUPPORTED_OPENAI_CODEX_MODELS.join(", ")}.`;
}

export default function fastModeExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let sessionDefaultEnabled = false;

	function restoreState(ctx: ExtensionContext): void {
		enabled = restoreFastModeEnabled(ctx.sessionManager.getBranch(), sessionDefaultEnabled);
		synchronizeChildProcessDefault(enabled);
		updateStatus(ctx, enabled);
	}

	function setEnabled(ctx: ExtensionContext, nextEnabled: boolean): void {
		if (enabled !== nextEnabled) {
			enabled = nextEnabled;
			const state: PersistedFastModeState = { version: 1, enabled };
			pi.appendEntry(STATE_ENTRY_TYPE, state);
		}
		synchronizeChildProcessDefault(enabled);
		updateStatus(ctx, enabled);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionDefaultEnabled = parseInheritedFastMode(
			process.env[FAST_MODE_ENVIRONMENT_VARIABLE],
		);
		restoreState(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(EXTENSION_ID, undefined);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx, enabled);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const usingOAuth = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
		return addFastServiceTier(event.payload, ctx.model, usingOAuth, enabled);
	});

	pi.registerCommand("fast", {
		description: "Toggle Fast mode for every supported ChatGPT agent",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const matches = COMMAND_ACTIONS.filter((action) => action.startsWith(normalizedPrefix));
			return matches.length > 0
				? matches.map((action) => ({ value: action, label: action }))
				: null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();

			switch (action) {
				case "":
					setEnabled(ctx, !enabled);
					break;
				case "on":
					setEnabled(ctx, true);
					break;
				case "off":
					setEnabled(ctx, false);
					break;
				case "status":
					updateStatus(ctx, enabled);
					break;
				case "models":
					ctx.ui.notify(supportedModelsMessage(), "info");
					return;
				default:
					ctx.ui.notify("Usage: /fast [on|off|status|models]", "warning");
					return;
			}

			ctx.ui.notify(describeStatus(ctx, enabled), "info");
		},
	});
}
