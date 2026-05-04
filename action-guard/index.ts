/**
 * Smart Tools Extension
 *
 * 1. confirm_action - 敏感操作确认：告知用户具体修改内容，让用户确认是否执行
 * 2. clarify_intent - 歧义消解：返回最可能的选项让用户确认真实意图
 *
 * Uses official TUI components: SelectList + DynamicBorder + Container
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	// ============================================================
	// Tool 1: confirm_action — 敏感操作确认
	// ============================================================

	const ConfirmActionParams = Type.Object({
		action: Type.String({
			description: "简述即将执行的操作，如 '删除 config.yaml 文件'、'修改数据库连接配置'",
		}),
		details: Type.String({
			description: "具体的修改内容，尽量详细描述：修改了哪些文件、改了什么、影响范围等",
		}),
		reason: Type.Optional(
			Type.String({
				description: "为什么要做这个修改，帮助用户判断是否合理",
			}),
		),
	});

	pi.registerTool({
		name: "confirm_action",
		label: "Confirm Action",
		description:
			"在执行敏感操作前，向用户展示具体修改内容并请求确认。适用于删除文件、修改配置、数据库操作等场景。",
		promptSnippet: "敏感操作确认：展示修改内容，让用户确认是否执行",
		promptGuidelines: [
			"执行删除文件、修改关键配置、数据库写入等敏感操作前，必须先调用此工具获取用户确认。",
			"details 字段要尽量详细，包括：涉及哪些文件、具体改了什么行、旧值→新值等。",
			"如果用户选择取消，不要执行该操作，告知用户已取消。",
		],
		parameters: ConfirmActionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: `[自动确认] ${params.action}\n${params.details}` }],
					details: { confirmed: true, action: params.action },
				};
			}

			const confirmed = await ctx.ui.custom<boolean | null>((tui, theme, _kb, done) => {
				const container = new Container();

				// Top border
				container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

				// Title
				container.addChild(new Text(theme.fg("warning", theme.bold("⚠️  即将执行敏感操作")), 1, 0));

				// Action
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("text", `操作: ${params.action}`), 1, 0));
				container.addChild(new Spacer(1));

				// Details
				for (const line of params.details.split("\n")) {
					container.addChild(new Text(theme.fg("muted", line), 1, 0));
				}

				// Reason
				if (params.reason) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `原因: ${params.reason}`), 1, 0));
				}

				container.addChild(new Spacer(1));

				// Selection list
				const items: SelectItem[] = [
					{ value: "yes", label: "✅ 确认执行", description: "继续执行上述操作" },
					{ value: "no", label: "❌ 取消", description: "不执行，保持现状" },
				];

				const selectList = new SelectList(items, 2, {
					selectedPrefix: (t: string) => theme.fg("accent", t),
					selectedText: (t: string) => theme.fg("accent", t),
					description: (t: string) => theme.fg("muted", t),
					scrollInfo: (t: string) => theme.fg("dim", t),
					noMatch: (t: string) => theme.fg("warning", t),
				});
				selectList.onSelect = (item) => done(item.value === "yes");
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				// Help text
				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

				// Bottom border
				container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

				return {
					render: (w) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data) => {
						selectList.handleInput(data);
						tui.requestRender();
					},
				};
			});

			if (confirmed === null) {
				return {
					content: [{ type: "text", text: `用户取消了操作: ${params.action}` }],
					details: { confirmed: false, action: params.action },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: confirmed ? `用户已确认: ${params.action}` : `用户已取消: ${params.action}`,
					},
				],
				details: { confirmed, action: params.action },
			};
		},

		renderCall(args, theme, _context) {
			let text =
				theme.fg("toolTitle", theme.bold("confirm_action ")) +
				theme.fg("muted", args.action);
			if (args.reason) {
				text += theme.fg("dim", ` (${args.reason})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as { confirmed: boolean; action: string } | undefined;
			if (!details) return new Text("", 0, 0);
			if (details.confirmed) {
				return new Text(
					theme.fg("success", "✓ 已确认 ") + theme.fg("muted", details.action),
					0,
					0,
				);
			}
			return new Text(
				theme.fg("warning", "✗ 已取消 ") + theme.fg("muted", details.action),
				0,
				0,
			);
		},
	});

	// ============================================================
	// Tool 2: clarify_intent — 歧义消解
	// ============================================================

	const OptionSchema = Type.Object({
		value: Type.String({ description: "选项的唯一标识值" }),
		label: Type.String({ description: "展示给用户的选项文字" }),
		description: Type.Optional(
			Type.String({ description: "该选项的补充说明，帮助用户理解" }),
		),
	});

	const ClarifyIntentParams = Type.Object({
		ambiguous_input: Type.String({
			description: "用户原始的有歧义的输入",
		}),
		reason: Type.Optional(
			Type.String({
				description: "为什么会存在歧义，简述原因",
			}),
		),
		options: Type.Array(OptionSchema, {
			description: "最可能的几种理解，至少 2 个，至多 6 个",
			minItems: 2,
			maxItems: 6,
		}),
	});

	pi.registerTool({
		name: "clarify_intent",
		label: "Clarify Intent",
		description:
			"当用户的输入存在歧义时，列出最可能的几种理解供用户选择确认。适用于模糊需求、多义语句、不确定的路径/文件等场景。",
		promptSnippet: "歧义消解：列出最可能的几种理解供用户选择",
		promptGuidelines: [
			"当用户输入存在多种合理解读时，调用此工具让用户确认真实意图。",
			"options 应覆盖最可能的 2~6 种理解，label 要简洁易懂，description 补充细节。",
			"根据用户选择的结果继续执行对应的操作，不要擅自猜测。",
		],
		parameters: ClarifyIntentParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				const first = params.options[0];
				return {
					content: [
						{
							type: "text",
							text: `[非交互模式，自动选择第一个选项] ${first.label}`,
						},
					],
					details: {
						selected: first.value,
						label: first.label,
						wasCustom: false,
						options: params.options.map((o) => o.value),
					},
				};
			}

			const items: SelectItem[] = [
				...params.options.map((o) => ({
					value: o.value,
					label: o.label,
					description: o.description,
				})),
				{ value: "__other__", label: "✏️ 都不是，我来描述...", description: "自定义输入" },
			];

			const result = await ctx.ui.custom<{ value: string; label: string } | null>(
				(tui, theme, _kb, done) => {
					const container = new Container();

					// Top border
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					// Title
					container.addChild(
						new Text(theme.fg("accent", theme.bold("❓  请确认你的意思")), 1, 0),
					);

					// Context
					container.addChild(new Spacer(1));
					container.addChild(
						new Text(theme.fg("text", `原始输入: ${params.ambiguous_input}`), 1, 0),
					);

					if (params.reason) {
						container.addChild(
							new Text(theme.fg("dim", `歧义原因: ${params.reason}`), 1, 0),
						);
					}

					container.addChild(new Spacer(1));

					// Selection list
					const selectList = new SelectList(
						items,
						Math.min(items.length + 1, 8),
						{
							selectedPrefix: (t: string) => theme.fg("accent", t),
							selectedText: (t: string) => theme.fg("accent", t),
							description: (t: string) => theme.fg("muted", t),
							scrollInfo: (t: string) => theme.fg("dim", t),
							noMatch: (t: string) => theme.fg("warning", t),
						},
					);
					selectList.onSelect = (item) => {
						const originalOpt = params.options.find((o) => o.value === item.value);
						done({
							value: item.value,
							label: originalOpt?.label ?? item.label,
						});
					};
					selectList.onCancel = () => done(null);
					container.addChild(selectList);

					// Help text
					container.addChild(
						new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0),
					);

					// Bottom border
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							selectList.handleInput(data);
							tui.requestRender();
						},
					};
				},
			);

			if (!result) {
				return {
					content: [{ type: "text", text: "用户取消了选择" }],
					details: {
						selected: null,
						label: null,
						wasCustom: false,
						options: params.options.map((o) => o.value),
					},
				};
			}

			if (result.value === "__other__") {
				return {
					content: [{ type: "text", text: "用户选择了自定义输入（请根据后续输入继续）" }],
					details: {
						selected: "__other__",
						label: "自定义输入",
						wasCustom: true,
						options: params.options.map((o) => o.value),
					},
				};
			}

			return {
				content: [{ type: "text", text: `用户确认: ${result.label}` }],
				details: {
					selected: result.value,
					label: result.label,
					wasCustom: false,
					options: params.options.map((o) => o.value),
				},
			};
		},

		renderCall(args, theme, _context) {
			const opts = Array.isArray(args.options) ? args.options : [];
			const labels = opts.map((o: { label: string }) => o.label).join(" / ");
			let text =
				theme.fg("toolTitle", theme.bold("clarify_intent ")) +
				theme.fg("muted", `"${args.ambiguous_input}"`);
			if (labels) {
				text += "\n" + theme.fg("dim", `  ${labels}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as {
				selected: string | null;
				label: string | null;
				wasCustom: boolean;
			} | undefined;
			if (!details || !details.selected) {
				return new Text(theme.fg("warning", "✗ 已取消"), 0, 0);
			}
			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(自定义) ") + theme.fg("accent", details.label),
					0,
					0,
				);
			}
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", details.label), 0, 0);
		},
	});
}
