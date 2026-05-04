# Impression System

Nobody memorizes a full handbook before doing real work; we skim, keep an impression, and move. LLMs should do the same: leave an impression and work without carrying wasteful details. Impression is a plug-and-play extension for [pi](https://github.com/badlogic/pi-mono) that automatically compresses long tool results into compact "impressions" using the active LLM, while storing originals for on-demand recall.

> Tip: if you also load the `docker` plugin, Impression can present cumulative `[impression:data]` stats more clearly in the docker sidebar. Without docker, it falls back to the normal footer status.

## The Problem

In long coding sessions, tool results (file reads, command outputs, search results) accumulate rapidly in the conversation context. Most content is read once, understood, and never referenced again — but it stays in the context window, consuming tokens and degrading model attention. In a typical session that reads 20+ files, the impression system reduces context usage by 40–70%.

## How It Works

1. **Intercept** — hooks every `tool_result` event; if text length exceeds a configurable threshold (default 2 048 chars), distillation kicks in.
2. **Distill** — calls the active model with a specialized prompt that tells it: "you are compressing your own memory". The model produces a short note capturing what matters for the next step.
3. **Replace** — the original tool result is swapped for the compressed impression.
4. **Recall** — a `recall_impression` tool is registered. The agent can call it to retrieve the original content. On the first recall, the model re-distills with updated context. After the configured number of recalls, full content is returned verbatim.

The distillation prompt (in `prompts/`) is designed so the model treats it as self-compression, not third-party summarization. It receives the full visible history and system prompt, so impressions are context-aware.

## Quick Start

### Prerequisites

- **Node.js** ≥ 18 (includes npm)
- **Python 3** ≥ 3.9 (only for the setup script)
- An API key for at least one LLM provider (Anthropic, OpenAI, Google, OpenRouter, etc.)

### Automated Setup

```bash
python3 setup.py
```

The setup script will:
1. Check for / install pi globally via npm
2. Interactively configure your LLM API key (skippable)
3. Register this directory as a pi extension (skippable)

Works on **macOS**, **Linux**, and **Windows** (PowerShell / Git Bash / WSL).

### Manual Setup

#### 1. Install pi

```bash
npm install -g @mariozechner/pi-coding-agent
```

#### 2. Set an API key

```bash
# Pick one:
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GOOGLE_API_KEY="AI..."
export OPENROUTER_API_KEY="sk-or-..."
```

#### 3. Install the extension

```bash
# From this directory:
pi install .

# Or from anywhere:
pi install /path/to/impression
```

**Alternative** — load it per-session without installing:

```bash
pi --extension /path/to/impression/index.ts
```

## Project Structure

```
impression/
├── index.ts                  # Extension entry point (wires events + tool)
├── src/
│   ├── types.ts              # Interfaces, type guards, constants
│   ├── config.ts             # Config loading, resolution, skip-pattern matching
│   ├── serialize.ts          # Content serialization (text + images)
│   ├── prompt-loader.ts      # Loads and templates prompt files
│   ├── distill.ts            # Distillation logic (calls LLM)
│   ├── format-call.ts        # UI: formats tool call display for recall
│   └── result-builders.ts    # Builds impression/passthrough tool results
├── prompts/
│   ├── distiller-system.txt  # System prompt for the distiller model
│   ├── distiller-user.txt    # User prompt template (history + tool result)
│   └── impression-text.txt   # Template shown to the agent after distillation
├── setup.py                  # Cross-platform installer
└── README.md
```

## Configuration

Create `.pi/impression.json` in your project root (optional — all fields have defaults):

```json
{
  "debug": true,
  "debug:distill-mode": "third-person",
  "skipDistillation": [],
  "minLength": 2048,
  "maxRecallBeforePassthrough": 1,
  "showData": false
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `debug` | `boolean` | `false` | Enables debug notifications and debug-only options. |
| `debug:distill-mode` | `"first-person" \| "third-person"` | unset | Debug override for distiller prompt mode. Works only when `debug: true`; otherwise it is ignored with a warning. |
| `skipDistillation` | `string[]` | `[]` | Tool names to never distill. Exact match (`"bash"`) or glob prefix (`"background_*"`). |
| `minLength` | `number` | `2048` | Minimum text length (chars) to trigger distillation. |
| `maxRecallBeforePassthrough` | `number` | `1` | Recalls returning re-distilled notes before switching to full passthrough. |
| `showData` | `boolean` | `false` | Shows per-distillation char data as `[impression:data] XXX / YYY = ZZ%`, where the display uses compact `k`/`M` formatting with two decimals, while the ratio is calculated from exact underlying character counts and the footer keeps a cumulative `impression / original` status. |

Config is reloaded on every session start — edit it without restarting pi.

When `debug:distill-mode` is set (and `debug: true`), Impression always uses that prompt variant and does not switch based on the active model. When unset, it keeps model-based routing.

## What to Expect

### Signs It's Active

- **Status bar** shows `[impression] Distilling N chars with provider/model...` during compression.
- **Notifications** for skipped results (too short, in skip list, errors).
- **Tool results** are replaced with the `🧠 [MY INTERNAL MEMORY | ID: ...]` format.
- A **`recall_impression` tool** appears in the agent's tool list.
- If the **`docker` plugin** is loaded, cumulative **`[impression:data]`** stats are shown there; otherwise they remain in the footer.

### Signs It's Working Well

- The agent continues working fluidly after reading large files.
- Fewer tokens consumed per turn in long sessions.
- The agent calls `recall_impression` when it actually needs exact text (e.g., before editing), and gets the right content back.
- Distilled notes are shorter than the original but capture key information.

### Tuning

- Agent keeps recalling immediately → raise `minLength`.
- Important details lost → lower `maxRecallBeforePassthrough` to `0`, or add the tool to `skipDistillation`.
- Distillation too slow → raise `minLength` to distill less often.

## Customizing Prompts

All prompts are plain text files in `prompts/`. Edit them directly to tune distillation behavior.

**Template variables** (replaced at runtime):

| File | Variables |
|---|---|
| `distiller-system.txt` | `{{contentLength}}`, `{{lengthNote}}`, `{{sentinel}}` |
| `distiller-user.txt` | `{{originalSystemPrompt}}`, `{{visibleHistory}}`, `{{toolName}}`, `{{toolResult}}` |
| `impression-text.txt` | `{{id}}`, `{{note}}` |

## Dependencies

None beyond what pi already bundles:

- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`
- `@sinclair/typebox`

## License

MIT
