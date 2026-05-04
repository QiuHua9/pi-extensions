# pi-recap

A [pi](https://github.com/badlogic/pi-mono) extension that generates automatic session recaps using a lightweight LLM call. After each agent turn (or on a timer), a brief status summary appears above the editor — then fades into an info notification.

Similar in spirit to Claude Code's session summary, recaps follow a structured past/present/future format so you always know what's done, what's happening now, and what's coming next.

## What it does

- Monitors your conversation and triggers a recap when the agent finishes a turn or on a configurable timer
- Calls a small model (default: `glm-4.7`) to produce an objective, 1–3 sentence status summary
- Displays the recap as a widget above the input editor for 30 seconds
- After timeout, the widget disappears and the recap is preserved as an `info` notification
- Adapts to the language used in the conversation

**Example output:**

```
📋 Fixed the provider prefix issue in agent .md — subagent now runs correctly. Just completed all four modules of the recap plugin; next step is to reload and verify the results.
```

## Install

```bash
pi install <path-to-this-directory>
# or add to .pi/extension-repos.json
```

## Configuration

Create `~/.pi/recap.jsonc` (user-level) or `<project>/.pi/recap.jsonc` (project-level). Project config overrides user config.

```jsonc
{
  // Periodic recap interval in minutes. 0 = disable timer.
  "intervalMinutes": 5,

  // Model to use (bare name, no provider prefix).
  "model": "glm-4.7",

  // Trigger recap when agent finishes a turn.
  "onAgentEnd": true,

  // How long the widget stays visible (seconds). 0 = never auto-dismiss.
  "displaySeconds": 30,

  // Enable/disable the plugin entirely.
  "enabled": true
}
```

All fields are optional — defaults are shown above.

## How it works

1. **Trigger** — on `agent_end` event and/or periodic `setInterval` (only when agent is idle)
2. **Collect** — reads the current session branch via `ctx.sessionManager.getBranch()`, extracts recent messages since the last recap
3. **Summarize** — sends the collected context to a small model via `completeSimple()` with a prompt that asks for a factual standup-style recap
4. **Display** — `setWidget("recap", ...)` renders above the editor; `setTimeout` clears it and fires `notify()` as a persistent info toast

The recap content never enters the LLM context — it is display-only.

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Entry point — event listeners, timer, widget lifecycle |
| `config.ts` | JSONC config loader with user/project merge |
| `collect.ts` | Extracts messages from session entries |
| `summarize.ts` | LLM call to generate recap text |

## License

MIT
