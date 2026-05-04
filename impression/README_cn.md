# Impression System

没有人干活要先把工作手册背下来；略读一遍，留下“印象”就开工才是正确做法。Impression System (印象系统) 是一个可即插即用的 [pi](https://github.com/badlogic/pi-mono) 扩展：它会使用当前激活的 LLM，将较长的工具结果压缩成简洁的 impression，并保留原始内容，供后续按需召回。

> 提示：如果同时加载 `docker` 插件，Impression 会把累计的 `[impression:data]` 统计更清晰地展示在 docker 侧边栏里；如果没有 docker，则会自动回退为普通 footer 状态显示。

## 要解决的问题

在长时间编码会话中，工具结果（文件读取、命令输出、搜索结果）会迅速堆积到对话上下文中。大部分内容只会被看一次、理解一次，之后基本不会再引用，但它们依然会持续占用上下文窗口，消耗 token，并分散模型注意力。在一次读取 20 个以上文件的典型会话里，impression system 通常可以将上下文占用降低 40% 到 70%。

## 工作原理

1. **Intercept**：拦截每一个 `tool_result` 事件；当文本长度超过可配置阈值时（默认 2,048 个字符），启动蒸馏。
2. **Distill**：调用当前激活的模型，并使用专门设计的提示词，告诉模型“你正在压缩自己的记忆”。模型会产出一段简短笔记，保留下一步真正需要的信息。
3. **Replace**：用压缩后的 impression 替换原始工具结果。
4. **Recall**：注册一个 `recall_impression` 工具，代理可以按需取回原始内容。首次召回时，模型会结合更新后的上下文重新蒸馏；达到配置的召回次数后，则直接返回完整原文。

`prompts/` 目录中的蒸馏提示词经过专门设计，使模型将这个过程视为“自我压缩”，而不是对第三方内容做摘要。模型会拿到完整的可见历史和 system prompt，因此生成的 impression 具备上下文感知能力。

## 快速开始

### 前置要求

- **Node.js** ≥ 18（包含 npm）
- **Python 3** ≥ 3.9（仅用于安装脚本）
- 至少一个 LLM provider 的 API Key（Anthropic、OpenAI、Google、OpenRouter 等）

### 自动安装

```bash
python3 setup.py
```

安装脚本会完成以下操作：
1. 检查是否已全局安装 pi，如未安装则尝试安装
2. 以交互方式配置 LLM API Key（可跳过）
3. 将当前目录注册为 pi 扩展（可跳过）

支持 **macOS**、**Linux** 和 **Windows**（PowerShell / Git Bash / WSL）。

### 手动安装

#### 1. 安装 pi

```bash
npm install -g @mariozechner/pi-coding-agent
```

#### 2. 设置 API Key

```bash
# 任选一种：
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="AI..."
export OPENROUTER_API_KEY="sk-or-..."
```

#### 3. 安装扩展

```bash
# 在当前目录下执行：
pi install .

# 或在任意目录执行：
pi install /path/to/impression
```

**另一种方式**：不安装，按会话临时加载扩展：

```bash
pi --extension /path/to/impression/index.ts
```

## 项目结构

```text
impression/
├── index.ts                  # 扩展入口（连接事件与工具）
├── src/
│   ├── types.ts              # 接口、类型守卫、常量
│   ├── config.ts             # 配置加载、解析、skip pattern 匹配
│   ├── serialize.ts          # 内容序列化（文本 + 图片）
│   ├── prompt-loader.ts      # 加载并填充 prompt 模板
│   ├── distill.ts            # 蒸馏逻辑（调用 LLM）
│   ├── format-call.ts        # UI：格式化 recall 的工具调用展示
│   └── result-builders.ts    # 构建 impression / passthrough 的工具结果
├── prompts/
│   ├── distiller-system.txt  # distiller 模型的 system prompt
│   ├── distiller-user.txt    # 用户 prompt 模板（历史 + 工具结果）
│   └── impression-text.txt   # 蒸馏后展示给代理的模板
├── setup.py                  # 跨平台安装器
└── README.md
```

## 配置

可在项目根目录创建 `.pi/impression.json`（可选，所有字段都有默认值）：

```json
{
  "skipDistillation": [],
  "minLength": 2048,
  "maxRecallBeforePassthrough": 1,
  "showData": false
}
```

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `skipDistillation` | `string[]` | `[]` | 永不蒸馏的工具名。支持精确匹配（`"bash"`）或 glob 前缀（`"background_*"`）。 |
| `minLength` | `number` | `2048` | 触发蒸馏所需的最小文本长度（字符数）。 |
| `maxRecallBeforePassthrough` | `number` | `1` | 切换为完整透传前，召回时返回“重新蒸馏笔记”的最大次数。 |
| `showData` | `boolean` | `false` | 显示每次蒸馏的字符数据，格式为 `[impression:data] XXX / YYY = ZZ%`；其中展示值使用 `k`/`M` 等紧凑格式并保留两位小数，但比例始终基于底层精确字符数计算；底部状态会持续累积显示 `impression / original`。 |

配置会在每次会话启动时重新加载，因此修改后无需重启 pi。

## 使用效果

### 启用后会看到什么

- **状态栏** 会在压缩过程中显示 `[impression] Distilling N chars with provider/model...`
- 对被跳过的结果会显示 **通知**（例如内容太短、命中跳过列表、发生错误）
- **工具结果** 会被替换为 `🧠 [MY INTERNAL MEMORY | ID: ...]` 这类格式
- 代理工具列表中会出现 **`recall_impression` 工具**
- 如果加载了 **`docker` 插件**，累计的 **`[impression:data]`** 会展示在 docker 中；否则继续显示在 footer 里

### 正常工作时的表现

- 代理在读取大文件后仍能流畅继续工作
- 长会话中每轮消耗的 token 更少
- 当代理确实需要精确原文时（例如编辑前），会调用 `recall_impression`，并取回正确内容
- 蒸馏后的笔记明显短于原文，但仍保留关键细节

### 调优建议

- 如果代理总是立刻召回：提高 `minLength`
- 如果关键细节丢失：将 `maxRecallBeforePassthrough` 调低到 `0`，或把对应工具加入 `skipDistillation`
- 如果蒸馏太慢：提高 `minLength`，减少蒸馏频率

## 自定义提示词

所有 prompt 都以纯文本文件形式存放在 `prompts/` 目录中，可以直接编辑以调整蒸馏行为。

**模板变量**（运行时替换）：

| 文件 | 变量 |
|---|---|
| `distiller-system.txt` | `{{contentLength}}`、`{{lengthNote}}`、`{{sentinel}}` |
| `distiller-user.txt` | `{{originalSystemPrompt}}`、`{{visibleHistory}}`、`{{toolName}}`、`{{toolResult}}` |
| `impression-text.txt` | `{{id}}`、`{{note}}` |

## 依赖

除 pi 已内置的内容外，无需额外依赖：

- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@sinclair/typebox`

## 许可证

MIT