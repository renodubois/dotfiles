import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type CavemanLevel = "lite" | "full" | "ultra" | "wenyan-lite" | "wenyan-full" | "wenyan-ultra";
type CavemanMode = "off" | CavemanLevel;

const VALID_LEVELS = new Set<CavemanLevel>([
	"lite",
	"full",
	"ultra",
	"wenyan-lite",
	"wenyan-full",
	"wenyan-ultra",
]);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsPath = path.join(__dirname, "skills");

function normalizeLevel(raw: string | undefined): CavemanLevel | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return undefined;
	if (value === "wenyan") return "wenyan-full";
	return VALID_LEVELS.has(value as CavemanLevel) ? (value as CavemanLevel) : undefined;
}

function activationLevel(text: string): CavemanLevel | undefined {
	const lower = text.toLowerCase();
	if (/\b(stop caveman|normal mode|disable caveman|turn off caveman)\b/.test(lower)) return undefined;
	if (!/\b(caveman|talk like caveman|use caveman|less tokens|fewer tokens|be brief|terse mode)\b/.test(lower)) return undefined;
	return normalizeLevel(lower.match(/\b(wenyan-ultra|wenyan-full|wenyan-lite|wenyan|ultra|full|lite)\b/)?.[1]) ?? "full";
}

function stopRequested(text: string): boolean {
	return /\b(stop caveman|normal mode|disable caveman|turn off caveman)\b/i.test(text);
}

function promptForMode(mode: CavemanLevel): string {
	const base = [
		"CAVEMAN MODE ACTIVE.",
		"Respond terse like smart caveman. Keep all technical substance; remove fluff.",
		"Drop pleasantries, filler, hedging. Fragments OK. Technical terms exact. Code blocks unchanged. Error strings/paths/API names/function names exact.",
		"Pattern: [thing] [action] [reason]. [next step].",
		"Temporarily use normal clarity for security warnings, irreversible action confirmations, or multi-step instructions where compression risks confusion; then resume caveman.",
		"Code, commit messages, and PR comments use normal requested format unless user explicitly asks caveman there.",
	];

	const byMode: Record<CavemanLevel, string> = {
		lite: "Level lite: remove filler/hedging; keep articles and normal grammar; professional but tight.",
		full: "Level full: drop articles; use fragments and short synonyms; classic caveman style.",
		ultra: "Level ultra: telegraphic; use arrows for causality (X → Y), common abbreviations (DB/auth/config/req/res/fn/impl), one word when enough. Never abbreviate identifiers/errors.",
		"wenyan-lite": "Level wenyan-lite: semi-classical Chinese; concise but clear.",
		"wenyan-full": "Level wenyan-full: maximum classical terseness; 文言文 style while preserving technical meaning.",
		"wenyan-ultra": "Level wenyan-ultra: extreme compression with classical Chinese feel; preserve technical terms exactly.",
	};

	return `${base.join("\n")}\n${byMode[mode]}`;
}

export default function (pi: ExtensionAPI) {
	let mode: CavemanMode = "off";

	function setStatus(ctx: { hasUI?: boolean; ui?: { setStatus?: (key: string, text?: string) => void } }) {
		if (!ctx.hasUI || !ctx.ui?.setStatus) return;
		ctx.ui.setStatus("caveman", mode === "off" ? undefined : `🪨 caveman:${mode}`);
	}

	pi.on("resources_discover", async () => ({ skillPaths: [skillsPath] }));

	pi.on("session_start", async (_event, ctx) => {
		mode = "off";
		setStatus(ctx);
	});

	pi.registerCommand("caveman", {
		description: "Toggle terse caveman response mode. Usage: /caveman [lite|full|ultra|wenyan-lite|wenyan-full|wenyan-ultra|off]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				mode = mode === "off" ? "full" : "off";
			} else if (["off", "stop", "normal", "normal-mode"].includes(arg)) {
				mode = "off";
			} else {
				const level = normalizeLevel(arg);
				if (!level) {
					ctx.ui.notify(`Unknown caveman level: ${args}. Use lite, full, ultra, wenyan-lite, wenyan-full, wenyan-ultra, or off.`, "error");
					return;
				}
				mode = level;
			}
			setStatus(ctx);
			ctx.ui.notify(mode === "off" ? "Caveman off. Normal mode." : `Caveman ${mode} active. Oog.`, "info");
		},
	});

	pi.on("input", async (event, ctx) => {
		if (stopRequested(event.text)) {
			mode = "off";
			setStatus(ctx);
			return { action: "continue" };
		}

		const requested = activationLevel(event.text);
		if (requested) {
			mode = requested;
			setStatus(ctx);
			return { action: "continue" };
		}

		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event) => {
		if (mode === "off") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${promptForMode(mode)}` };
	});
}
