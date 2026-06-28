import type { LlmClient } from "./ports.js";

/**
 * A minimal OpenAI-Chat-Completions-compatible LLM client (no SDK dependency — plain
 * `fetch`). The Chat Completions shape is a de-facto standard, so ONE adapter targets
 * many cheap/fast providers just by changing `baseUrl` + `model`:
 *   - xAI Grok   → baseUrl "https://api.x.ai/v1",        model "grok-4-fast-non-reasoning"
 *   - Groq       → baseUrl "https://api.groq.com/openai/v1", model "llama-3.3-70b-versatile"
 *   - OpenAI     → baseUrl "https://api.openai.com/v1",   model "gpt-4o-mini"
 *   - DeepSeek / OpenRouter / Together → their respective base URLs
 * Used for cheap, high-volume jobs like relevance scoring where a fast budget model is
 * plenty and ~5× cheaper than a frontier model. Returns "" on any failure (callers
 * treat empty as "no signal", never invent).
 */
export class OpenAiCompatibleLlmClient implements LlmClient {
  readonly model: string;
  constructor(private readonly opts: { apiKey: string; baseUrl: string; model: string; timeoutMs?: number }) {
    this.model = opts.model;
  }

  async complete(prompt: string, opts?: { system?: string; maxTokens?: number; json?: boolean }): Promise<string> {
    const system = opts?.json ? `${opts?.system ?? ""}\nRespond ONLY with the requested JSON, no prose.`.trim() : opts?.system;
    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: prompt });

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 15000);
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts?.maxTokens ?? 1024,
          messages,
          ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      const json: any = await res.json().catch(() => null);
      return json?.choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    } finally {
      clearTimeout(t);
    }
  }
}
