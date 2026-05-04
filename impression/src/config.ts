import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { CONFIG_FILE_NAME, DEFAULT_DISTILL_RATE_FLOOR, DEFAULT_MAX_PASSTHROUGH_COUNT, DEFAULT_MAX_RECALL, DEFAULT_MIN_LENGTH } from "./types.js";
import type { ImpressionConfig, ResolvedConfig } from "./types.js";

export function resolveConfig(raw: ImpressionConfig): ResolvedConfig {
	return {
		debugDistillMode: raw["debug:distill-mode"],
		skipDistillation: raw.skipDistillation ?? [],
		minLength: raw.minLength ?? DEFAULT_MIN_LENGTH,
		maxRecall: raw.maxRecallBeforePassthrough ?? DEFAULT_MAX_RECALL,
		maxPassthroughCount: raw.maxPassthroughCount ?? DEFAULT_MAX_PASSTHROUGH_COUNT,
		showData: raw.showData ?? false,
		debug: raw.debug ?? false,
		distillRateFloor: raw.distillRateFloor ?? DEFAULT_DISTILL_RATE_FLOOR,
		enabled: raw.enabled ?? true,
	};
}

function loadJsonConfig(path: string): ImpressionConfig | null {
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as ImpressionConfig;
		}
	} catch {
		// Config file missing or invalid
	}
	return null;
}

export function loadConfig(): ImpressionConfig {
	const globalConfig = loadJsonConfig(join(getAgentDir(), CONFIG_FILE_NAME));
	const localConfig = loadJsonConfig(join(process.cwd(), ".pi", CONFIG_FILE_NAME));
	return { ...globalConfig, ...localConfig };
}

export function saveLocalConfig(patch: Partial<ImpressionConfig>): void {
	const dir = join(process.cwd(), ".pi");
	const path = join(dir, CONFIG_FILE_NAME);
	const existing = loadJsonConfig(path) ?? {};
	const merged = { ...existing, ...patch };
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(merged, null, "\t") + "\n", "utf-8");
}

export function shouldSkipDistillation(toolName: string, config: ResolvedConfig): boolean {
	const patterns = config.skipDistillation;
	if (patterns.length === 0) return false;
	for (const pattern of patterns) {
		if (pattern === toolName) return true;
		if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return true;
	}
	return false;
}
