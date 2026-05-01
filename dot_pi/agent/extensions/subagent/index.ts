/**
 * Global personal subagent extension.
 *
 * Registers a model-callable `subagent` tool that launches isolated headless Pi
 * subprocesses in single, parallel, or chain mode.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 8;
const MAX_TASKS_PER_INVOCATION = 24;
const COLLAPSED_OUTPUT_CHARS = 700;
const STDERR_TAIL_CHARS = 4000;

const STANDARD_WRAPPER_PROMPT = `You are running as a sub-agent launched by a parent Pi instance.

Work independently with fresh context. Your output will be consumed by the parent agent.

Do not ask the user questions. If the task is ambiguous, make reasonable assumptions when safe. If blocked, return a \`## Blocked\` section explaining what is missing.

Do not spawn sub-agents unless explicitly authorized.

Do not commit, stash, reset, checkout branches, rebase, or push unless the parent task explicitly asks you to.

Return concise structured Markdown. Include exact file paths and line references when relevant. Do not include long raw file or command dumps; summarize and cite sources.

Use this general output contract unless your agent profile specifies a more specific one:

## Summary
## Findings or Work Performed
## Blocked
## Handoff`;

function parseEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}…`;
}

function tail(text: string, maxChars = STDERR_TAIL_CHARS): string {
	if (text.length <= maxChars) return text;
	return text.slice(text.length - maxChars);
}

function looksLikeAuthFailure(text: string): boolean {
	return /(auth|login|oauth|api key|apikey|unauthori[sz]ed|forbidden|401|403|credentials?)/i.test(text);
}

function safeFileName(input: string): string {
	return input.replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "agent";
}

function localDateStamp(date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function createRunId(): string {
	return `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };

	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(tmpDir, `system-${safeFileName(agentName)}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function buildSystemPrompt(agent: AgentConfig, instructions?: string): string {
	const parts = [agent.systemPrompt.trim(), STANDARD_WRAPPER_PROMPT.trim()].filter(Boolean);
	if (instructions?.trim()) parts.push(`Additional instructions for this task:\n${instructions.trim()}`);
	return parts.join("\n\n---\n\n");
}

function getParentModelString(ctxModel: any): string | undefined {
	if (!ctxModel) return undefined;
	if (ctxModel.provider && ctxModel.id) return `${ctxModel.provider}/${ctxModel.id}`;
	if (ctxModel.id) return ctxModel.id;
	return undefined;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function getResultFinalOutput(result: { finalOutput?: string; messages?: Message[] }): string {
	return result.finalOutput ?? getFinalOutput(result.messages ?? []);
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "text") items.push({ type: "text", text: part.text });
			else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
		}
	}
	return items;
}

function formatToolCall(toolName: string, args: Record<string, unknown>): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	switch (toolName) {
		case "bash":
			return `$ ${truncate(String(args.command ?? "..."), 80)}`;
		case "read": {
			const rawPath = String(args.file_path || args.path || "...");
			return `read ${shortenPath(rawPath)}`;
		}
		case "write": {
			const rawPath = String(args.file_path || args.path || "...");
			return `write ${shortenPath(rawPath)}`;
		}
		case "edit": {
			const rawPath = String(args.file_path || args.path || "...");
			return `edit ${shortenPath(rawPath)}`;
		}
		case "ls":
			return `ls ${shortenPath(String(args.path || "."))}`;
		case "find":
			return `find ${String(args.pattern || "*")} in ${shortenPath(String(args.path || "."))}`;
		case "grep":
			return `grep /${String(args.pattern || "")}/ in ${shortenPath(String(args.path || "."))}`;
		default:
			return `${toolName} ${truncate(JSON.stringify(args), 80)}`;
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface LogPaths {
	jsonl: string;
	stderr: string;
	final: string;
}

interface TaskSpec {
	agent: string;
	task: string;
	instructions?: string;
	model?: string;
	cwd?: string;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	instructions?: string;
	cwd: string;
	status: "queued" | "running" | "success" | "failed";
	success: boolean;
	exitCode: number | null;
	messages: Message[];
	finalOutput?: string;
	displayItems?: DisplayItem[];
	stderr: string;
	stderrTail?: string;
	usage: UsageStats;
	model?: string;
	profileModel?: string;
	effectiveModel?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	logPaths: LogPaths;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	runId: string;
	runDir: string;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	concurrencyUsed?: number;
	successCount: number;
	failureCount: number;
	usage: UsageStats;
	results: SingleResult[];
}

interface ManifestTask {
	index: number;
	agent: string;
	task: string;
	instructions?: string;
	cwd: string;
	requestedModel?: string;
	profileModel?: string;
	effectiveModel?: string;
	agentSource?: string;
	logPaths: LogPaths;
	status: string;
	success?: boolean;
	exitCode?: number | null;
	stopReason?: string;
	errorMessage?: string;
}

interface Manifest {
	runId: string;
	startedAt: string;
	endedAt?: string;
	parentCwd: string;
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	concurrencyUsed?: number;
	status: "running" | "success" | "failed";
	successCount: number;
	failureCount: number;
	tasks: ManifestTask[];
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function aggregateUsage(results: SingleResult[]): UsageStats {
	const usage = emptyUsage();
	for (const r of results) {
		usage.input += r.usage.input;
		usage.output += r.usage.output;
		usage.cacheRead += r.usage.cacheRead;
		usage.cacheWrite += r.usage.cacheWrite;
		usage.cost += r.usage.cost;
		usage.contextTokens = Math.max(usage.contextTokens, r.usage.contextTokens);
		usage.turns += r.usage.turns;
	}
	return usage;
}

function isResultFailure(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted" || Boolean(result.errorMessage);
}

function finalizeResultStatus(result: SingleResult): void {
	const failed = isResultFailure(result);
	result.status = failed ? "failed" : "success";
	result.success = !failed;
	result.finalOutput = getFinalOutput(result.messages);
	result.displayItems = getDisplayItems(result.messages).map((item) =>
		item.type === "text" ? { type: "text", text: truncate(item.text, 2000) } : item,
	);
	result.stderrTail = result.stderr ? tail(result.stderr) : undefined;
}

function compactResultForDetails(result: SingleResult): SingleResult {
	return {
		...result,
		finalOutput: getResultFinalOutput(result),
		displayItems: result.displayItems ?? getDisplayItems(result.messages),
		messages: [],
		stderr: result.status === "failed" ? result.stderr : "",
	};
}

async function createRunDirectory(): Promise<{ runId: string; runDir: string }> {
	const runId = createRunId();
	const runDir = path.join(getAgentDir(), "subagent-runs", localDateStamp(), runId);
	await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 });
	return { runId, runDir };
}

function makeLogPaths(runDir: string, index: number, agentName: string): LogPaths {
	const prefix = `agent-${String(index + 1).padStart(2, "0")}-${safeFileName(agentName)}`;
	return {
		jsonl: path.join(runDir, `${prefix}.jsonl`),
		stderr: path.join(runDir, `${prefix}.stderr.log`),
		final: path.join(runDir, `${prefix}.final.md`),
	};
}

async function writeManifest(runDir: string, manifest: Manifest): Promise<void> {
	await fs.promises.writeFile(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
}

function updateManifestFromResults(manifest: Manifest, results: SingleResult[]): void {
	const byIndex = new Map<number, SingleResult>();
	for (let i = 0; i < results.length; i++) byIndex.set(i, results[i]);
	manifest.tasks = manifest.tasks.map((task, i) => {
		const result = byIndex.get(i);
		if (!result) return task;
		return {
			...task,
			cwd: result.cwd,
			profileModel: result.profileModel,
			effectiveModel: result.effectiveModel,
			agentSource: result.agentSource,
			status: result.status,
			success: result.success,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
		};
	});
	manifest.successCount = results.filter((r) => r.success).length;
	manifest.failureCount = results.filter((r) => r.status === "failed").length;
	manifest.status = manifest.failureCount > 0 ? "failed" : manifest.tasks.every((t) => t.status === "success") ? "success" : "running";
}

function createDetails(
	mode: "single" | "parallel" | "chain",
	runId: string,
	runDir: string,
	agentScope: AgentScope,
	projectAgentsDir: string | null,
	results: SingleResult[],
	concurrencyUsed?: number,
): SubagentDetails {
	return {
		mode,
		runId,
		runDir,
		agentScope,
		projectAgentsDir,
		concurrencyUsed,
		successCount: results.filter((r) => r.success).length,
		failureCount: results.filter((r) => r.status === "failed").length,
		usage: aggregateUsage(results),
		results: results.map(compactResultForDetails),
	};
}

function buildResultText(details: SubagentDetails): string {
	const lines: string[] = [];
	lines.push(`Subagent ${details.mode} complete. Run directory: ${details.runDir}`);
	lines.push(`Succeeded: ${details.successCount}; failed: ${details.failureCount}`);
	if (details.concurrencyUsed) lines.push(`Concurrency: ${details.concurrencyUsed}`);
	const usage = formatUsageStats(details.usage);
	if (usage) lines.push(`Usage: ${usage}`);
	lines.push("");

	for (const r of details.results) {
		const label = r.step ? `Step ${r.step}: ${r.agent}` : r.agent;
		lines.push(`## ${r.success ? "✓" : "✗"} ${label} (${r.agentSource})`);
		lines.push(`cwd: ${r.cwd}`);
		lines.push(`logs: ${r.logPaths.final}`);
		if (!r.success) {
			if (r.stopReason) lines.push(`stopReason: ${r.stopReason}`);
			if (r.errorMessage) lines.push(`error: ${r.errorMessage}`);
			if (r.stderrTail) lines.push(`stderr tail:\n\`\`\`\n${r.stderrTail}\n\`\`\``);
			if (looksLikeAuthFailure(`${r.errorMessage ?? ""}\n${r.stderrTail ?? ""}`)) {
				lines.push("Hint: Pi authentication may be expired. Run `pi` interactively and use `/login`, then retry.");
			}
		}
		const output = getResultFinalOutput(r).trim();
		lines.push(output || "(no final assistant output)");
		lines.push("");
	}
	return lines.join("\n").trim();
}

async function runSingleAgent(options: {
	defaultCwd: string;
	agents: AgentConfig[];
	taskSpec: TaskSpec;
	index: number;
	step?: number;
	runDir: string;
	parentModel?: string;
	signal?: AbortSignal;
	onUpdate?: OnUpdateCallback;
	makeDetails: (results: SingleResult[]) => SubagentDetails;
}): Promise<SingleResult> {
	const { defaultCwd, agents, taskSpec, index, step, runDir, parentModel, signal, onUpdate, makeDetails } = options;
	const logPaths = makeLogPaths(runDir, index, taskSpec.agent);
	const effectiveCwd = taskSpec.cwd ?? defaultCwd;
	const agent = agents.find((a) => a.name === taskSpec.agent);
	const baseResult: SingleResult = {
		agent: taskSpec.agent,
		agentSource: agent?.source ?? "unknown",
		task: taskSpec.task,
		instructions: taskSpec.instructions,
		cwd: effectiveCwd,
		status: "running",
		success: false,
		exitCode: null,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		profileModel: agent?.model,
		effectiveModel: taskSpec.model ?? agent?.model ?? parentModel,
		model: taskSpec.model ?? agent?.model ?? parentModel,
		step,
		logPaths,
	};

	const emitUpdate = () => {
		onUpdate?.({
			content: [{ type: "text", text: getResultFinalOutput(baseResult) || `${baseResult.agent} running...` }],
			details: makeDetails([baseResult]),
		});
	};

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		baseResult.exitCode = 1;
		baseResult.errorMessage = `Unknown agent: "${taskSpec.agent}". Available agents: ${available}.`;
		baseResult.stderr = baseResult.errorMessage;
		finalizeResultStatus(baseResult);
		await fs.promises.writeFile(logPaths.stderr, `${baseResult.errorMessage}\n`, "utf-8");
		await fs.promises.writeFile(logPaths.final, "", "utf-8");
		emitUpdate();
		return baseResult;
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (baseResult.effectiveModel) args.push("--model", baseResult.effectiveModel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		const systemPrompt = buildSystemPrompt(agent, taskSpec.instructions);
		if (systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task:\n${taskSpec.task}`);

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: effectiveCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT_DEPTH: String(parseEnvInt("PI_SUBAGENT_DEPTH", 0) + 1),
					PI_SUBAGENT_MAX_DEPTH: process.env.PI_SUBAGENT_MAX_DEPTH ?? "1",
				},
			});

			let buffer = "";
			let killTimer: NodeJS.Timeout | null = null;
			let closed = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				try {
					fs.appendFileSync(logPaths.jsonl, `${line}\n`, "utf-8");
				} catch {
					/* ignore logging errors */
				}

				let event: any;
				try {
					event = JSON.parse(line);
				} catch (error) {
					const msg = `[json-parse-error] ${(error as Error).message}: ${line.slice(0, 500)}\n`;
					baseResult.stderr += msg;
					try {
						fs.appendFileSync(logPaths.stderr, msg, "utf-8");
					} catch {
						/* ignore logging errors */
					}
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					baseResult.messages.push(msg);
					if (msg.role === "assistant") {
						baseResult.usage.turns++;
						const usage = (msg as any).usage;
						if (usage) {
							baseResult.usage.input += usage.input || 0;
							baseResult.usage.output += usage.output || 0;
							baseResult.usage.cacheRead += usage.cacheRead || 0;
							baseResult.usage.cacheWrite += usage.cacheWrite || 0;
							const cost = typeof usage.cost === "number" ? usage.cost : usage.cost?.total;
							baseResult.usage.cost += cost || 0;
							baseResult.usage.contextTokens = usage.totalTokens || usage.contextTokens || baseResult.usage.contextTokens;
						}
						if ((msg as any).model) baseResult.model = (msg as any).model;
						if ((msg as any).stopReason) baseResult.stopReason = (msg as any).stopReason;
						if ((msg as any).errorMessage) baseResult.errorMessage = (msg as any).errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					baseResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				const text = data.toString();
				baseResult.stderr += text;
				try {
					fs.appendFileSync(logPaths.stderr, text, "utf-8");
				} catch {
					/* ignore logging errors */
				}
			});

			proc.on("close", (code) => {
				closed = true;
				if (killTimer) clearTimeout(killTimer);
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", (error) => {
				baseResult.errorMessage = error.message;
				baseResult.stderr += `${error.message}\n`;
				try {
					fs.appendFileSync(logPaths.stderr, `${error.message}\n`, "utf-8");
				} catch {
					/* ignore logging errors */
				}
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					baseResult.stopReason = "aborted";
					baseResult.errorMessage = "Subagent was aborted by parent.";
					proc.kill("SIGTERM");
					killTimer = setTimeout(() => {
						if (!closed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		baseResult.exitCode = exitCode;
		if (wasAborted) {
			baseResult.stopReason = "aborted";
			baseResult.errorMessage = baseResult.errorMessage || "Subagent was aborted by parent.";
		}
		finalizeResultStatus(baseResult);
		await fs.promises.writeFile(logPaths.final, getResultFinalOutput(baseResult), "utf-8");
		return baseResult;
	} catch (error) {
		baseResult.exitCode = baseResult.exitCode ?? 1;
		baseResult.errorMessage = (error as Error).message;
		baseResult.stderr += `${(error as Error).stack ?? (error as Error).message}\n`;
		try {
			await fs.promises.appendFile(logPaths.stderr, `${(error as Error).stack ?? (error as Error).message}\n`, "utf-8");
		} catch {
			/* ignore logging errors */
		}
		finalizeResultStatus(baseResult);
		try {
			await fs.promises.writeFile(logPaths.final, getResultFinalOutput(baseResult), "utf-8");
		} catch {
			/* ignore logging errors */
		}
		return baseResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
		}
	}
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	onStart: (item: TIn, index: number) => void,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			onStart(items[current], current);
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	instructions: Type.Optional(Type.String({ description: "Additional role/lens instructions appended to the sub-agent system prompt" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this task, e.g. provider/model or fuzzy model id" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	instructions: Type.Optional(Type.String({ description: "Additional role/lens instructions appended to the sub-agent system prompt" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this task, e.g. provider/model or fuzzy model id" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	instructions: Type.Optional(Type.String({ description: "Additional role/lens instructions appended to the sub-agent system prompt (single mode)" })),
	model: Type.Optional(Type.String({ description: "Optional model override for this task (single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task, instructions?, model?, cwd?} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task, instructions?, model?, cwd?} for sequential execution" })),
	concurrency: Type.Optional(Type.Number({ description: `Parallel concurrency. Default ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}.`, default: DEFAULT_CONCURRENCY })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	const currentDepth = parseEnvInt("PI_SUBAGENT_DEPTH", 0);
	const maxDepth = parseEnvInt("PI_SUBAGENT_MAX_DEPTH", 1);
	if (currentDepth >= maxDepth) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate work to isolated headless Pi sub-agents with fresh context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (from ~/.pi/agent/agents). Project agents require explicit agentScope.',
		].join(" "),
		promptSnippet:
			"Delegate independent work to isolated headless Pi sub-agents with fresh context; supports single, parallel, and chain modes.",
		promptGuidelines: [
			"Use subagent when the user asks to use a sub-agent, subagent, sub agent, child agent, or agent delegation.",
			"Use subagent when the user asks to launch work in parallel or delegate independent investigations/reviews concurrently.",
			"Use subagent when skill/workflow instructions mention Claude-style Task, Explore, or general-purpose agents; translate them to Pi agents such as explore, scout, reviewer, planner, worker, or general-purpose.",
			"Use subagent parallel mode for independent investigations and reviews; failures are collected instead of aborting the whole batch.",
			"Use subagent chain mode only when later steps require earlier outputs; use {previous} in later tasks to pass prior output.",
			"Prefer read-only subagent profiles (scout, explore, planner, reviewer, general-purpose) unless edits are explicitly desired; use worker for write-capable implementation work.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const parentModel = getParentModelString(ctx.model);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const mode: "single" | "parallel" | "chain" = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			const { runId, runDir } = await createRunDirectory();

			const requestedTasks: TaskSpec[] = hasChain
				? params.chain
				: hasTasks
					? params.tasks
					: hasSingle
						? [{ agent: params.agent, task: params.task, instructions: params.instructions, model: params.model, cwd: params.cwd }]
						: [];
			const concurrencyUsed = hasTasks
				? Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(params.concurrency ?? DEFAULT_CONCURRENCY)))
				: undefined;

			const manifest: Manifest = {
				runId,
				startedAt: new Date().toISOString(),
				parentCwd: ctx.cwd,
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				concurrencyUsed,
				status: "running",
				successCount: 0,
				failureCount: 0,
				tasks: requestedTasks.map((task, index) => {
					const agent = agents.find((a) => a.name === task.agent);
					return {
						index: index + 1,
						agent: task.agent,
						task: task.task,
						instructions: task.instructions,
						cwd: task.cwd ?? ctx.cwd,
						requestedModel: task.model,
						profileModel: agent?.model,
						effectiveModel: task.model ?? agent?.model ?? parentModel,
						agentSource: agent?.source,
						logPaths: makeLogPaths(runDir, index, task.agent),
						status: "queued",
					};
				}),
			};
			await writeManifest(runDir, manifest);

			const makeDetails = (results: SingleResult[]) =>
				createDetails(mode, runId, runDir, agentScope, discovery.projectAgentsDir, results, concurrencyUsed);

			if (modeCount !== 1) {
				manifest.status = "failed";
				manifest.failureCount = 1;
				manifest.endedAt = new Date().toISOString();
				await writeManifest(runDir, manifest);
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}\nRun directory: ${runDir}` }],
					details: makeDetails([]),
					isError: true,
				};
			}

			if (requestedTasks.length > MAX_TASKS_PER_INVOCATION) {
				manifest.status = "failed";
				manifest.failureCount = requestedTasks.length;
				manifest.endedAt = new Date().toISOString();
				await writeManifest(runDir, manifest);
				return {
					content: [{ type: "text", text: `Too many subagent tasks (${requestedTasks.length}). Max is ${MAX_TASKS_PER_INVOCATION}.\nRun directory: ${runDir}` }],
					details: makeDetails([]),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const projectAgentsRequested = Array.from(new Set(requestedTasks.map((t) => t.agent)))
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled prompts and a security boundary. Only continue for trusted repositories.`,
					);
					if (!ok) {
						manifest.status = "failed";
						manifest.endedAt = new Date().toISOString();
						await writeManifest(runDir, manifest);
						return {
							content: [{ type: "text", text: `Canceled: project-local agents not approved.\nRun directory: ${runDir}` }],
							details: makeDetails([]),
							isError: true,
						};
					}
				}
			}

			if (hasChain) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i] as TaskSpec;
					const taskSpec = { ...step, task: step.task.replace(/\{previous\}/g, previousOutput) };
					manifest.tasks[i].status = "running";
					await writeManifest(runDir, manifest);

					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									onUpdate({ content: partial.content, details: makeDetails([...results, currentResult]) });
								}
							}
						: undefined;

					const result = await runSingleAgent({
						defaultCwd: ctx.cwd,
						agents,
						taskSpec,
						index: i,
						step: i + 1,
						runDir,
						parentModel,
						signal,
						onUpdate: chainUpdate,
						makeDetails,
					});
					results.push(result);
					updateManifestFromResults(manifest, results);
					await writeManifest(runDir, manifest);

					if (!result.success) {
						manifest.status = "failed";
						manifest.endedAt = new Date().toISOString();
						await writeManifest(runDir, manifest);
						const details = makeDetails(results);
						return { content: [{ type: "text", text: buildResultText(details) }], details, isError: true };
					}
					previousOutput = getResultFinalOutput(result);
				}

				manifest.status = "success";
				manifest.endedAt = new Date().toISOString();
				await writeManifest(runDir, manifest);
				const details = makeDetails(results);
				return { content: [{ type: "text", text: buildResultText(details) }], details };
			}

			if (hasTasks) {
				const allResults: SingleResult[] = params.tasks.map((task: TaskSpec, index: number) => ({
					agent: task.agent,
					agentSource: "unknown",
					task: task.task,
					instructions: task.instructions,
					cwd: task.cwd ?? ctx.cwd,
					status: "queued",
					success: false,
					exitCode: null,
					messages: [],
					stderr: "",
					usage: emptyUsage(),
					model: task.model ?? parentModel,
					effectiveModel: task.model ?? parentModel,
					logPaths: makeLogPaths(runDir, index, task.agent),
				}));

				const emitParallelUpdate = () => {
					const running = allResults.filter((r) => r.status === "running").length;
					const queued = allResults.filter((r) => r.status === "queued").length;
					const done = allResults.filter((r) => r.status === "success" || r.status === "failed").length;
					onUpdate?.({
						content: [{ type: "text", text: `${running} running, ${queued} queued, ${done} done` }],
						details: makeDetails([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(
					params.tasks,
					concurrencyUsed ?? DEFAULT_CONCURRENCY,
					(_task, index) => {
						allResults[index].status = "running";
						manifest.tasks[index].status = "running";
						void writeManifest(runDir, manifest).catch(() => undefined);
						emitParallelUpdate();
					},
					async (task: TaskSpec, index: number) => {
						const result = await runSingleAgent({
							defaultCwd: ctx.cwd,
							agents,
							taskSpec: task,
							index,
							runDir,
							parentModel,
							signal,
							onUpdate: (partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails,
						});
						allResults[index] = result;
						updateManifestFromResults(manifest, allResults);
						await writeManifest(runDir, manifest);
						emitParallelUpdate();
						return result;
					},
				);

				updateManifestFromResults(manifest, results);
				manifest.endedAt = new Date().toISOString();
				await writeManifest(runDir, manifest);
				const details = makeDetails(results);
				return { content: [{ type: "text", text: buildResultText(details) }], details, isError: details.failureCount > 0 };
			}

			const result = await runSingleAgent({
				defaultCwd: ctx.cwd,
				agents,
				taskSpec: requestedTasks[0],
				index: 0,
				runDir,
				parentModel,
				signal,
				onUpdate,
				makeDetails,
			});
			updateManifestFromResults(manifest, [result]);
			manifest.endedAt = new Date().toISOString();
			await writeManifest(runDir, manifest);
			const details = makeDetails([result]);
			return { content: [{ type: "text", text: buildResultText(details) }], details, isError: !result.success };
		},

		renderCall(args: any, theme) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain?.length) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
				for (const [i, step] of args.chain.slice(0, 3).entries()) text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)} ${theme.fg("dim", truncate(step.task.replace(/\{previous\}/g, "").trim(), 60))}`;
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks?.length) {
				let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
				if (args.concurrency) text += theme.fg("muted", ` c=${args.concurrency}`);
				for (const task of args.tasks.slice(0, 3)) text += `\n  ${theme.fg("accent", task.agent)} ${theme.fg("dim", truncate(task.task, 60))}`;
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			return new Text(
				theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", args.agent || "...") + theme.fg("muted", ` [${scope}]`) + `\n  ${theme.fg("dim", truncate(args.task || "...", 80))}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const isRunning = details.results.some((r) => r.status === "running" || r.status === "queued");
			const icon = isRunning ? theme.fg("warning", "⏳") : details.failureCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
			const header = `${icon} ${theme.fg("toolTitle", theme.bold(`subagent ${details.mode}`))} ${theme.fg("accent", `${details.successCount}/${details.results.length} succeeded`)} ${theme.fg("muted", details.runDir)}`;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(header, 0, 0));
				const usageStr = formatUsageStats(details.usage);
				if (usageStr) container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
				for (const r of details.results) {
					const rIcon = r.status === "queued" ? theme.fg("muted", "…") : r.status === "running" ? theme.fg("warning", "⏳") : r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon} ${theme.fg("muted", r.cwd)}`, 0, 0));
					container.addChild(new Text(theme.fg("dim", `logs: ${r.logPaths.final}`), 0, 0));
					for (const item of r.displayItems ?? getDisplayItems(r.messages)) if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", `→ ${formatToolCall(item.name, item.args)}`), 0, 0));
					const output = getResultFinalOutput(r);
					if (output) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					} else {
						container.addChild(new Text(theme.fg("muted", r.status === "running" ? "(running...)" : "(no output)"), 0, 0));
					}
					const taskUsage = formatUsageStats(r.usage, r.model);
					if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
				}
				return container;
			}

			let text = header;
			if (details.concurrencyUsed) text += theme.fg("dim", ` c=${details.concurrencyUsed}`);
			for (const r of details.results) {
				const rIcon = r.status === "queued" ? theme.fg("muted", "…") : r.status === "running" ? theme.fg("warning", "⏳") : r.success ? theme.fg("success", "✓") : theme.fg("error", "✗");
				const output = getResultFinalOutput(r);
				text += `\n\n${theme.fg("accent", r.agent)} ${rIcon}\n${theme.fg("dim", truncate(output || (r.status === "running" ? "(running...)" : r.errorMessage || "(no output)"), COLLAPSED_OUTPUT_CHARS))}`;
			}
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}
