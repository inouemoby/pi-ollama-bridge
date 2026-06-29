// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `default` resolves to the first-listed entry.
// Extracted from index.ts so tests can import without activating the extension.
//
// First entry = default model (appears as "Default (recommended)" in /model picker).
// All entries are Ollama Cloud model IDs and are forwarded verbatim to the
// Claude Agent SDK, which forwards them to https://ollama.com/v1/messages.

export const MODEL_IDS_IN_ORDER = [
	"minimax-m3", // default — fast, cheap, widely-capable
	"kimi-k2.7-code", // coding specialist (1T params)
	"mistral-large-3:675b", // long-context, complex reasoning
	"glm-5.1", // long-running tasks (Fable slot)
	"nemotron-3-ultra", // NVIDIA 500B general
	"glm-5.2", // appended per user request — not first, not default
];

// Ollama Cloud served-context defaults. These are best-effort estimates based on
// upstream model cards; the runtime can report a different value via
// logServedContextWindow() which logs the SDK's actual contextWindow per turn.
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	"minimax-m3": 200_000,
	"kimi-k2.7-code": 256_000,
	"mistral-large-3:675b": 256_000,
	"glm-5.1": 200_000,
	"nemotron-3-ultra": 200_000,
	"glm-5.2": 200_000,
};

// Project configured model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. We DO NOT call getModels("anthropic")
// because Ollama Cloud models aren't registered with pi-ai's anthropic provider;
// instead we synthesize metadata from MODEL_CONTEXT_WINDOWS.
export function buildModels<T extends { id: string; [key: string]: any }>(_piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER.map((id) => {
		const ctx = MODEL_CONTEXT_WINDOWS[id] ?? 200_000;
		return {
			id,
			name: id,
			reasoning: false,
			input: ["text"] as Array<"text" | "image">,
			contextWindow: ctx,
			maxTokens: 32_000,
			thinkingLevelMap: undefined,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
	});
}

export type LongContextSettings = {
	plan: "pro" | "max";
	longContextExtraUsage: boolean;
};

export type OllamaRuntimeModel = {
	cliModelId: string;
	contextWindow: number;
};

// Resolve a configured Ollama Cloud model to its SDK request id and context window.
// Unlike the upstream Claude Code variant, we pass model IDs through verbatim —
// Ollama Cloud accepts the same name on /v1/messages. Context window is read
// from a static map; if you add new models, update MODEL_CONTEXT_WINDOWS too.
export function resolveClaudeCodeRuntimeModel(modelId: string, _settings: LongContextSettings): OllamaRuntimeModel {
	const ctx = MODEL_CONTEXT_WINDOWS[modelId] ?? 200_000;
	return { cliModelId: modelId, contextWindow: ctx };
}

export function claudeCodeModelId(model: { id: string }, settings: LongContextSettings): string {
	return resolveClaudeCodeRuntimeModel(model.id, settings).cliModelId;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Ollama Cloud, or pi's status
// bar and auto-compaction threshold will misreport.
export function applyLongContext<T extends { id: string; name: string; contextWindow?: number | null }>(
	models: T[],
	settings: LongContextSettings,
): T[] {
	return models.map((m) => {
		const { contextWindow } = resolveClaudeCodeRuntimeModel(m.id, settings);
		const name = contextWindow > 200_000 && !/\b1M\b/i.test(m.name) ? `${m.name} 1M` : m.name;
		return contextWindow === m.contextWindow && name === m.name ? m : { ...m, contextWindow, name };
	});
}