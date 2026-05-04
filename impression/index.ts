/**
 * Impression System — pi extension that distills long tool results into
 * compact notes, storing the originals for on-demand recall.
 *
 * See README.md for full documentation.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { loadConfig, resolveConfig, saveLocalConfig, shouldSkipDistillation } from "./src/config.js";
import { distillWithSameModel } from "./src/distill.js";
import { formatOriginalCall } from "./src/format-call.js";
import { getImpressionSystemAppendTemplate } from "./src/prompt-loader.js";
import { buildImpressionText, createPassthroughToolResult, createRecallToolResult, notifyImpressionSkip } from "./src/result-builders.js";
import { serializeContent } from "./src/serialize.js";
import { CONFIG_FILE_NAME, PASSTHROUGH_MODE_ENTRY_TYPE, SESSION_STATS_ENTRY_TYPE, getEntryData, getPassthroughModeData, getSessionStatsData, isImpressionEntry, isPassthroughModeEntry, isSessionStatsEntry } from "./src/types.js";
import type { ImpressionConfig, ImpressionDetails, ImpressionEntry, ResolvedConfig } from "./src/types.js";

const RecallImpressionParams = Type.Object({
	id: Type.String({ description: "Impression ID" }),
});

function serializeVisibleHistory(messages: ReturnType<typeof buildSessionContext>["messages"]): string {
	return messages.map((m) => JSON.stringify(m)).join("\n");
}

const SkipImpressionParams = Type.Object({
	count: Type.Optional(Type.Number({ description: "Number of tool results to pass through unchanged (default 1). Capped by config. Set to 0 to cancel passthrough." })),
	justification: Type.Optional(Type.String({ description: "Why you need exact content including whitespace, indentation, and naming. Required when count > 0." })),
	estimatedChars: Type.Optional(Type.Number({ description: "Estimated characters to read. Hard limit enforced at runtime. Required when count > 0." })),
});

function formatCompactChars(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
	if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
	return value.toFixed(2);
}

function formatImpressionData(impressionChars: number, originalChars: number): string {
	const ratio = originalChars > 0 ? (impressionChars / originalChars) * 100 : 0;
	return `[impression:data] ${formatCompactChars(impressionChars)} / ${formatCompactChars(originalChars)} = ${ratio.toFixed(2)}%`;
}

const STATUS_KEY = "impression-data";
const DOCKER_UPDATE = "docker:update";
const DOCKER_REMOVE = "docker:remove";
const DOCKER_AVAILABLE_FLAG = "$__docker_available__";
const DOCKER_SECTION_TITLE = "Impression";
const DOCKER_SECTION_ORDER = 30;

interface DockerSection {
	id: string;
	title: string;
	order: number;
	lines: string[];
}

interface DockerRemove {
	id: string;
}

function hasDocker(): boolean {
	return (globalThis as Record<string, unknown>)[DOCKER_AVAILABLE_FLAG] === true;
}

function publishDataStatus(pi: ExtensionAPI, ctx: ExtensionContext, text: string | undefined): void {
	if (hasDocker()) {
		if (text) {
			const section: DockerSection = {
				id: STATUS_KEY,
				title: DOCKER_SECTION_TITLE,
				order: DOCKER_SECTION_ORDER,
				lines: text.split("\n"),
			};
			pi.events.emit(DOCKER_UPDATE, section);
		} else {
			const removal: DockerRemove = { id: STATUS_KEY };
			pi.events.emit(DOCKER_REMOVE, removal);
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, text);
}

function parseToolNameList(input: string): string[] {
	const names: string[] = [];
	let i = 0;
	while (i < input.length) {
		while (i < input.length && (input[i] === " " || input[i] === ",")) i++;
		if (i >= input.length) break;
		const ch = input[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			const close = input.indexOf(ch, i + 1);
			if (close === -1) {
				names.push(input.slice(i + 1).trim());
				break;
			}
			const name = input.slice(i + 1, close).trim();
			if (name) names.push(name);
			i = close + 1;
		} else {
			let end = i;
			while (end < input.length && input[end] !== ",") end++;
			const name = input.slice(i, end).trim();
			if (name) names.push(name);
			i = end + 1;
		}
	}
	return names;
}

export default function (pi: ExtensionAPI) {
	const impressions = new Map<string, ImpressionEntry>();
	let cfg: ResolvedConfig = resolveConfig(loadConfig());
	let cumulativeOriginalChars = 0;
	let cumulativeImpressionChars = 0;
	let passthroughRemaining = 0;
	let lastEstimatedChars = 0;

	function persistPassthroughRemaining() {
		pi.appendEntry(PASSTHROUGH_MODE_ENTRY_TYPE, { remaining: passthroughRemaining, lastEstimatedChars });
	}

	function persistSessionStats() {
		pi.appendEntry(SESSION_STATS_ENTRY_TYPE, {
			originalChars: cumulativeOriginalChars,
			impressionChars: cumulativeImpressionChars,
		});
	}

	function recordImpressionData(originalChars: number, impressionChars: number) {
		cumulativeOriginalChars += originalChars;
		cumulativeImpressionChars += impressionChars;
		persistSessionStats();
	}

	function computeMaxTokens(originalLength: number): number {
		const base = Math.max(Math.ceil(cfg.minLength / 2), 1024);
		const rateBased = Math.floor(originalLength * cfg.distillRateFloor);
		return Math.max(base, rateBased);
	}

	function updateShowDataStatus(ctx: ExtensionContext) {
		const text = cfg.showData ? formatImpressionData(cumulativeImpressionChars, cumulativeOriginalChars) : undefined;
		publishDataStatus(pi, ctx, text);
	}

	function updateRecallShowData(
		ctx: ExtensionContext,
		impression: ImpressionEntry,
		mode: "passthrough" | "distill",
		noteChars: number,
	) {
		const ori = impression.originalChars ?? 0;
		const shownImpressionChars = mode === "passthrough" ? ori : noteChars;
		recordImpressionData(ori, shownImpressionChars);
		if (cfg.showData) {
			ctx.ui.notify(formatImpressionData(shownImpressionChars, ori), "info");
		}
		updateShowDataStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		cfg = resolveConfig(loadConfig());
		if (cfg.debugDistillMode && !cfg.debug) {
			ctx.ui.notify('[impression] Ignoring "debug:distill-mode" because "debug" is not enabled.', "warning");
			cfg.debugDistillMode = undefined;
		}
		cumulativeOriginalChars = 0;
		cumulativeImpressionChars = 0;
		passthroughRemaining = 0;
		impressions.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			const ptData = getPassthroughModeData(entry);
			if (isPassthroughModeEntry(ptData)) {
				passthroughRemaining = ptData.remaining;
				lastEstimatedChars = ptData.lastEstimatedChars ?? 0;
				continue;
			}
			const statsData = getSessionStatsData(entry);
			if (isSessionStatsEntry(statsData)) {
				cumulativeOriginalChars = statsData.originalChars;
				cumulativeImpressionChars = statsData.impressionChars;
				continue;
			}
			const data = getEntryData(entry);
			if (!isImpressionEntry(data)) continue;
			impressions.set(data.id, data);
		}
		updateShowDataStatus(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${getImpressionSystemAppendTemplate()}`,
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === "recall_impression" || event.toolName === "skip_impression") return;
		if (!cfg.enabled) return;
		if (passthroughRemaining > 0) {
			const fullText = serializeContent(event.content);
			const maxChars = Math.max(cfg.minLength * 10, 10240);
			const overEstimate = lastEstimatedChars > 0 && fullText.length > lastEstimatedChars * 1.5;
			const overMax = fullText.length > maxChars;
			if (overEstimate || overMax) {
				passthroughRemaining--;
				persistPassthroughRemaining();
				const reason = overMax
					? `actual content ${fullText.length} chars exceeds hard limit of ${maxChars}`
					: `actual content ${fullText.length} chars exceeds 1.5x estimated ${lastEstimatedChars}`;
				ctx.ui.notify(`[impression] Passthrough rejected: ${reason}.`, "warning");
				const id = randomUUID();
				const impression: ImpressionEntry = {
					id,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					toolInput: event.input,
					fullContent: event.content,
					fullText,
					originalChars: fullText.length,
					recallCount: 0,
					createdAt: Date.now(),
				};
				impressions.set(id, impression);
				pi.appendEntry("impression-v1", impression);
				return {
					content: [{ type: "text", text: `Passthrough stored but content too large (${reason}). Impression ID: ${id}. Options: (1) skip_impression again with a smaller range, (2) skip_impression count=0 to cancel and let distillation handle it, (3) save_impression to a file and use read/bash to inspect.` }],
				};
			} else {
				passthroughRemaining--;
				persistPassthroughRemaining();
				const chars = fullText.length;
				recordImpressionData(chars, chars);
				if (cfg.showData) {
					ctx.ui.notify(formatImpressionData(chars, chars), "info");
				}
				updateShowDataStatus(ctx);
				ctx.ui.notify(`[impression] Passthrough mode (${passthroughRemaining} remaining)`, "info");
				return;
			}
		}
		if (shouldSkipDistillation(event.toolName, cfg)) {
			ctx.ui.notify(`[impression] Skipped distillation for "${event.toolName}" (configured in ${CONFIG_FILE_NAME})`, "info");
			return;
		}
		if (event.isError) {
			notifyImpressionSkip(ctx, "tool result is an error");
			return;
		}

		const fullText = serializeContent(event.content);
		if (fullText.length < cfg.minLength) {
			ctx.ui.notify(`[impression] Skipped: content length ${fullText.length} is below threshold of ${cfg.minLength}`, "info");
			return;
		}

		const model = ctx.model;
		if (!model) {
			notifyImpressionSkip(ctx, "no active model selected");
			return { content: event.content };
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			notifyImpressionSkip(ctx, `missing auth for ${model.provider}/${model.id}: ${auth.error}`);
			return { content: event.content };
		}
		const visibleHistory = serializeVisibleHistory(buildSessionContext(ctx.sessionManager.getEntries()).messages);
		const originalSystemPrompt = ctx.getSystemPrompt();
		ctx.ui.setStatus("impression-distill", `[impression] Distilling ${fullText.length} chars with ${model.provider}/${model.id}...`);
		let distillation: { passthrough: boolean; note: string; thinking?: string };
		try {
			distillation = await distillWithSameModel(
				model,
				cfg.debugDistillMode,
				{ apiKey: auth.apiKey, headers: auth.headers },
				event.toolName,
				event.content,
				visibleHistory,
				originalSystemPrompt,
				computeMaxTokens(fullText.length),
				ctx.signal,
				cfg.debug ? (version) => ctx.ui.notify(`[impression:debug] Using prompt version: ${version}`, "info") : undefined,
			);
		} finally {
			ctx.ui.setStatus("impression-distill", undefined);
		}

		const ptLevel = cfg.debug ? "warning" : "info";
		if (distillation.passthrough) {
			if (cfg.debug && distillation.thinking) {
				ctx.ui.notify(`[impression] Passthrough thinking: ${distillation.thinking}`, "warning");
			}
			recordImpressionData(fullText.length, fullText.length);
			if (cfg.showData) {
				ctx.ui.notify(formatImpressionData(fullText.length, fullText.length), "info");
			}
			updateShowDataStatus(ctx);
			ctx.ui.notify(`[impression] Passthrough for ${event.toolName}`, ptLevel);
			return { content: event.content };
		}

		if (cfg.debug && distillation.thinking) {
			ctx.ui.notify(`[impression] Thinking detected (${distillation.thinking.length} chars): ${distillation.thinking.slice(0, 300)}`, "warning");
		}

		const impressionChars = distillation.note.length;
		recordImpressionData(fullText.length, impressionChars);
		if (cfg.showData) {
			ctx.ui.notify(formatImpressionData(impressionChars, fullText.length), "info");
		}
		updateShowDataStatus(ctx);

		const id = randomUUID();
		const originalChars = fullText.length;
		const impression: ImpressionEntry = {
			id,
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			toolInput: event.input,
			fullContent: event.content,
			fullText,
			originalChars,
			recallCount: 0,
			createdAt: Date.now(),
		};
		impressions.set(id, impression);
		pi.appendEntry("impression-v1", impression);

		return {
			content: [{ type: "text", text: buildImpressionText(id, distillation.note) }],
			details: { thinking: distillation.thinking } satisfies ImpressionDetails,
		};
	});

	pi.registerTool({
		name: "recall_impression",
		label: "Recall Impression",
		description:
			"Recall a stored impression by ID. Returns distilled notes with updated context.",
		parameters: RecallImpressionParams,
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const entry = impressions.get(args.id);
			const title = theme.fg("toolTitle", theme.bold("Recall Impression"));
			const idDisplay = theme.fg("muted", args.id);
			const line1 = `${title} ${idDisplay}`;
			if (entry) {
				const originalCall = formatOriginalCall(entry, theme);
				text.setText(`${line1}\n${theme.fg("muted", "> ")}${originalCall}`);
			} else {
				text.setText(line1);
			}
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const contentText = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const details = result.details as ImpressionDetails | undefined;
			if (details?.thinking) {
				const thinkingLabel = theme.fg("muted", "[thinking] ");
				const thinkingText = theme.fg("muted", details.thinking.replaceAll("\n", " ").slice(0, 200));
				text.setText(`${contentText}\n${thinkingLabel}${thinkingText}`);
			} else {
				text.setText(contentText);
			}
			return text;
		},
		async execute(_toolCallId, args, signal, _onUpdate, ctx) {
			const impression = impressions.get(args.id);
			if (!impression) {
				throw new Error(`Impression not found: ${args.id}`);
			}

			if (passthroughRemaining > 0) {
				const maxChars = Math.max(cfg.minLength * 10, 10240);
				const contentChars = impression.fullText.length;
				const overEstimate = lastEstimatedChars > 0 && contentChars > lastEstimatedChars * 1.5;
				const overMax = contentChars > maxChars;
				if (overEstimate || overMax) {
					passthroughRemaining--;
					persistPassthroughRemaining();
					const reason = overMax
						? `content ${contentChars} chars exceeds hard limit of ${maxChars}`
						: `content ${contentChars} chars exceeds 1.5x estimated ${lastEstimatedChars}`;
					ctx.ui.notify(`[impression] Recall passthrough rejected: ${reason}.`, "warning");
					return {
						content: [{ type: "text", text: `Recall passthrough rejected: content too large (${reason}). Options: (1) skip_impression count=0 to cancel and recall for distilled notes, (2) save_impression to a file and use read/bash to inspect.` }],
						details: undefined,
					};
				} else {
					passthroughRemaining--;
					persistPassthroughRemaining();
					ctx.ui.notify(`[impression] Passthrough mode (${passthroughRemaining} remaining)`, "info");
					updateRecallShowData(ctx, impression, "passthrough", 0);
					return createPassthroughToolResult(impression.fullContent);
				}
			}

			if (impression.recallCount >= cfg.maxRecall) {
				updateRecallShowData(ctx, impression, "passthrough", 0);
				return createPassthroughToolResult(impression.fullContent);
			}

			const model = ctx.model;
			if (!model) {
				notifyImpressionSkip(ctx, "no active model selected");
				updateRecallShowData(ctx, impression, "passthrough", 0);
				return createPassthroughToolResult(impression.fullContent);
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				notifyImpressionSkip(ctx, `missing auth for ${model.provider}/${model.id}: ${auth.error}`);
				impression.recallCount = cfg.maxRecall;
				pi.appendEntry("impression-v1", impression);
				updateRecallShowData(ctx, impression, "passthrough", 0);
				return createPassthroughToolResult(impression.fullContent);
			}
			const visibleHistory = serializeVisibleHistory(buildSessionContext(ctx.sessionManager.getEntries()).messages);
			const originalSystemPrompt = ctx.getSystemPrompt();
			ctx.ui.setStatus("impression-distill", `[impression] Re-distilling ${impression.fullText.length} chars with ${model.provider}/${model.id}...`);
			let distillation: { passthrough: boolean; note: string; thinking?: string };
			try {
				distillation = await distillWithSameModel(
					model,
					cfg.debugDistillMode,
					{ apiKey: auth.apiKey, headers: auth.headers },
					impression.toolName,
					impression.fullContent,
					visibleHistory,
					originalSystemPrompt,
					computeMaxTokens(impression.fullText.length),
					signal,
					cfg.debug ? (version) => ctx.ui.notify(`[impression:debug] Using prompt version: ${version}`, "info") : undefined,
				);
			} finally {
				ctx.ui.setStatus("impression-distill", undefined);
			}

			const ptLevel = cfg.debug ? "warning" : "info";
			if (distillation.passthrough) {
				if (distillation.thinking) {
					ctx.ui.notify(`[impression] Recall passthrough thinking: ${distillation.thinking}`, ptLevel);
				}
				impression.recallCount = cfg.maxRecall;
				pi.appendEntry("impression-v1", impression);
				updateRecallShowData(ctx, impression, "passthrough", distillation.note.length);
				return createPassthroughToolResult(impression.fullContent);
			}

			impression.recallCount += 1;
			if (impression.recallCount >= cfg.maxRecall) {
				pi.appendEntry("impression-v1", impression);
				updateRecallShowData(ctx, impression, "passthrough", distillation.note.length);
				return createPassthroughToolResult(impression.fullContent);
			}

			pi.appendEntry("impression-v1", impression);
			updateRecallShowData(ctx, impression, "distill", distillation.note.length);
			return createRecallToolResult(impression.id, distillation.note, { thinking: distillation.thinking });
		},
	});

	pi.registerTool({
		name: "skip_impression",
		label: "Skip Impression",
		description:
			"Skip distillation for the next N tool results (max " + cfg.maxPassthroughCount + "). Each call overwrites previous skip state. count=0 cancels passthrough. When count > 0: requires `justification` and `estimatedChars` (hard limit: " + Math.max(cfg.minLength * 10, 10240) + "). Actual content exceeding limit or 1.5x estimate is rejected.",
		promptSnippet: "skip_impression: Skip distillation for next N results (max " + cfg.maxPassthroughCount + "). Each call overwrites previous state. count=0 cancels. When count > 0: { count, justification, estimatedChars } all required. justification: why exact whitespace matters. estimatedChars hard limit: " + Math.max(cfg.minLength * 10, 10240) + ". Actual content over limit or 1.5x estimate is rejected and stored — use save_impression to inspect. NEVER to \"understand\" or \"analyze\" code.",
		parameters: SkipImpressionParams,
		renderCall(args, theme) {
			const title = theme.fg("toolTitle", theme.bold("Skip Impression"));
			const count = args.count ?? 1;
			if (count === 0) return new Text(`${title} ${theme.fg("warning", "cancel")}`, 0, 0);
			const justification = args.justification
				? theme.fg("muted", ` "${args.justification.length > 80 ? args.justification.slice(0, 77) + "..." : args.justification}"`)
				: "";
			const estimate = args.estimatedChars != null ? theme.fg("accent", ` ~${args.estimatedChars} chars`) : "";
			return new Text(`${title} count=${count}${estimate}${justification}`, 0, 0);
		},
		async execute(_toolCallId, args, _signal, _onUpdate, _ctx) {
			const requested = args.count ?? 1;
			if (requested === 0) {
				passthroughRemaining = 0;
				lastEstimatedChars = 0;
				persistPassthroughRemaining();
				return {
					content: [{ type: "text", text: "Passthrough cancelled." }],
					details: undefined,
				};
			}
			if (!args.justification) {
				return {
					content: [{ type: "text", text: "Rejected: justification is required when count > 0." }],
					details: undefined,
				};
			}
			if (args.estimatedChars == null) {
				return {
					content: [{ type: "text", text: "Rejected: estimatedChars is required when count > 0." }],
					details: undefined,
				};
			}
			const maxChars = Math.max(cfg.minLength * 10, 10240);
			if (args.estimatedChars > maxChars) {
				return {
					content: [{ type: "text", text: `Rejected: estimatedChars ${args.estimatedChars} exceeds hard limit of ${maxChars}. Options: (1) skip_impression again with a smaller range and estimatedChars, (2) do not skip and rely on distilled notes.` }],
					details: undefined,
				};
			}
			passthroughRemaining = Math.min(requested, cfg.maxPassthroughCount);
			lastEstimatedChars = args.estimatedChars;
			persistPassthroughRemaining();
			return {
				content: [{ type: "text", text: `Skipping distillation for next ${passthroughRemaining} tool result(s).` }],
				details: undefined,
			};
		},
	});

	const SaveImpressionParams = Type.Object({
		id: Type.String({ description: "Impression ID to save." }),
		path: Type.String({ description: "File path to write the original content to." }),
	});

	pi.registerTool({
		name: "save_impression",
		label: "Save Impression",
		description: "Save the original content of an impression to a file for inspection with read/bash/python. Useful for long non-file content (e.g., command output) or file content that may have changed or been deleted since.",
		parameters: SaveImpressionParams,
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const impression = impressions.get(args.id);
			if (!impression) {
				throw new Error(`Impression not found: ${args.id}`);
			}
			if (impression.toolName === "read" && impression.toolInput) {
				const originalPath = (impression.toolInput.file_path ?? impression.toolInput.path) as string | undefined;
				if (originalPath && existsSync(originalPath)) {
					try {
						const currentContent = readFileSync(originalPath, "utf-8");
						if (currentContent === impression.fullText || impression.fullText.startsWith(currentContent) || currentContent.includes(impression.fullText)) {
							ctx.ui.notify(`[impression] Warning: file ${originalPath} still exists and appears unmodified. Consider reading it directly instead.`, "warning");
						}
					} catch {
						// file unreadable, proceed with save
					}
				}
			}
			writeFileSync(args.path, impression.fullText, "utf-8");
			return {
				content: [{ type: "text", text: `Saved ${impression.fullText.length} chars to ${args.path}. Use read/bash to inspect.` }],
				details: undefined,
			};
		},
	});

	pi.registerCommand("impression", {
		description: "Control impression distillation: on | off | tool1,tool2,... (add tools to skipDistillation)",
		async handler(args, ctx) {
			const trimmed = args.trim();
			if (!trimmed) {
				const status = cfg.enabled ? "on" : "off";
				const skip = cfg.skipDistillation.length > 0 ? `\nSkip list: ${cfg.skipDistillation.join(", ")}` : "";
				ctx.ui.notify(`[impression] Status: ${status}${skip}`, "info");
				return;
			}
			if (trimmed === "on") {
				cfg.enabled = true;
				saveLocalConfig({ enabled: true });
				ctx.ui.notify("[impression] Enabled.", "info");
				return;
			}
			if (trimmed === "off") {
				cfg.enabled = false;
				saveLocalConfig({ enabled: false });
				ctx.ui.notify("[impression] Disabled — all tool results pass through without distillation.", "info");
				return;
			}
			const names = parseToolNameList(trimmed);
			if (names.length === 0) {
				ctx.ui.notify(`[impression] Could not parse tool names from: ${trimmed}`, "error");
				return;
			}
			const existing = new Set(cfg.skipDistillation);
			for (const name of names) existing.add(name);
			const merged = [...existing];
			cfg.skipDistillation = merged;
			saveLocalConfig({ skipDistillation: merged });
			ctx.ui.notify(`[impression] Skip list updated: ${merged.join(", ")}`, "info");
		},
	});
}
