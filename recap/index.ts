/**
 * Recap plugin — periodic + event-driven conversation recap.
 *
 * Displays a brief status summary above the editor input,
 * auto-dismisses after configurable seconds, then sends as info toast.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadRecapConfig } from "./config.js";
import { collectMessages } from "./collect.js";
import { generateRecap } from "./summarize.js";

const WIDGET_KEY = "recap";
const INSTANCE_KEY = "__recap_plugin_active__";

type IntervalTimer = ReturnType<typeof setInterval>;
type TimeoutTimer = ReturnType<typeof setTimeout>;

interface StoredState {
	intervalTimer?: IntervalTimer;
	dismissTimer?: TimeoutTimer;
	abortController?: AbortController;
}

interface RecapSnapshot {
	ctx: ExtensionContext;
	text: string;
	messageCount: number;
	systemPrompt: string | undefined;
	seq: number;
	signal: AbortSignal;
}

export default async function recap(pi: ExtensionAPI): Promise<void> {
	const g = globalThis as Record<string, unknown>;
	const prev = g[INSTANCE_KEY] as StoredState | undefined;
	if (prev?.intervalTimer) clearInterval(prev.intervalTimer);
	if (prev?.dismissTimer) clearTimeout(prev.dismissTimer);
	prev?.abortController?.abort();

	const config = await loadRecapConfig(process.cwd());
	if (!config.enabled) {
		g[INSTANCE_KEY] = undefined;
		return;
	}

	let latestCtx: ExtensionContext | null = null;
	let lastRecapMessageCount = 0;
	let dismissTimer: TimeoutTimer | null = null;
	let intervalTimer: IntervalTimer | null = null;
	let activeAbortController: AbortController | null = null;
	let latestRequestedSeq = 0;

	const instanceState: StoredState = {
		get intervalTimer() {
			return intervalTimer ?? undefined;
		},
		get dismissTimer() {
			return dismissTimer ?? undefined;
		},
		get abortController() {
			return activeAbortController ?? undefined;
		},
	};
	g[INSTANCE_KEY] = instanceState;

	function captureCtx(ctx: ExtensionContext): void {
		latestCtx = ctx;
	}

	function showRecap(ctx: ExtensionContext, summary: string): void {
		ctx.ui.setWidget(WIDGET_KEY, [`📋 ${summary}`], {
			placement: "aboveEditor",
		});
		if (dismissTimer) clearTimeout(dismissTimer);
		if (config.displaySeconds > 0) {
			dismissTimer = setTimeout(() => {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				ctx.ui.notify(`recap: ${summary}`, "info");
				dismissTimer = null;
			}, config.displaySeconds * 1000);
		}
	}

	function scheduleRecap(
		ctx: ExtensionContext,
		options: { notifyGenerating?: boolean; force?: boolean } = {},
	): void {
		const collected = collectMessages(ctx.sessionManager);
		if (collected.messageCount === 0) {
			if (options.notifyGenerating) ctx.ui.notify("[recap] No messages to recap.", "info");
			return;
		}
		if (!options.force && collected.messageCount === lastRecapMessageCount) return;

		activeAbortController?.abort();
		const abortController = new AbortController();
		activeAbortController = abortController;

		if (options.notifyGenerating) ctx.ui.notify("[recap] Generating...", "info");

		const snapshot: RecapSnapshot = {
			ctx,
			text: collected.text,
			messageCount: collected.messageCount,
			systemPrompt: ctx.getSystemPrompt(),
			seq: ++latestRequestedSeq,
			signal: abortController.signal,
		};
		void runRecap(snapshot, abortController);
	}

	async function runRecap(
		snapshot: RecapSnapshot,
		abortController: AbortController,
	): Promise<void> {
		const summary = await generateRecap(
			snapshot.text,
			snapshot.systemPrompt,
			config.model,
			snapshot.ctx.modelRegistry,
			snapshot.signal,
		);

		if (activeAbortController === abortController) {
			activeAbortController = null;
		}
		if (!summary || snapshot.signal.aborted) return;
		if (snapshot.seq !== latestRequestedSeq) return;

		lastRecapMessageCount = snapshot.messageCount;
		showRecap(snapshot.ctx, summary);
	}

	if (config.onAgentEnd) {
		pi.on("agent_end", (_event, ctx) => {
			captureCtx(ctx);
			scheduleRecap(ctx);
		});
	}

	pi.on("turn_end", (_event, ctx) => {
		captureCtx(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		captureCtx(ctx);
	});

	pi.registerCommand("recap", {
		description: "Trigger a recap immediately",
		async handler(_args, ctx) {
			captureCtx(ctx);
			scheduleRecap(ctx, { notifyGenerating: true, force: true });
		},
	});

	if (config.intervalMinutes > 0) {
		const intervalMs = config.intervalMinutes * 60 * 1000;
		intervalTimer = setInterval(() => {
			const ctx = latestCtx;
			if (!ctx || !ctx.isIdle()) return;
			scheduleRecap(ctx);
		}, intervalMs);
		intervalTimer.unref?.();
	}

	pi.on("session_shutdown", () => {
		if (intervalTimer) {
			clearInterval(intervalTimer);
			intervalTimer = null;
		}
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}
		activeAbortController?.abort();
		activeAbortController = null;
		g[INSTANCE_KEY] = undefined;
	});
}
