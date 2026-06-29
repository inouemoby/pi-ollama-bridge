# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that uses the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) as the runtime engine and **Ollama Cloud** (https://ollama.com) as the model backend. Forked from [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) with the Claude model list replaced by Ollama Cloud's large-parameter models.

Why: pi's own agent loop, compaction, tool dispatch, session persistence, and message formatting are all replaced by the Claude Agent SDK implementation — the SDK then forwards `/v1/messages` requests to Ollama Cloud (`ANTHROPIC_BASE_URL=https://ollama.com`). pi's TUI, extension system, and provider routing stay intact; the underlying agent runtime becomes Claude Code's.

1. **Provider** — Use Ollama Cloud models as the LLM in pi, with all tool calls executed by pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to the Claude Agent SDK (running on Ollama Cloud) when using another provider

**FYI:** Because this runs through the Claude Agent SDK, the `claude_code` system prompt preset is sent on every turn. Ollama Cloud's `/v1/messages` endpoint is anthropic-messages compatible and handles this schema correctly. Non-anthropic trained models may produce lower-quality tool calls than Claude-native ones.

## Install

```
pi install npm:pi-claude-bridge
```

## Configuration

Set these environment variables (e.g. in `~/.bashrc` or Windows user env) before launching `pi`:

```
export ANTHROPIC_BASE_URL=https://ollama.com
export ANTHROPIC_AUTH_TOKEN=<your Ollama Cloud API key>
export ANTHROPIC_API_KEY=
```

Get an API key at https://ollama.com/settings/keys.

## Provider

Use `/model` to select one of:

- `claude-bridge/minimax-m3` (default, fast)
- `claude-bridge/kimi-k2.7-code` (code, 1T params)
- `claude-bridge/mistral-large-3:675b` (long context, complex reasoning)
- `claude-bridge/glm-5.1` (long-running tasks)
- `claude-bridge/nemotron-3-ultra` (NVIDIA 500B general)
- `claude-bridge/glm-5.2` (appended, not default)

Behind the scenes, pi's tools are bridged to Claude Code (mapped to canonical CC tool names `Read`/`Write`/`Edit`/`Bash`). Bash gets a 120s timeout to match CC's default. Skills in pi are forwarded into CC's system prompt.

## AskClaude Tool

Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to the Claude Agent SDK (running on Ollama Cloud) and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for the Claude Agent SDK
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or the project Pi config directory, usually `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "appendSystemPrompt": true,
    "strictMcpConfig": true
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `true`)
- `name`, `label`, `description` — overrides for the tool's pi-side name, TUI label, and description
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)

`provider`:
- `appendSystemPrompt` (default `true`) — append pi's AGENTS.md and skills. Set `false` to use Claude Code's own filesystem-based settings instead.
- `settingSources` — CC filesystem settings to load; only applied when `appendSystemPrompt: false`
- `strictMcpConfig` (default `true`) — block MCP servers auto-loaded from `~/.claude.json` / `.mcp.json`. These are pure token overhead in this fork because pi executes tools, not CC.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Usually unnecessary; only set when the SDK's bundled binary can't run on your OS.

Note: `plan` and `longContextExtraUsage` from upstream are inert here — they only controlled Claude Code's 1M context entitlement. With Ollama Cloud, each model's context window is fixed per model card; see `MODEL_CONTEXT_WINDOWS` in `src/models.ts`.


**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly.

## Tests

`npm run test:unit` for offline tests (`tests/unit-*.mjs`: queue, import, skills).

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `minimax-m3`).

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. Tags are `provider` (main turn), `continuation` (steer replay), or `askclaude` (sub-delegation). Useful when a resume fails or CC misbehaves internally.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Maintenance

After a Claude Agent SDK release, review `MODE_DISALLOWED_TOOLS` in `src/index.ts` — it gates which CC tools the AskClaude subagent may invoke per mode (`read` / `full` / `none`). Add new agentic tools (PlanMode, Task spawning, etc.) to the appropriate mode lists if they shouldn't be available to subagents.

When adding a new Ollama Cloud model: edit `MODEL_IDS_IN_ORDER` and `MODEL_CONTEXT_WINDOWS` in `src/models.ts`.
