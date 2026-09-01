/**
 * thinking-translate —— 思考过程翻译插件（简洁版）
 *
 * 流程：
 *   1. 监听助手消息完成（message_end），取出思考内容
 *   2. 语言判断：中文（CJK 占比 ≥ 阈值）→ 不翻译；英文 → 翻译
 *   3. 用简单输入格式调用翻译模型：system 固定指令 + user "翻译：\n<内容>"
 *   4. 译文插回原消息的思考块末尾（渲染时显示在思考与答复之间，Ctrl+T 跟随隐藏）
 *
 * 命令：
 *   /thinking-translate            查看状态
 *   /thinking-translate on|off     开关
 *   /thinking-translate model <provider>/<modelId>   指定翻译模型
 *   /thinking-translate reset      恢复当前对话模型
 *
 * 配置：~/.pi/agent/config/thinking-translate.json
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingContent } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

interface Config {
	/** 总开关 */
	enabled: boolean;
	/** 翻译模型："provider/modelId"；null = 当前对话模型 */
	model: string | null;
	/** 单次调用超时（毫秒） */
	timeoutMs: number;
	/** 中文判定阈值：CJK 占比 ≥ 该值视为中文不翻译 */
	cjkThreshold: number;
	/** 参与翻译的思考内容上限（超过只翻译开头部分，防止超长思考劣质/超时） */
	maxThinkingChars: number;
	/** 分段翻译的块大小（本地小模型上下文有限，如 HY-MT2 超过 ~1500 字符会超时） */
	chunkChars: number;
	/** 译文显示格式：italic=斜体，bold=粗体，code=等宽，strikethrough=删除线，plain=普通 */
	translationFormat: "italic" | "bold" | "code" | "strikethrough" | "plain";
	/** 译文颜色（"#RRGGBB"）；null/空 = 不指定颜色（用思考块默认灰色） */
	translationColor: string | null;
	/** 译文前显示的标签 */
	label: string;
	/** 调试日志 */
	debug: boolean;
}

const DEFAULT_CONFIG: Config = {
	enabled: true,
	model: null,
	timeoutMs: 30000,
	cjkThreshold: 0.2,
	maxThinkingChars: 4000,
	chunkChars: 1200,
	translationFormat: "bold",
	translationColor: null,
	label: "中文翻译",
	debug: false,
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "config", "thinking-translate.json");

function loadConfig(): Config {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf8");
		return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<Config>) };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(cfg: Config): void {
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
	} catch {
		/* 忽略保存失败 */
	}
}

let config = loadConfig();

// ---------------------------------------------------------------------------
// 语言判断
// ---------------------------------------------------------------------------

function cjkRatio(text: string): number {
	const clean = text.replace(/\s/g, "");
	if (clean.length === 0) return 1;
	const cjk = (clean.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
	return cjk / clean.length;
}

/** 思考是否以中文为主（用户规则：中文不翻译） */
function isChinese(text: string, threshold: number): boolean {
	return cjkRatio(text) >= threshold;
}

/** 思考是否绝大部分是代码/路径（不翻译） */
function isMostlyCode(text: string): boolean {
	const stripped = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/https?:\/\/\S+/g, " ")
		.replace(/\b[\w.@~-]+(?:\/[\w.@~-]+)+\.\w{1,10}\b/g, " ")
		.replace(/\/(?:[\w.@~-]+\/)+[\w.@~-]+/g, " ")
		.replace(/\b[A-Za-z]:\\[\w.\\-]+\b/g, " ")
		.replace(/[\n\r\t]+/g, " ");
	const rest = stripped.replace(/\s/g, "").length;
	const total = text.replace(/\s/g, "").length;
	if (total === 0) return true;
	return rest / total < 0.3;
}

// ---------------------------------------------------------------------------
// 分段 + 翻译
// ---------------------------------------------------------------------------

/** 按句子/空白边界把文本切成不超过 maxChars 的块（超长行硬切） */
function splitChunks(text: string, maxChars: number): string[] {
	const chunks: string[] = [];
	let buf = "";
	const push = (s: string) => {
		const t = s.trim();
		if (t) chunks.push(t);
	};
	// 先按空行分段，段内再按行/句子切
	const paragraphs = text.split(/\n\s*\n/);
	for (const para of paragraphs) {
		if (!para.trim()) continue;
		if (buf && buf.length + 2 + para.length > maxChars) {
			push(buf);
			buf = "";
		}
		// 段仍超长 → 按行切；行超长 → 按句子/字符切
		let paraBuf = buf;
		for (const line of para.split("\n")) {
			if (line.length > maxChars) {
				push(paraBuf);
				paraBuf = "";
				for (const piece of cutLine(line, maxChars)) push(piece);
			} else if (paraBuf && paraBuf.length + 1 + line.length > maxChars) {
				push(paraBuf);
				paraBuf = line;
			} else {
				paraBuf = paraBuf ? paraBuf + "\n" + line : line;
			}
		}
		buf = paraBuf;
	}
	push(buf);
	return chunks;
}

