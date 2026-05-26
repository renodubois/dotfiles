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
					let questionScrollOffset = 0;
					let questionLineCount = 0;
					let questionViewportHeight = 0;
					let cachedLines: string[] | undefined;
					let cachedWidth: number | undefined;
					let cachedRows: number | undefined;

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

					function clearCache() {
						cachedLines = undefined;
						cachedWidth = undefined;
						cachedRows = undefined;
					}

					function refresh() {
						clearCache();
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

					function scrollQuestionTo(offset: number): boolean {
						const viewportHeight = questionViewportHeight || Math.max(1, Math.floor(tui.terminal.rows / 2));
						const maxOffset = Math.max(0, questionLineCount - viewportHeight);
						const nextOffset = Math.max(0, Math.min(maxOffset, offset));
						if (nextOffset === questionScrollOffset) return false;
						questionScrollOffset = nextOffset;
						refresh();
						return true;
					}

					function scrollQuestionBy(delta: number): boolean {
						return scrollQuestionTo(questionScrollOffset + delta);
					}

					function handleQuestionScrollInput(data: string): boolean {
						const pageSize =
							questionViewportHeight > 0 ? Math.max(1, questionViewportHeight - 1) : Math.max(1, Math.floor(tui.terminal.rows / 2));
						const halfPageSize = Math.max(1, Math.floor(pageSize / 2));
						const questionCanScroll = questionViewportHeight > 0 && questionLineCount > questionViewportHeight;

						if (matchesKey(data, Key.ctrl("u"))) {
							if (!questionCanScroll) return false;
							scrollQuestionBy(-halfPageSize);
							return true;
						}

						if (matchesKey(data, Key.ctrl("d"))) {
							if (!questionCanScroll) return false;
							scrollQuestionBy(halfPageSize);
							return true;
						}

						if (matchesKey(data, Key.pageUp)) {
							if (!questionCanScroll) return false;
							scrollQuestionBy(-pageSize);
							return true;
						}

						if (matchesKey(data, Key.pageDown)) {
							if (!questionCanScroll) return false;
							scrollQuestionBy(pageSize);
							return true;
						}

						return false;
					}

					function handleInput(data: string) {
						if (handleQuestionScrollInput(data)) return;

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

						if (matchesKey(data, Key.home)) {
							scrollQuestionTo(0);
							return;
						}

						if (matchesKey(data, Key.end)) {
							scrollQuestionTo(Number.MAX_SAFE_INTEGER);
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

					function scrollIndicator(text: string, width: number): string {
						const label = `─── ${text} `;
						return theme.fg("accent", truncateToWidth(label + "─".repeat(Math.max(0, width)), width, ""));
					}

					function render(width: number): string[] {
						const rows = tui.terminal.rows;
						if (cachedLines && cachedWidth === width && cachedRows === rows) return cachedLines;

						// Leave room for pi's footer so the prompt itself does not push into terminal scrollback.
						const maxComponentLines = Math.max(1, rows - 3);
						const add = (target: string[], s: string) => target.push(truncateToWidth(s, width));
						const border = theme.fg("accent", "─".repeat(Math.max(0, width)));

						const headerLines: string[] = [];
						add(headerLines, border);
						add(headerLines, theme.fg("accent", theme.bold(" Q+A")));

						const questionLines: string[] = [];
						addWrapped(questionLines, theme.fg("text", ` ${params.question}`), width);
						questionLineCount = questionLines.length;

						const answerLines: string[] = [""];
						for (let i = 0; i < displayOptions.length; i++) {
							const option = displayOptions[i];
							const selected = i === selectedIndex;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${option.label}${option.isCustom && editMode ? " ✎" : ""}`;
							add(answerLines, prefix + theme.fg(selected ? "accent" : "text", label));

							if (option.description) {
								add(answerLines, `     ${theme.fg("muted", option.description)}`);
							}
						}

						if (editMode) {
							answerLines.push("");
							add(answerLines, theme.fg("muted", " Your answer:"));
							for (const line of editor.render(Math.max(1, width - 2))) {
								add(answerLines, ` ${line}`);
							}
							if (validationMessage) {
								add(answerLines, theme.fg("warning", ` ${validationMessage}`));
							}
						}

						const footerLineCount = 3;
						const questionAreaHeight = Math.max(
							0,
							Math.min(questionLines.length, maxComponentLines - headerLines.length - answerLines.length - footerLineCount),
						);
						const questionNeedsScroll = questionLines.length > questionAreaHeight;
						const questionIndicatorLineCount = questionNeedsScroll && questionAreaHeight > 1 ? 1 : 0;
						questionViewportHeight = Math.max(0, questionAreaHeight - questionIndicatorLineCount);
						const maxQuestionScrollOffset = Math.max(0, questionLines.length - questionViewportHeight);
						questionScrollOffset = Math.max(0, Math.min(maxQuestionScrollOffset, questionScrollOffset));

						const visibleQuestionLines = questionLines.slice(questionScrollOffset, questionScrollOffset + questionViewportHeight);
						const hiddenAbove = questionScrollOffset;
						const hiddenBelow = Math.max(0, questionLines.length - (questionScrollOffset + questionViewportHeight));
						if (questionIndicatorLineCount > 0) {
							const indicator =
								hiddenAbove > 0 && hiddenBelow > 0
									? scrollIndicator(`↑ ${hiddenAbove} more • ↓ ${hiddenBelow} more • Ctrl+U/D or PgUp/PgDn`, width)
									: hiddenAbove > 0
										? scrollIndicator(`↑ ${hiddenAbove} more • Ctrl+U or PgUp`, width)
										: scrollIndicator(`↓ ${hiddenBelow} more • Ctrl+D or PgDn`, width);
							if (hiddenAbove > 0) {
								visibleQuestionLines.unshift(indicator);
							} else {
								visibleQuestionLines.push(indicator);
							}
						}

						const footerLines: string[] = [""];
						const scrollHelp = maxQuestionScrollOffset > 0 ? " • Ctrl+U/D or PgUp/PgDn scroll question" : "";
						if (editMode) {
							const help = params.options.length === 0 ? " Enter submit • Esc cancel" : " Enter submit • Esc back to options";
							add(footerLines, theme.fg("dim", `${help}${scrollHelp}`));
						} else {
							add(footerLines, theme.fg("dim", ` ↑↓ navigate • 1-9 quick select • Enter select • Esc cancel${scrollHelp}`));
						}
						add(footerLines, border);

						let lines = [...headerLines, ...visibleQuestionLines, ...answerLines, ...footerLines];
						if (lines.length > maxComponentLines) {
							lines = lines.slice(lines.length - maxComponentLines);
						}

						cachedLines = lines;
						cachedWidth = width;
						cachedRows = rows;
						return lines;
					}

					return {
						render,
						invalidate: clearCache,
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
