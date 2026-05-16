/**
 * Global Q+A UI extension.
 *
 * Adds an `ask_user` tool the model can call when it needs a clarification.
 * The UI shows model-provided answer options plus a free-form custom-answer editor.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface AskUserOption {
	label: string;
	description?: string;
}

type DisplayOption = AskUserOption & { isCustom?: boolean };

interface AskUserDetails {
	question: string;
	options: string[];
	answer: string | null;
	cancelled: boolean;
	wasCustom?: boolean;
	selectedIndex?: number;
}

const AskUserOptionSchema = Type.Object({
	label: Type.String({ description: "A concise answer option shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional extra context shown below the option" })),
});

const AskUserParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(AskUserOptionSchema, {
		description: "Likely answers the user can select. Prefer 2-6 concise options when possible.",
	}),
	allowCustom: Type.Optional(Type.Boolean({ description: "Whether the user can write their own answer. Defaults to true." })),
	customLabel: Type.Optional(Type.String({ description: "Label for the free-form answer option. Defaults to 'Write my own answer'." })),
});

function buildDetails(
	params: { question: string; options: AskUserOption[] },
	answer: string | null,
	cancelled: boolean,
	extra: Partial<AskUserDetails> = {},
): AskUserDetails {
	return {
		question: params.question,
		options: params.options.map((option) => option.label),
		answer,
		cancelled,
		...extra,
	};
}

function fallbackText(result: { content: Array<{ type: string; text?: string }> }): string {
	const firstText = result.content.find((part) => part.type === "text");
	return firstText?.text ?? "";
}

export default function qnaUi(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Q+A",
		description:
			"Ask the user a clarifying question in an interactive Q+A UI. The user can choose from provided options or write a custom answer.",
		promptSnippet: "Ask the user a question with selectable answer options and an optional custom-answer field.",
		promptGuidelines: [
			"Use ask_user instead of asking a clarifying question in plain text when user input is needed to continue.",
			"When using ask_user, provide 2-6 concise likely answers in options whenever possible, and leave allowCustom enabled unless the answer must be one of the listed options.",
			"Use ask_user for one focused question at a time; combine independent choices only when a single question is clearer than multiple prompts.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const allowCustom = params.allowCustom !== false;
			const customLabel = params.customLabel?.trim() || "Write my own answer";

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: Q+A UI is not available in this mode. Ask the user in plain text instead." }],
					details: buildDetails(params, null, true),
				};
			}

			if (params.options.length === 0 && !allowCustom) {
				return {
					content: [{ type: "text", text: "Error: No answer options were provided and custom answers are disabled." }],
					details: buildDetails(params, null, true),
				};
			}

			const displayOptions: DisplayOption[] = [...params.options];
			if (allowCustom) {
				displayOptions.push({ label: customLabel, isCustom: true });
			}

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; selectedIndex?: number } | null>(
				(tui, theme, _keybindings, done) => {
					let selectedIndex = 0;
					let editMode = params.options.length === 0 && allowCustom;
					let validationMessage: string | undefined;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							done({ answer: trimmed, wasCustom: true });
							return;
						}
						validationMessage = "Write an answer before submitting.";
						refresh();
					};

					function selectCurrentOption() {
						const selected = displayOptions[selectedIndex];
						if (!selected) return;

						if (selected.isCustom) {
							editMode = true;
							validationMessage = undefined;
							refresh();
							return;
						}

						done({ answer: selected.label, wasCustom: false, selectedIndex: selectedIndex + 1 });
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
								if (params.options.length === 0) {
									done(null);
									return;
								}
								editMode = false;
								validationMessage = undefined;
								editor.setText("");
								refresh();
								return;
							}

							validationMessage = undefined;
							editor.handleInput(data);
							refresh();
							return;
						}

						if (matchesKey(data, Key.up)) {
							selectedIndex = Math.max(0, selectedIndex - 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.down)) {
							selectedIndex = Math.min(displayOptions.length - 1, selectedIndex + 1);
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter)) {
							selectCurrentOption();
							return;
						}

						if (/^[1-9]$/.test(data)) {
							const numericIndex = Number.parseInt(data, 10) - 1;
							if (numericIndex >= 0 && numericIndex < displayOptions.length) {
								selectedIndex = numericIndex;
								selectCurrentOption();
							}
							return;
						}

						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
						}
					}

					function addWrapped(lines: string[], text: string, width: number) {
						for (const line of wrapTextWithAnsi(text, Math.max(1, width))) {
							lines.push(truncateToWidth(line, width));
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const add = (s: string) => lines.push(truncateToWidth(s, width));
						const border = theme.fg("accent", "─".repeat(Math.max(0, width)));

						add(border);
						add(theme.fg("accent", theme.bold(" Q+A")));
						addWrapped(lines, theme.fg("text", ` ${params.question}`), width);
						lines.push("");

						for (let i = 0; i < displayOptions.length; i++) {
							const option = displayOptions[i];
							const selected = i === selectedIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${option.label}${option.isCustom && editMode ? " ✎" : ""}`;
							add(prefix + theme.fg(selected ? "accent" : "text", label));

							if (option.description) {
								add(`     ${theme.fg("muted", option.description)}`);
							}
						}

						if (editMode) {
							lines.push("");
							add(theme.fg("muted", " Your answer:"));
							for (const line of editor.render(Math.max(1, width - 2))) {
								add(` ${line}`);
							}
							if (validationMessage) {
								add(theme.fg("warning", ` ${validationMessage}`));
							}
						}

						lines.push("");
						if (editMode) {
							const help = params.options.length === 0 ? " Enter submit • Esc cancel" : " Enter submit • Esc back to options";
							add(theme.fg("dim", help));
						} else {
							add(theme.fg("dim", " ↑↓ navigate • 1-9 quick select • Enter select • Esc cancel"));
						}
						add(border);

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled the Q+A prompt." }],
					details: buildDetails(params, null, true),
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `User wrote: ${result.answer}` }],
					details: buildDetails(params, result.answer, false, { wasCustom: true }),
				};
			}

			return {
				content: [{ type: "text", text: `User selected: ${result.selectedIndex}. ${result.answer}` }],
				details: buildDetails(params, result.answer, false, { wasCustom: false, selectedIndex: result.selectedIndex }),
			};
		},

		renderCall(args, theme, _context) {
			const options = Array.isArray(args.options) ? (args.options as AskUserOption[]) : [];
			const allowCustom = args.allowCustom !== false;
			const customLabel = typeof args.customLabel === "string" && args.customLabel.trim() ? args.customLabel.trim() : "Write my own answer";
			let text = theme.fg("toolTitle", theme.bold("Q+A ")) + theme.fg("muted", String(args.question ?? ""));

			const labels = options.map((option) => option.label);
			if (allowCustom) labels.push(customLabel);
			if (labels.length > 0) {
				text += `\n${theme.fg("dim", `  Options: ${labels.map((label, index) => `${index + 1}. ${label}`).join(", ")}`)}`;
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserDetails | undefined;
			if (!details) return new Text(fallbackText(result), 0, 0);

			if (details.cancelled || details.answer === null) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			if (details.wasCustom) {
				return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer), 0, 0);
			}

			const display = details.selectedIndex ? `${details.selectedIndex}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});
}
