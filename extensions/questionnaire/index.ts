/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Single question: simple options list
 * Multiple questions: tab bar navigation between questions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withUiLock } from "../../lib/ui-lock.ts";
import { clampToBudget, isFullscreen, moreIndicator, viewportBudget, windowLines } from "../../lib/viewport.ts";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface.",
		// Serialize the whole tool batch: ctx.ui.custom has no mutual exclusion, so a
		// second concurrent component steals focus and hangs the first call forever.
		executionMode: "sequential",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1; // questions + Submit

			const runComponent = () => ctx.ui.custom<QuestionnaireResult>((tui, theme, _kb, done) => {
				// State
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let scroll = 0;
				let cachedLines: string[] | undefined;
				// Keyed by everything the layout depends on; pi does not invalidate caches on
				// resize, and /settings can switch TUI mode (and so the budget) while we are up.
				let cachedWidth: number | undefined;
				let cachedRows: number | undefined;
				let cachedFullscreen: boolean | undefined;
				const answers = new Map<string, Answer>();

				// Editor for "Type something" option
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

				// Helpers
				function refresh() {
					cachedLines = undefined;
					cachedWidth = undefined;
					tui.requestRender();
				}

				function submit(cancelled: boolean) {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				}

				function currentQuestion(): Question | undefined {
					return questions[currentTab];
				}

				function currentOptions(): RenderOption[] {
					const q = currentQuestion();
					if (!q) return [];
					const opts: RenderOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something.", isOther: true });
					}
					return opts;
				}

				function allAnswered(): boolean {
					return questions.every((q) => answers.has(q.id));
				}

				function advanceAfterAnswer() {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length; // Submit tab
					}
					optionIndex = 0;
					scroll = 0;
					refresh();
				}

				function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
					answers.set(questionId, { id: questionId, value, label, wasCustom, index });
				}

				// Editor submit callback
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					saveAnswer(inputQuestionId, trimmed, trimmed, true);
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				function handleInput(data: string) {
					// Input mode: route to editor
					if (inputMode) {
						if (matchesKey(data, Key.escape)) {
							inputMode = false;
							inputQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					const q = currentQuestion();
					const opts = currentOptions();

					// Tab navigation (multi-question only)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							currentTab = (currentTab + 1) % totalTabs;
							optionIndex = 0;
							scroll = 0;
							refresh();
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							currentTab = (currentTab - 1 + totalTabs) % totalTabs;
							optionIndex = 0;
							scroll = 0;
							refresh();
							return;
						}
					}

					// Submit tab. It has no cursor, so up/down scroll the summary instead.
					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						} else if (matchesKey(data, Key.up)) {
							scroll = Math.max(0, scroll - 1);
							refresh();
						} else if (matchesKey(data, Key.down)) {
							scroll += 1;
							refresh();
						}
						return;
					}

					// Option navigation
					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(opts.length - 1, optionIndex + 1);
						refresh();
						return;
					}

					// Select option
					if (matchesKey(data, Key.enter) && q) {
						const opt = opts[optionIndex];
						if (opt.isOther) {
							inputMode = true;
							inputQuestionId = q.id;
							editor.setText("");
							refresh();
							return;
						}
						saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
						advanceAfterAnswer();
						return;
					}

					// Cancel
					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				}

				function render(width: number): string[] {
					const rows = tui.terminal.rows;
					const fullscreen = isFullscreen(tui);
					if (cachedLines && cachedWidth === width && cachedRows === rows && cachedFullscreen === fullscreen) {
						return cachedLines;
					}

					const q = currentQuestion();
					const opts = currentOptions();
					const fit = (s: string) => truncateToWidth(s, width);

					// Pinned above the scrollable middle.
					const head: string[] = [fit(theme.fg("accent", "─".repeat(width)))];

					// Tab bar (multi-question only)
					if (isMulti) {
						const tabs: string[] = ["← "];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const isAnswered = answers.has(questions[i].id);
							const lbl = questions[i].label;
							const box = isAnswered ? "■" : "□";
							const color = isAnswered ? "success" : "muted";
							const text = ` ${box} ${lbl} `;
							const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
							tabs.push(`${styled} `);
						}
						const canSubmit = allAnswered();
						const isSubmitTab = currentTab === questions.length;
						const submitText = " ✓ Submit ";
						const submitStyled = isSubmitTab
							? theme.bg("selectedBg", theme.fg("text", submitText))
							: theme.fg(canSubmit ? "success" : "dim", submitText);
						tabs.push(`${submitStyled} →`);
						head.push(fit(` ${tabs.join("")}`));
						head.push("");
					}

					const middle: string[] = [];
					const foot: string[] = [];
					let cursorRow: number | null = null;
					let cursorSpan = 1;

					/**
					 * Appends the option list to `middle`; returns the selected option's first row
					 * and how many rows it occupies, so its description is never left off screen.
					 */
					function renderOptions(): { row: number; span: number } | null {
						let selectedSpan: { row: number; span: number } | null = null;
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const isOther = opt.isOther === true;
							const prefix = selected ? theme.fg("accent", "> ") : "  ";
							const color = selected ? "accent" : "text";
							const row = middle.length;
							// Mark "Type something" differently when in input mode
							if (isOther && inputMode) {
								middle.push(fit(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`)));
							} else {
								middle.push(fit(prefix + theme.fg(color, `${i + 1}. ${opt.label}`)));
							}
							if (opt.description) {
								for (const dl of wrapTextWithAnsi(opt.description, width - 5)) {
									middle.push(`     ${theme.fg("muted", dl)}`);
								}
							}
							// A label and its wrapped description scroll as one unit.
							if (selected) selectedSpan = { row, span: middle.length - row };
						}
						return selectedSpan;
					}

					// Content
					if (inputMode && q) {
						for (const line of wrapTextWithAnsi(q.prompt, width - 1)) {
							middle.push(` ${theme.fg("text", line)}`);
						}
						middle.push("");
						// Options stay as reference only, so the window need not follow them; the
						// editor is pinned below instead, where typing can never scroll out of view.
						renderOptions();
						foot.push("");
						foot.push(fit(theme.fg("muted", " Your answer:")));
						for (const line of editor.render(width - 2)) {
							foot.push(fit(` ${line}`));
						}
						foot.push("");
						foot.push(fit(theme.fg("dim", " Enter to submit • Esc to cancel")));
					} else if (currentTab === questions.length) {
						middle.push(fit(theme.fg("accent", theme.bold(" Ready to submit"))));
						middle.push("");
						for (const question of questions) {
							const answer = answers.get(question.id);
							if (answer) {
								const prefix = answer.wasCustom ? "(wrote) " : "";
								middle.push(fit(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`));
							}
						}
						middle.push("");
						if (allAnswered()) {
							middle.push(fit(theme.fg("success", " Press Enter to submit")));
						} else {
							const missing = questions
								.filter((q) => !answers.has(q.id))
								.map((q) => q.label)
								.join(", ");
							middle.push(fit(theme.fg("warning", ` Unanswered: ${missing}`)));
						}
					} else if (q) {
						for (const line of wrapTextWithAnsi(q.prompt, width - 1)) {
							middle.push(` ${theme.fg("text", line)}`);
						}
						middle.push("");
						const selected = renderOptions();
						cursorRow = selected?.row ?? null;
						cursorSpan = selected?.span ?? 1;
					}

					foot.push("");
					if (!inputMode) {
						const help = isMulti
							? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
							: " ↑↓ navigate • Enter select • Esc cancel";
						foot.push(fit(theme.fg("dim", help)));
					}
					foot.push(fit(theme.fg("accent", "─".repeat(width))));

					const budget = viewportBudget(tui);
					const windowed = windowLines(middle, Math.max(0, budget - head.length - foot.length), {
						cursor: cursorRow,
						cursorSpan,
						scroll,
						indicator: moreIndicator(theme),
					});
					scroll = windowed.scroll;

					cachedLines = clampToBudget([...head, ...windowed.lines, ...foot], budget);
					cachedWidth = width;
					cachedRows = rows;
					cachedFullscreen = fullscreen;
					return cachedLines;
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
						cachedWidth = undefined;
					},
					handleInput,
				};
			});

			// Exclusive while on screen; see lib/ui-lock.ts.
			const result = await withUiLock("Questionnaire", runComponent);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
