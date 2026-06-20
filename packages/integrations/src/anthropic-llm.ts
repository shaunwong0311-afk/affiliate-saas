import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient } from "./ports.js";

/**
 * Real LLM adapter (Section 8.3/8.4/8.5) using the official Anthropic SDK. Powers
 * personalization that cites the prospect's evidence, and reply intent
 * classification for the AI-SDR. The DeterministicLlm remains the default so the
 * platform runs with no API key; this swaps in when ANTHROPIC_API_KEY is set.
 *
 * Defaults to Claude Opus 4.8 with adaptive thinking, per the platform's model
 * guidance. The calls are short (personalization / classification), so they run
 * non-streaming with a modest max_tokens.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    this.model = opts.model ?? "claude-opus-4-8";
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
  }

  async complete(prompt: string, opts?: { system?: string; maxTokens?: number; json?: boolean }): Promise<string> {
    const system = opts?.json
      ? `${opts.system ?? ""}\nRespond ONLY with the requested JSON, no prose.`.trim()
      : opts?.system;

    // These are short personalization/classification calls — no extended thinking
    // needed (and omitting it keeps latency/cost down). On Opus 4.8 a request with
    // no `thinking` field simply runs without it.
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: opts?.maxTokens ?? 1024,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    });

    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
}
