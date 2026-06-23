// Canonical selection + display order for the model picker.
// `resolveModel` returns the first partial match, so `opus` resolves to the first-listed opus entry.
// Extracted from index.ts so tests can import without activating the extension.

import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const MODEL_IDS_IN_ORDER = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

// Project pi-ai's model entries down to the fields pi's registerProvider expects,
// and keep MODEL_IDS_IN_ORDER ordering. IDs missing from pi-ai are silently dropped.
// Context-dependent display labels are applied after plan/long-context config is known.
export function buildModels<T extends { id: string; [key: string]: any }>(piAiModels: T[]) {
	return MODEL_IDS_IN_ORDER
		.map((id) => piAiModels.find((m) => m.id === id))
		.filter((m) => m != null)
		// Forward thinkingLevelMap so per-model overrides (e.g. opus-4-7 mapping
		// xhigh→xhigh instead of xhigh→max) are visible to the effort lookup.
		.map(({ id, name, reasoning, input, contextWindow, maxTokens, thinkingLevelMap }) => ({
			id,
			name,
			reasoning, input, contextWindow, maxTokens, thinkingLevelMap,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}));
}

// A model is 1M-*capable* when its advertised window exceeds 200K. Capability is
// not entitlement: Sonnet 4.6's 1M is metered on every plan (including Max), while
// Opus 1M is included on Max/Team/Enterprise. Capability only gates whether opting
// in via provider.longContextExtraUsage has any effect.
export function hasOneMContext(model: { contextWindow?: number | null }): boolean {
	return (model.contextWindow ?? 0) > 200_000;
}

// Append [1m] to the CLI model id only when the model is 1M-capable AND the user
// has opted in for that specific model. The [1m] suffix is what tells the Claude
// Code CLI to open its 1M window; the bare id keeps the 200K default. Unlike the
// context-1m-2025-08-07 beta (issue #24), the model-id path works under
// Pro/Max subscription (OAuth) auth, where the CLI ignores custom betas.
export function claudeCodeModelId(model: { id: string; contextWindow?: number | null }, oneMEnabled: boolean): string {
	return oneMEnabled && hasOneMContext(model) && !model.id.includes("[1m]") ? `${model.id}[1m]` : model.id;
}

export function resolveModel<T extends { id: string }>(models: T[], input: string): T | undefined {
	const lower = input.toLowerCase();
	return models.find((m) => m.id === lower || m.id.includes(lower));
}

// Produce the model metadata registered with pi. The registered contextWindow must
// match the window the bridge actually requests from Claude Code, or pi's status
// bar and auto-compaction threshold will misreport: registering 1M while the CLI
// runs at 200K recreates the "pi shows headroom but CC errors with Prompt is too
// long / credit gate" bug (issue #24, #17). Three cases:
//   1. Opted into longContextModelIds → sends [1m], runtime 1M → register 1M.
//   2. plan "max" + bare Opus → CC auto-upgrades to 1M (default since v2.1.75) →
//      register 1M WITHOUT [1m], avoiding the usage-credits gate an explicit
//      opus[1m] can trip on Max 5x (#39841). Only Opus auto-upgrades; Sonnet's 1M
//      always requires explicit [1m] + credits.
//   3. Everything else (Sonnet bare, Opus on Pro, Haiku) → runtime 200K → register 200K.
export function applyLongContext<T extends { id: string; contextWindow?: number | null }>(
	models: T[],
	longContextModelIds: Set<string>,
	plan: "pro" | "max",
): T[] {
	return models.map((m) => {
		if (longContextModelIds.has(m.id) && hasOneMContext(m)) return m;
		if (plan === "max" && m.id.includes("opus") && hasOneMContext(m)) return m;
		const capped = Math.min(m.contextWindow ?? 200_000, 200_000);
		return capped === m.contextWindow ? m : { ...m, contextWindow: capped };
	});
}

export function applyOneMDisplayNames<T extends { name: string; contextWindow?: number | null }>(models: T[]): T[] {
	return models.map((m) => {
		if (!hasOneMContext(m) || /\b1M\b/i.test(m.name)) return m;
		return { ...m, name: `${m.name} 1M` };
	});
}

