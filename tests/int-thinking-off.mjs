#!/usr/bin/env node
// End-to-end check that the bridge's thinking-off path actually suppresses
// reasoning blocks, and that a real reasoning level produces them.
//
// Calls the Claude Agent SDK `query()` directly with the bridge's option
// shape (effort + extraArgs from resolveEffort/buildThinkingExtraArgs), then
// inspects the streamed assistant content for `thinking` blocks. This is the
// only layer that proves CC honors `--thinking disabled` — the bridge log and
// extraArgs only show what we passed in, not what ran.
//
// off-direction is deterministic (disabled => no thinking blocks). The
// on-direction uses a reasoning-prompt; a real model can in principle skip
// thinking on a trivial prompt, but "multiply 17 by 23 and explain each step"
// reliably triggers it on Opus.
//
// Requires: ANTHROPIC_API_KEY or CC logged in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolveEffort, buildThinkingExtraArgs } from "../src/models.js";

const CWD = process.cwd();
// Opus 4.7: adaptive-thinking, ships { xhigh: "xhigh" } — a known-good adaptive
// model for exercising the thinking-on/off paths end-to-end.
const MODEL = "claude-opus-4-7";
const REASONING_PROMPT = "Compute 247 × 389 by hand using long multiplication, showing each partial product. Then verify the result a second way (for example 247 × 400 − 247 × 11) and confirm both match.";
const TIMEOUT = 120_000;

function optionsFor(reasoning) {
	const { effort, thinkingOff } = resolveEffort(MODEL, reasoning, {
		effortWhenOff: "high",
		thinkingLevelMap: { xhigh: "xhigh" },
	});
	return {
		cwd: CWD,
		env: { ...process.env, DISABLE_AUTO_COMPACT: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "0" },
		permissionMode: "bypassPermissions",
		model: MODEL,
		systemPrompt: { type: "preset", preset: "claude_code" },
		extraArgs: { "strict-mcp-config": null, ...buildThinkingExtraArgs(effort, thinkingOff) },
		...(effort ? { effort } : {}),
	};
}

async function countThinkingBlocks(reasoning) {
	let thinkingBlocks = 0;
	let text = "";
	const q = query({ prompt: REASONING_PROMPT, options: optionsFor(reasoning) });
	for await (const m of q) {
		if (m.type !== "assistant") continue;
		for (const block of m.message?.content ?? []) {
			if (block.type === "thinking") thinkingBlocks++;
			else if (block.type === "text") text += block.text;
		}
	}
	return { thinkingBlocks, text: text.trim() };
}

test("reasoning=off emits no thinking blocks", { timeout: TIMEOUT }, async () => {
	const { thinkingBlocks, text } = await countThinkingBlocks("off");
	assert.equal(thinkingBlocks, 0, `expected no thinking blocks with reasoning=off, got ${thinkingBlocks}`);
	assert.ok(text.length > 0, "expected a text response");
});

test("reasoning=high emits thinking blocks", { timeout: TIMEOUT }, async () => {
	const { thinkingBlocks, text } = await countThinkingBlocks("high");
	assert.ok(thinkingBlocks > 0, `expected thinking blocks with reasoning=high, got ${thinkingBlocks} (text: ${text.slice(0, 80)})`);
});