/** 单行超长：优先在句号/空格处断开，否则硬切 */
function cutLine(line: string, maxChars: number): string[] {
	const parts: string[] = [];
	let start = 0;
	while (start < line.length) {
		let end = Math.min(start + maxChars, line.length);
		if (end < line.length) {
			const seg = line.slice(start, end);
			const dot = Math.max(
				seg.lastIndexOf(". "),
				seg.lastIndexOf("。"),
				seg.lastIndexOf("！"),
				seg.lastIndexOf("？"),
				seg.lastIndexOf("! "),
				seg.lastIndexOf("? "),
				seg.lastIndexOf("；"),
				seg.lastIndexOf("; "),
			);
			const sp = seg.lastIndexOf(" ");
			const cut = Math.max(dot, sp);
			if (cut > maxChars * 0.5) end = start + cut + 1;
		}
		parts.push(line.slice(start, end));
		start = end;
	}
	return parts;
}

/** 译文校验：输出以中文为主才算翻译成功（纯英文输出视为失败，触发重试） */
function isLikelyChinese(text: string): boolean {
	const clean = text.replace(/\s/g, "");
	if (clean.length === 0) return false;
	const cjk = (clean.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
	return cjk / clean.length >= 0.15;
}

/** 翻译一段文本；失败（超时/异常/输出非中文）自动重试一次 */
async function translateChunk(
	text: string,
	model: Model<any>,
	ctx: ExtensionContext,
	cfg: Config,
): Promise<string | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await attemptTranslate(text, model, ctx, cfg, attempt);
		if (!r) continue;
		if (isLikelyChinese(r)) return r;
		if (cfg.debug) {
			console.warn("[thinking-translate] 译文非中文，第", attempt + 1, "次重试");
		}
	}
	return undefined;
}

async function attemptTranslate(
	text: string,
	model: Model<any>,
	ctx: ExtensionContext,
	cfg: Config,
	attempt: number,
): Promise<string | undefined> {
	// 固定输入格式：system 一句指令 + user "翻译：\n<内容>"；重试时换用强调版本
	const systemPrompt =
		attempt === 0
			? "You are a translator. Translate the user's text into Simplified Chinese. Output ONLY the translation. Keep code, paths and identifiers unchanged."
			: "You are a translator. Translate the user's text into Simplified Chinese (中文). You MUST output the Chinese translation only, in Chinese characters. Do NOT reply in English. Keep code, paths and identifiers unchanged.";
	const userPrompt = `翻译：\n${text}`;
	const maxTokens = Math.min(8000, Math.max(256, Math.ceil(text.length * 0.8)));

	try {
		const result = await withTimeout(
			ctx.modelRegistry.complete(
				model,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
				},
				{ temperature: attempt === 0 ? 0 : 0.2, maxTokens, signal: ctx.signal },
			),
			cfg.timeoutMs,
		);
		const translated = cleanOutput(contentText(result.content));
		return translated.length > 0 ? translated : undefined;
	} catch (err) {
		if (cfg.debug) {
			console.warn("[thinking-translate] 翻译失败:", err instanceof Error ? err.message : String(err));
		}
		return undefined;
	}
}

