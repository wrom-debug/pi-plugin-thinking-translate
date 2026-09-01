# thinking-translate —— 思考过程翻译插件

自动把 pi（coding agent）的**英文思考过程翻译成中文**，译文插入在思考内容与正式答复之间，随思考块一起显示/隐藏（`Ctrl+T`）。

## 文件说明

| 文件 | 用途 |
|------|------|
| `thinking-translate.ts` | 插件主文件（单文件，无外部依赖，复制即用） |
| `config.example.json` | 配置示例（复制到目标机后按需修改） |

## 安装（3 步）

### 1. 放置插件文件

```bash
mkdir -p ~/.pi/agent/extensions
cp thinking-translate.ts ~/.pi/agent/extensions/
```

插件会被自动发现加载，无需其他安装步骤。

### 2. 放置配置文件（可选，默认配置即可用）

```bash
mkdir -p ~/.pi/agent/config
cp config.example.json ~/.pi/agent/config/thinking-translate.json
```

> 不放置配置文件时使用内置默认值（启用、跟随当前对话模型翻译）。

### 3. 重启 pi 或执行 `/reload`

```text
/reload
```

## 使用

| 命令 | 作用 |
|------|------|
| `/thinking-translate` | 查看状态 |
| `/thinking-translate on` / `off` | 开启 / 关闭 |
| `/thinking-translate model <provider>/<modelId>` | 指定翻译模型（如 `ollama/RogerBen/HY-MT2-1.8B`） |
| `/thinking-translate reset` | 恢复使用当前对话模型翻译 |

**效果示意**（展开思考块后可见）：

```
思考内容（英文，灰色斜体）
─────────────
**中文翻译**            ← 粗体标签
**译文（粗体，颜色可配）**   ← 中文译文（默认粗体；颜色/格式可在配置中调整）
（这里才是正式答复）
```

## 配置项说明

```jsonc
{
  "enabled": true,            // 总开关
  "model": "ollama/RogerBen/HY-MT2-1.8B",  // 翻译模型 "provider/modelId"；null = 跟随当前对话模型
  "timeoutMs": 30000,         // 单次翻译调用超时（毫秒）
  "cjkThreshold": 0.2,        // 中文判定阈值：思考内容中文字符占比 ≥ 20% 视为中文，不翻译
  "maxThinkingChars": 4000,   // 翻译上限：超长思考只翻译开头部分（防止小模型劣质输出/超时）
  "chunkChars": 1200,         // 分段大小：长文本分段翻译（本地小模型如 HY-MT2 超 ~1500 字符会超时）
  "translationFormat": "bold",      // 译文显示格式：italic=斜体，bold=粗体，code=等宽，strikethrough=删除线，plain=普通
  "translationColor": null,     // 译文颜色 "#RRGGBB"（如 "#FF8800"）；null = 不指定（用思考块默认色）
  "label": "中文翻译",        // 译文前显示的标签文字
  "debug": false              // true 时打印翻译失败日志
}
```

## 行为规则

1. **中文思考**（CJK 占比 ≥ 阈值）→ 不翻译
2. **英文思考** → 翻译成中文（仅当回复为中文时；英文回复无需翻译）
3. **代码/路径为主的思考** → 不翻译
4. **超长思考**（> maxThinkingChars）→ 只翻译开头部分并标注"（思考过长，译文为开头部分）"
5. 翻译引擎用当前 LLM 模型，可通过配置指定其它模型（如本地 Ollama 翻译模型，零费用）

## 故障排查

| 现象 | 原因 / 处理 |
|------|------------|
| 翻译标签出现但译文带 `<TEXT...>` 等垃圾 | 纯翻译模型把指令标签当文本回显；已内置清洗，若仍出现请更新插件版本 |
| 译文是英文原文而非中文 | 翻译模型偶发不跟随指令；已内置「中文校验 + 自动重试」，仍频繁出现则换质量更高的模型 |
| 翻译超时 | 思考过长或本地模型慢；调大 `timeoutMs` / 调小 `maxThinkingChars` |
| pi 挂起 / Connection error | 检查本地 Ollama 是否存活：`curl localhost:11434` |

## 依赖说明

- 插件为**单文件 TypeScript**，由 pi 内置的 jiti 运行时直接加载，**无需编译、无 npm 依赖**
- 仅使用 pi 运行时自带的 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai`
- 翻译模型需在目标机的 pi 中已配置（`models.json` 或已登录的 provider），本地 Ollama 可直接使用

## 版本记录

- v1.3：译文颜色可配置（`translationColor`，"#RRGGBB"）、默认格式改为粗体（中文终端渲染可靠）
- v1.2：译文中文校验 + 自动重试（修复小模型偶发输出英文）
- v1.1：译文格式可配置（italic/bold/code/strikethrough/plain）、README 中英文双语
- v1.0：中英文互译、自动语言判断、代码跳过、分段翻译、超长截断

---

## English

**thinking-translate** — a pi (coding agent) extension that automatically translates the assistant's **English thinking/reasoning blocks into Chinese**, inserting the translation between the thinking block and the final reply. The translation follows the thinking block (shown/hidden together with `Ctrl+T`).

### Files

| File | Purpose |
|------|---------|
| `thinking-translate.ts` | The extension (single file, zero npm dependencies — copy and use) |
| `config.example.json` | Example config (copy to the target machine and edit as needed) |

### Install (3 steps)

```bash
# 1. Copy the extension (auto-discovered)
mkdir -p ~/.pi/agent/extensions
cp thinking-translate.ts ~/.pi/agent/extensions/

# 2. Optional: copy the config (defaults work without it)
mkdir -p ~/.pi/agent/config
cp config.example.json ~/.pi/agent/config/thinking-translate.json

# 3. Reload pi or restart
/reload
```

### Commands

| Command | Action |
|---------|--------|
| `/thinking-translate` | Show status |
| `/thinking-translate on` / `off` | Enable / disable |
| `/thinking-translate model <provider>/<modelId>` | Set the translation model (e.g. `ollama/RogerBen/HY-MT2-1.8B`) |
| `/thinking-translate reset` | Use the current conversation model for translation |

### Behavior

1. **Chinese thinking** (CJK ratio ≥ threshold) → not translated
2. **English thinking** → translated into Chinese (only when the reply is in Chinese; English replies are skipped)
3. **Code/path-heavy thinking** → not translated
4. **Very long thinking** (> `maxThinkingChars`) → only the beginning is translated, marked as truncated
5. The translation engine defaults to the current model; you can pin a different model (e.g. a local Ollama model, zero cost)

### Config

```jsonc
{
  "enabled": true,
  "model": "ollama/RogerBen/HY-MT2-1.8B",  // "provider/modelId"; null = follow current model
  "timeoutMs": 30000,          // per-call timeout (ms)
  "cjkThreshold": 0.2,         // Chinese-detection threshold: CJK ratio ≥ 20% → treat as Chinese, skip
  "maxThinkingChars": 4000,    // cap for translation (long thinking is truncated to the beginning)
  "chunkChars": 1200,          // chunk size for long text (small local models like HY-MT2 time out > ~1500 chars)
  "translationFormat": "bold",      // display format: italic | bold | code | strikethrough | plain
  "translationColor": null,     // translation color "#RRGGBB" (e.g. "#FF8800"); null = default (thinking block color)
  "label": "中文翻译",
  "debug": false
}
```

### Notes

- Single-file TypeScript, loaded directly by pi's built-in jiti runtime — **no build step, no npm dependencies**
- Only uses pi's bundled `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
- The translation model must be configured on the target machine (in `models.json` or a logged-in provider); local Ollama works out of the box
