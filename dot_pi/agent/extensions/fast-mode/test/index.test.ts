import assert from "node:assert/strict";
import test from "node:test";
import fastModeExtension, {
	addFastServiceTier,
	getFastModeEligibility,
	parseInheritedFastMode,
	restoreFastModeEnabled,
	SUPPORTED_OPENAI_CODEX_MODELS,
	type FastModeModel,
} from "../index.ts";

const SUPPORTED_MODEL: FastModeModel = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	id: "gpt-5.6-sol",
};

test("every advertised model is eligible with ChatGPT OAuth", () => {
	for (const id of SUPPORTED_OPENAI_CODEX_MODELS) {
		assert.equal(
			getFastModeEligibility({ ...SUPPORTED_MODEL, id }, true).eligible,
			true,
			id,
		);
	}
});

test("eligibility rejects unsupported providers, APIs, models, and auth", () => {
	assert.equal(getFastModeEligibility({ ...SUPPORTED_MODEL, provider: "openai" }, true).eligible, false);
	assert.equal(getFastModeEligibility({ ...SUPPORTED_MODEL, api: "openai-responses" }, true).eligible, false);
	assert.equal(getFastModeEligibility({ ...SUPPORTED_MODEL, id: "gpt-5.4-mini" }, true).eligible, false);
	assert.equal(getFastModeEligibility(SUPPORTED_MODEL, false).eligible, false);
	assert.equal(getFastModeEligibility(undefined, false).eligible, false);
});

test("fast tier is added without mutating the original payload", () => {
	const payload = { model: SUPPORTED_MODEL.id, input: "hello" };
	const result = addFastServiceTier(payload, SUPPORTED_MODEL, true, true);

	assert.deepEqual(result, { ...payload, service_tier: "priority" });
	assert.deepEqual(payload, { model: SUPPORTED_MODEL.id, input: "hello" });
});

test("payload is left alone when mode or request is ineligible", () => {
	assert.equal(addFastServiceTier({ model: SUPPORTED_MODEL.id }, SUPPORTED_MODEL, true, false), undefined);
	assert.equal(addFastServiceTier({ model: "gpt-5.6-terra" }, SUPPORTED_MODEL, true, true), undefined);
	assert.equal(addFastServiceTier({ model: SUPPORTED_MODEL.id }, SUPPORTED_MODEL, false, true), undefined);
	assert.equal(
		addFastServiceTier({ model: SUPPORTED_MODEL.id }, { ...SUPPORTED_MODEL, id: "gpt-5.4-mini" }, true, true),
		undefined,
	);
});

test("an existing service tier always wins", () => {
	assert.equal(
		addFastServiceTier(
			{ model: SUPPORTED_MODEL.id, service_tier: "default" },
			SUPPORTED_MODEL,
			true,
			true,
		),
		undefined,
	);
});

test("state restoration uses the latest state on the active branch", () => {
	const entries = [
		{ type: "custom", customType: "fast-mode-state", data: { version: 1, enabled: true } },
		{ type: "message" },
		{ type: "custom", customType: "fast-mode-state", data: { version: 1, enabled: false } },
	];

	assert.equal(restoreFastModeEnabled(entries), false);
	assert.equal(restoreFastModeEnabled(entries.slice(0, 2)), true);
	assert.equal(restoreFastModeEnabled([]), false);
	assert.equal(restoreFastModeEnabled([], true), true);
});

test("fast mode defaults on and accepts explicit truthy inherited values", () => {
	for (const value of [undefined, "1", "true", "TRUE", "yes", "on"]) {
		assert.equal(parseInheritedFastMode(value), true, String(value));
	}
	for (const value of ["", "0", "false", "off"]) {
		assert.equal(parseInheritedFastMode(value), false, value);
	}
});

test("command state persists and drives provider payloads", async () => {
	const previousEnvironmentValue = process.env.PI_FAST_MODE_ENABLED;
	process.env.PI_FAST_MODE_ENABLED = "0";
	const handlers = new Map<string, (event: unknown, ctx: MockContext) => unknown>();
	let fastCommand: { handler: (args: string, ctx: MockContext) => Promise<void> } | undefined;
	const branch: unknown[] = [];
	const statuses: Array<string | undefined> = [];
	const notifications: string[] = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: MockContext) => unknown) {
			handlers.set(event, handler);
		},
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
		registerCommand(name: string, command: typeof fastCommand) {
			if (name === "fast") fastCommand = command;
		},
	};

	const ctx: MockContext = {
		hasUI: true,
		model: SUPPORTED_MODEL,
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: { getBranch: () => branch },
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_id: string, status: string | undefined) => statuses.push(status),
			theme: { fg: (_color: string, text: string) => text },
		},
	};

	fastModeExtension(pi as never);
	handlers.get("session_start")?.({}, ctx);
	assert.ok(fastCommand);
	await fastCommand.handler("on", ctx);

	const rewritten = handlers.get("before_provider_request")?.(
		{ payload: { model: SUPPORTED_MODEL.id, input: "hello" } },
		ctx,
	);
	assert.deepEqual(rewritten, {
		model: SUPPORTED_MODEL.id,
		input: "hello",
		service_tier: "priority",
	});
	assert.equal(restoreFastModeEnabled(branch), true);
	assert.equal(process.env.PI_FAST_MODE_ENABLED, "1");
	assert.ok(statuses.includes("⚡ fast"));
	assert.match(notifications.at(-1) ?? "", /active/);

	if (previousEnvironmentValue === undefined) {
		delete process.env.PI_FAST_MODE_ENABLED;
	} else {
		process.env.PI_FAST_MODE_ENABLED = previousEnvironmentValue;
	}
});

interface MockContext {
	hasUI: boolean;
	model: FastModeModel;
	modelRegistry: { isUsingOAuth: (model: FastModeModel) => boolean };
	sessionManager: { getBranch: () => readonly unknown[] };
	ui: {
		notify: (message: string, level?: string) => void;
		setStatus: (id: string, status: string | undefined) => void;
		theme: { fg: (color: string, text: string) => string };
	};
}