/** 翻译完整文本：短文本一次调用，长文本分段翻译后拼接 */
async function translateText(
	text: string,
	model: Model<any>,
	ctx: ExtensionContext,
	cfg: Config,
): Promise<string | undefined> {
	const chunks = splitChunks(text, cfg.chunkChars);
	if (chunks.length === 1) {
		return translateChunk(chunks[0], model, ctx, cfg);
	}
	const parts: string[] = [];
	for (const chunk of chunks) {
		const r = await translateChunk(chunk, model, ctx, cfg);
		if (r) parts.push(r);
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** 清理翻译模型输出：只保留译文主体，去掉可能的标签/说明残片 */
function cleanOutput(text: string): string {
	let t = text ?? "";
	t = t.replace(/<\/?TEXT[^>]*>/gi, " ");
	t = t.replace(/<\/?LANGUAGE\s+REFERENCE[^>]*>/gi, " ");
	t = t.replace(/TO\s+TRANSLATE\s*>/gi, " ");
	t = t.replace(/^\s*(?:Here is the translation:?|Translation:?|Translate to Chinese:?|翻译[:：]?)\s*/i, "");
	const lines = t.split("\n").map((l) => l.trimEnd());
	while (lines.length && lines[0].trim() === "") lines.shift();
	while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
	return lines.join("\n").trim();
}

/**
 * 按配置给译文套用 markdown 显示格式（每段独立包裹），并叠加自定义颜色。
 * 颜色码放在格式标记内侧，保证与粗体/斜体等同时生效。
 * 含代码块时不包裹，避免破坏代码渲染。
 */
function applyFormat(text: string, format: Config["translationFormat"], colorHex: string | null): string {
	if (!text || /```/.test(text)) return text;
	const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
	if (paragraphs.length === 0) return text;
	let open = "";
	let close = "";
	switch (format) {
		case "italic":
			open = close = "*";
			break;
		case "bold":
			open = close = "**";
			break;
		case "code":
			open = close = "`";
			break;
		case "strikethrough":
			open = close = "~~";
			break;
		case "plain":
		default:
			break;
	}
	const colorOpen = colorHex ? hexToAnsiFg(colorHex) : "";
	const colorClose = colorHex ? "\x1b[39m" : "";
	if (!open && !colorOpen) return text;
	return paragraphs.map((p) => `${open}${colorOpen}${p}${colorClose}${close}`).join("\n\n");
}

/** "#RRGGBB" → ANSI 前景色转义码；格式非法返回空串（不应用颜色） */
function hexToAnsiFg(hex: string): string {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
	if (!m) return "";
	const n = parseInt(m[1], 16);
	return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`翻译超时（${ms}ms）`)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

function resolveTranslationModel(ctx: ExtensionContext): Model<any> | undefined {
	if (config.model) {
		const slash = config.model.indexOf("/");
		if (slash > 0) {
			const found = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
			if (found) return found;
			console.warn(`[thinking-translate] 模型 "${config.model}" 未找到，回退当前模型`);
		}
	}
	return ctx.model;
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		config = loadConfig();
	});

	pi.on("message_end", async (event, ctx) => {
		if (!config.enabled) return;
		const message = event.message;
		if (message.role !== "assistant") return;
		if (!Array.isArray(message.content)) return;

		// 取出思考块
		const thinkingBlocks = message.content.filter(
			(c): c is ThinkingContent =>
				c.type === "thinking" && typeof (c as ThinkingContent).thinking === "string",
		);
		if (thinkingBlocks.length === 0) return;

		const model = resolveTranslationModel(ctx);
		if (!model) return;

		let changed = false;
		for (const block of thinkingBlocks) {
			const thinking = block.thinking.trim();
			if (thinking.length < 12) continue; // 太短不翻译
			if (isChinese(thinking, config.cjkThreshold)) continue; // 中文不翻译
			if (isMostlyCode(thinking)) continue; // 代码为主不翻译

			// 截断超长思考（只翻译开头部分 + 截断提示）
			const truncated = thinking.length > config.maxThinkingChars;
			const textForLLM = truncated
				? thinking.slice(0, config.maxThinkingChars) + "\n…(内容过长，以下略)…"
				: thinking;

			const translated = await translateText(textForLLM, model, ctx, config);
			if (!translated) continue;

			// 译文按配置格式+颜色显示（默认粗体），标签保持粗体
			const formattedTranslation = applyFormat(translated, config.translationFormat, config.translationColor);
			block.thinking = `${thinking}\n\n---\n\n**${config.label}**\n\n${formattedTranslation}${truncated ? "\n\n*（思考过长，译文为开头部分）*" : ""}`;
			changed = true;
		}

		if (changed) return { message };
	});

	pi.registerCommand("thinking-translate", {
		description: "思考翻译插件：/thinking-translate [on|off|status|model <provider/modelId>|reset]",
		handler: async (args, ctx) => {
			const [cmd, ...rest] = args.trim().split(/\s+/);
			const notify = (msg: string) => {
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				else console.log(`[thinking-translate] ${msg}`);
			};
			switch (cmd) {
				case "on":
					config.enabled = true;
					saveConfig(config);
					notify("思考翻译已开启");
					break;
				case "off":
					config.enabled = false;
					saveConfig(config);
					notify("思考翻译已关闭");
					break;
				case "model":
					if (!rest[0]) {
						notify("用法：/thinking-translate model <provider>/<modelId>");
						break;
					}
					config.model = rest[0];
					saveConfig(config);
					notify(`翻译模型已设为 ${rest[0]}`);
					break;
				case "reset":
					config.model = null;
					saveConfig(config);
					notify("翻译模型已重置为当前对话模型");
					break;
				case "status":
				default: {
					const model = resolveTranslationModel(ctx);
					notify(
						`思考翻译：${config.enabled ? "✅ 开启" : "⛔ 关闭"}\n` +
							`翻译模型：${config.model ?? (model ? `${model.provider}/${model.id}` : "（无可用模型）")}\n` +
							`中文判定阈值：≥${Math.round(config.cjkThreshold * 100)}%\n` +
							`翻译上限：${config.maxThinkingChars} 字符（分段 ${config.chunkChars}）`,
					);
					break;
				}
			}
		},
	});
}