// --- Adaptive thinking + effort resolution ---
//
// On adaptive-thinking models (Opus 4.6/4.7/4.8, Sonnet 4.6) `thinking` is a
// separate on/off axis from `effort`: thinking=off skips the reasoning phase
// entirely, effort still governs output thoroughness. Haiku 4.5 is excluded —
// it uses budget-based thinking gated by `reasoning`, with no effort knob, so
// the off path below never applies to it.
const ADAPTIVE_MODEL_IDS = new Set([
	"claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6",
]);

export function isAdaptiveModel(modelId: string): boolean {
	return ADAPTIVE_MODEL_IDS.has(modelId);
}

// AskClaude's default reasoning when the caller omits `thinking`. Adaptive models
// default to "high" — Anthropic's recommended starting point, valid on every
// adaptive model, and avoids sending "max" (which pi-ai maps xhigh→max on the
// 4.6 models that have no real xhigh tier). Non-adaptive models (Haiku has no
// effort knob; unknown future models may not support effort) default to
// undefined so we send no effort and let CC pick, matching the pre-change
// behavior and avoiding an unsupported level reaching the API.
export function defaultAskClaudeReasoning(modelId: string): string | undefined {
	return isAdaptiveModel(modelId) ? "high" : undefined;
}

// pi-agent-core sends `reasoning: undefined` when the slider is "off"
// (thinkingLevel === "off" ? undefined : thinkingLevel — see pi-agent-core
// agent.js). For adaptive models undefined ⟺ slider off. The literal "off" is
// also accepted so AskClaude's `thinking: "off"` (passed through verbatim) and
// any future pi that sends the literal both hit the disabled path.
export function thinkingOffFor(modelId: string, reasoning: string | undefined): boolean {
	return isAdaptiveModel(modelId) && (reasoning === undefined || reasoning === "off");
}

// Fallback effort map for levels a model's thinkingLevelMap doesn't override.
// pi-ai ships only the xhigh override per model (e.g. opus-4-7: {xhigh:"xhigh"},
// opus-4-6: {xhigh:"max"}); low/medium/high fall through here.
const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

export type ThinkingLevelMap = Record<string, string>;

export interface ResolveEffortOptions {
	/** Effort sent when thinking is disabled (reasoning off). Default "high". */
	effortWhenOff: EffortLevel;
	/** Per-model override map forwarded from pi-ai (buildModels keeps it). */
	thinkingLevelMap?: ThinkingLevelMap;
}

export interface EffortResolution {
	/** Effort string to pass to the SDK, or undefined to send none. */
	effort: EffortLevel | undefined;
	/** True → pass `--thinking disabled` so CC settings.json can't re-enable thinking. */
	thinkingOff: boolean;
}

// Resolve pi's reasoning level into {effort, thinkingOff} for one model.
//   - adaptive + off/undefined → thinkingOff, effort = effortWhenOff
//   - adaptive + <level>      → effort from map or fallback table, thinking stays on
//   - non-adaptive + anything → legacy: effort from table (reasoning gates budget),
//                               thinkingOff always false
export function resolveEffort(
	modelId: string,
	reasoning: string | undefined,
	options: ResolveEffortOptions,
): EffortResolution {
	if (thinkingOffFor(modelId, reasoning)) {
		return { effort: options.effortWhenOff, thinkingOff: true };
	}
	if (!reasoning) {
		return { effort: undefined, thinkingOff: false };
	}
	const mapped = options.thinkingLevelMap?.[reasoning] as EffortLevel | undefined;
	return { effort: mapped ?? REASONING_TO_EFFORT[reasoning], thinkingOff: false };
}

// Build the thinking-related extraArgs for a CC query. The two flags are
// mutually exclusive: disabled thinking has nothing to display, and the
// summarized flag is what surfaces thinking_delta events on Opus 4.7 (whose
// default is "omitted" — empty thinking blocks). See anthropics/claude-agent-sdk-python#830.
export function buildThinkingExtraArgs(effort: EffortLevel | undefined, thinkingOff: boolean): Record<string, string> {
	if (thinkingOff) return { thinking: "disabled" };
	if (effort) return { "thinking-display": "summarized" };
	return {};
}
