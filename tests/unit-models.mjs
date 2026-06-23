/**
 * Tests for MODELS construction + resolveModel.
 * Pins: opus shortcut resolves to whichever opus is first in MODEL_IDS_IN_ORDER,
 * projection strips pi-ai's baseUrl/api/provider/headers, and ordering is preserved.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_IDS_IN_ORDER, applyLongContext, applyOneMDisplayNames, buildModels, buildThinkingExtraArgs, claudeCodeModelId, defaultAskClaudeReasoning, isAdaptiveModel, resolveEffort, resolveModel, thinkingOffFor } from "../src/models.js";

// Simulated pi-ai registry entry — extra fields mimic the ones pi-ai exposes
// that must not leak into the provider-registered MODELS array.
const mockPiAiModel = (id) => ({
	id, name: id, reasoning: true, input: ["text"], cost: { input: 1, output: 1 },
	contextWindow: 200000, maxTokens: 8000,
	// Leaky fields that should be stripped by the projection:
	baseUrl: "https://api.anthropic.com", api: "anthropic", provider: "anthropic",
	headers: { "x-api-key": "LEAK" },
});

describe("MODELS projection", () => {
	it("strips baseUrl/api/provider/headers", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.equal(m.baseUrl, undefined);
			assert.equal(m.api, undefined);
			assert.equal(m.provider, undefined);
			assert.equal(m.headers, undefined);
		}
	});

	it("preserves MODEL_IDS_IN_ORDER ordering", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
	});

	it("silently drops IDs missing from pi-ai (no fallback)", () => {
		// Only haiku present — opus/sonnet vanish from picker.
		const models = buildModels([mockPiAiModel("claude-haiku-4-5")]);
		assert.deepEqual(models.map((m) => m.id), ["claude-haiku-4-5"]);
	});

	it("zeros out cost regardless of pi-ai pricing", () => {
		const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));
		for (const m of models) {
			assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		}
	});

	it("leaves display names bare before plan-specific context is applied", () => {
		const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });
		const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		assert.deepEqual(models.map((m) => m.id), MODEL_IDS_IN_ORDER);
		assert.ok(models.every((m) => !m.name.includes("1M")));
	});
});

describe("claudeCodeModelId", () => {
	const oneMModel = { id: "claude-opus-4-8", contextWindow: 1000000 };
	const twoHundredKModel = { id: "claude-haiku-4-5", contextWindow: 200000 };

	it("appends [1m] only when opted in AND 1M-capable", () => {
		assert.equal(claudeCodeModelId(oneMModel, true), "claude-opus-4-8[1m]");
	});

	it("stays bare when capable but not opted in (default)", () => {
		assert.equal(claudeCodeModelId(oneMModel, false), "claude-opus-4-8");
	});

	it("stays bare when opted in but only 200K-capable (Haiku)", () => {
		assert.equal(claudeCodeModelId(twoHundredKModel, true), "claude-haiku-4-5");
	});

	it("does not double-suffix an id that already contains [1m]", () => {
		assert.equal(claudeCodeModelId({ id: "claude-opus-4-8[1m]", contextWindow: 1000000 }, true), "claude-opus-4-8[1m]");
	});
});

describe("applyLongContext (registered contextWindow)", () => {
	const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });
	const models = buildModels(MODEL_IDS_IN_ORDER.map(oneM));

	it("plan pro (default): caps unlisted long-context models to 200K", () => {
		const registered = applyLongContext(models, new Set(), "pro");
		for (const m of registered) {
			assert.equal(m.contextWindow, 200000, `${m.id} should register at 200K`);
		}
		// Does not mutate the source table used for id resolution.
		assert.equal(models.find((m) => m.id === "claude-opus-4-8").contextWindow, 1000000);
	});

	it("keeps 1M for opted-in long-context models (matches the [1m] CLI id)", () => {
		const registered = applyLongContext(models, new Set(["claude-opus-4-8", "claude-sonnet-4-6"]), "pro");
		assert.equal(registered.find((m) => m.id === "claude-opus-4-8").contextWindow, 1000000);
		assert.equal(registered.find((m) => m.id === "claude-sonnet-4-6").contextWindow, 1000000);
		// Unlisted long-context siblings stay capped.
		assert.equal(registered.find((m) => m.id === "claude-opus-4-7").contextWindow, 200000);
	});

	it("plan max: registers unlisted Opus at 1M (CC auto-upgrades bare id, no [1m])", () => {
		const registered = applyLongContext(models, new Set(), "max");
		for (const id of ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]) {
			assert.equal(registered.find((m) => m.id === id).contextWindow, 1000000, `${id} should register at 1M on max`);
		}
	});

	it("plan max: Sonnet still caps at 200K (no auto-upgrade, needs explicit [1m])", () => {
		const registered = applyLongContext(models, new Set(), "max");
		assert.equal(registered.find((m) => m.id === "claude-sonnet-4-6").contextWindow, 200000);
	});

	it("plan max does not append [1m] (decoupled from longContextExtraUsage, avoids #39841)", () => {
		// Unlisted Opus on max registers 1M but the CLI id stays bare — only
		// longContextExtraUsage membership drives the [1m] suffix, never plan.
		const opus = applyLongContext(models, new Set(), "max").find((m) => m.id === "claude-opus-4-8");
		assert.equal(claudeCodeModelId(opus, false), "claude-opus-4-8");
	});

	it("leaves Haiku (200K native) at 200K whether listed or not", () => {
		const bare200K = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel)); // haiku=200K
		assert.equal(applyLongContext(bare200K, new Set(["claude-haiku-4-5"]), "max").find((m) => m.id === "claude-haiku-4-5").contextWindow, 200000);
		assert.equal(applyLongContext(bare200K, new Set(), "pro").find((m) => m.id === "claude-haiku-4-5").contextWindow, 200000);
	});
});

describe("applyOneMDisplayNames", () => {
	const modelWithRealisticWindows = (id) => ({
		...mockPiAiModel(id),
		contextWindow: id.includes("haiku") ? 200000 : 1000000,
	});
	const models = buildModels(MODEL_IDS_IN_ORDER.map(modelWithRealisticWindows));

	it("labels Max-plan Opus display names as 1M", () => {
		const registered = applyOneMDisplayNames(applyLongContext(models, new Set(), "max"));
		assert.equal(registered.find((m) => m.id === "claude-opus-4-8").name, "claude-opus-4-8 1M");
		assert.equal(registered.find((m) => m.id === "claude-sonnet-4-6").name, "claude-sonnet-4-6");
		assert.equal(registered.find((m) => m.id === "claude-haiku-4-5").name, "claude-haiku-4-5");
	});

	it("labels explicit long-context extra-usage display names as 1M", () => {
		const registered = applyOneMDisplayNames(applyLongContext(models, new Set(["claude-sonnet-4-6"]), "pro"));
		assert.equal(registered.find((m) => m.id === "claude-sonnet-4-6").name, "claude-sonnet-4-6 1M");
		assert.equal(registered.find((m) => m.id === "claude-opus-4-8").name, "claude-opus-4-8");
	});
});

describe("resolveModel", () => {
	const models = buildModels(MODEL_IDS_IN_ORDER.map(mockPiAiModel));

	it("opus shortcut resolves to claude-opus-4-8 (first opus in order)", () => {
		assert.equal(resolveModel(models, "opus")?.id, "claude-opus-4-8");
	});

	it("haiku shortcut resolves to claude-haiku-4-5", () => {
		assert.equal(resolveModel(models, "haiku")?.id, "claude-haiku-4-5");
	});

	it("full ID resolves to itself", () => {
		assert.equal(resolveModel(models, "claude-opus-4-6")?.id, "claude-opus-4-6");
	});

	it("returns undefined when no match", () => {
		assert.equal(resolveModel(models, "gpt-9"), undefined);
	});

	it("returns the matched model object for CLI-arg conversion", () => {
		const oneM = (id) => ({ ...mockPiAiModel(id), contextWindow: 1000000 });
		const oneMModels = buildModels(MODEL_IDS_IN_ORDER.map(oneM));
		const model = resolveModel(oneMModels, "opus");
		assert.equal(model.id, "claude-opus-4-8");
		// Opted in → [1m] applied at the CLI boundary.
		assert.equal(claudeCodeModelId(model, true), "claude-opus-4-8[1m]");
		// Default (not opted in) → bare.
		assert.equal(claudeCodeModelId(model, false), "claude-opus-4-8");
	});
});

describe("isAdaptiveModel", () => {
	it("flags Opus 4.6/4.7/4.8 and Sonnet 4.6 as adaptive", () => {
		for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"]) {
			assert.equal(isAdaptiveModel(id), true, `${id} should be adaptive`);
		}
	});

	it("excludes Haiku (budget-based thinking, no effort knob)", () => {
		assert.equal(isAdaptiveModel("claude-haiku-4-5"), false);
	});

	it("rejects unknown ids", () => {
		assert.equal(isAdaptiveModel("gpt-9"), false);
		assert.equal(isAdaptiveModel("claude-opus-4-9"), false);
	});
});

describe("defaultAskClaudeReasoning", () => {
	it("adaptive models default to high (safe across 4.6/4.7/4.8; avoids xhigh→max on 4.6)", () => {
		for (const id of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-sonnet-4-6"]) {
			assert.equal(defaultAskClaudeReasoning(id), "high", `${id} should default to high`);
		}
	});

	it("haiku defaults to undefined (no effort knob — send nothing, let CC pick)", () => {
		assert.equal(defaultAskClaudeReasoning("claude-haiku-4-5"), undefined);
	});

	it("unknown models default to undefined (safe — may not support effort)", () => {
		assert.equal(defaultAskClaudeReasoning("gpt-9"), undefined);
		assert.equal(defaultAskClaudeReasoning("claude-opus-4-9"), undefined);
	});
});

describe("thinkingOffFor", () => {
	it("adaptive + undefined (pi slider off) → true", () => {
		assert.equal(thinkingOffFor("claude-opus-4-7", undefined), true);
	});

	it("adaptive + literal \"off\" (AskClaude explicit) → true", () => {
		assert.equal(thinkingOffFor("claude-opus-4-8", "off"), true);
	});

	it("adaptive + a real level → false", () => {
		assert.equal(thinkingOffFor("claude-opus-4-7", "high"), false);
		assert.equal(thinkingOffFor("claude-sonnet-4-6", "xhigh"), false);
	});

	it("non-adaptive (haiku) never reports off — reasoning gates its budget thinking", () => {
		assert.equal(thinkingOffFor("claude-haiku-4-5", undefined), false);
		assert.equal(thinkingOffFor("claude-haiku-4-5", "off"), false);
	});

	it("unknown model → false", () => {
		assert.equal(thinkingOffFor("gpt-9", undefined), false);
	});
});

describe("resolveEffort", () => {
	const off = (modelId, reasoning, opts = {}) =>
		resolveEffort(modelId, reasoning, { effortWhenOff: "high", ...opts });

	it("adaptive + off → thinkingOff with effortWhenReasoningOff", () => {
		assert.deepEqual(off("claude-opus-4-7", "off"), { effort: "high", thinkingOff: true });
	});

	it("adaptive + undefined (pi slider off) → same as explicit off", () => {
		assert.deepEqual(off("claude-opus-4-7", undefined), { effort: "high", thinkingOff: true });
	});

	it("respects a custom effortWhenOff", () => {
		assert.deepEqual(off("claude-opus-4-7", "off", { effortWhenOff: "xhigh" }), { effort: "xhigh", thinkingOff: true });
	});

	it("adaptive + xhigh prefers the model thinkingLevelMap (opus-4-7 → xhigh, opus-4-6 → max)", () => {
		assert.equal(off("claude-opus-4-7", "xhigh", { thinkingLevelMap: { xhigh: "xhigh" } }).effort, "xhigh");
		assert.equal(off("claude-opus-4-6", "xhigh", { thinkingLevelMap: { xhigh: "max" } }).effort, "max");
		assert.equal(off("claude-opus-4-7", "xhigh", { thinkingLevelMap: { xhigh: "xhigh" } }).thinkingOff, false);
	});

	it("adaptive + xhigh with no map falls back to the table (max)", () => {
		// Sonnet 4.6 ships no thinkingLevelMap; table maps xhigh → max.
		assert.equal(off("claude-sonnet-4-6", "xhigh").effort, "max");
	});

	it("adaptive + low/medium/high fall through to the table", () => {
		assert.equal(off("claude-opus-4-7", "low").effort, "low");
		assert.equal(off("claude-opus-4-7", "medium").effort, "medium");
		assert.equal(off("claude-opus-4-7", "high").effort, "high");
	});

	it("adaptive + minimal → low (table fallback, no hidden tier)", () => {
		assert.equal(off("claude-opus-4-7", "minimal").effort, "low");
		assert.equal(off("claude-opus-4-7", "minimal").thinkingOff, false);
	});

	it("haiku + undefined → no effort, thinkingOff false (legacy)", () => {
		assert.deepEqual(off("claude-haiku-4-5", undefined), { effort: undefined, thinkingOff: false });
	});

	it("haiku + a level → table effort, thinkingOff false (legacy)", () => {
		assert.deepEqual(off("claude-haiku-4-5", "high"), { effort: "high", thinkingOff: false });
	});
});

describe("buildThinkingExtraArgs", () => {
	it("thinkingOff → --thinking disabled (and no display flag)", () => {
		assert.deepEqual(buildThinkingExtraArgs("high", true), { thinking: "disabled" });
	});

	it("effort set, thinkingOff false → summarized display", () => {
		assert.deepEqual(buildThinkingExtraArgs("high", false), { "thinking-display": "summarized" });
	});

	it("no effort, thinkingOff false → empty (CC picks its default)", () => {
		assert.deepEqual(buildThinkingExtraArgs(undefined, false), {});
	});

	it("thinkingOff wins over effort (disabled has nothing to display)", () => {
		assert.deepEqual(buildThinkingExtraArgs("xhigh", true), { thinking: "disabled" });
	});
});
