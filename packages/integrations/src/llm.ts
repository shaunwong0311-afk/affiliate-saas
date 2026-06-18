import { createHash } from "node:crypto";
import type { Embedder, LlmClient } from "./ports.js";

/**
 * Deterministic, dependency-free intelligence layer (Section 11). In production
 * these are swapped for a real Claude/OpenAI client and an embeddings model. The
 * stubs are genuinely useful: the embedder produces a stable vector from text so
 * relevance similarity actually varies with content, and the LLM does
 * template-fill personalization and keyword-grounded reply classification.
 */

const DIM = 256;

/** A hashing embedder: stable per-text vectors, real cosine similarity. */
export class HashingEmbedder implements Embedder {
  readonly model = "hashing-embedder-v1";

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text);
  }

  embedSync(text: string): number[] {
    const vec = new Array<number>(DIM).fill(0);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const h = createHash("md5").update(tok).digest();
      const idx = h.readUInt16BE(0) % DIM;
      const sign = (h[2]! & 1) === 0 ? 1 : -1;
      vec[idx]! += sign;
    }
    return l2normalize(vec);
  }

  async similarity(a: string, b: string): Promise<number> {
    const va = this.embedSync(a);
    const vb = this.embedSync(b);
    return Math.max(0, cosine(va, vb));
  }
}

/** A deterministic LLM stand-in for personalization + reply classification. */
export class DeterministicLlm implements LlmClient {
  readonly model = "deterministic-llm-v1";

  async complete(prompt: string, opts?: { system?: string; maxTokens?: number; json?: boolean }): Promise<string> {
    if (opts?.json || /classify/i.test(prompt)) {
      return JSON.stringify({ classification: classifyReply(prompt) });
    }
    // Otherwise echo a constrained, template-style personalization.
    return renderTemplate(prompt);
  }
}

/** Keyword-grounded reply classifier (Section 8.5). */
export function classifyReply(text: string): string {
  const t = text.toLowerCase();
  if (/\b(unsubscribe|remove me|stop emailing|opt out)\b/.test(t)) return "unsubscribe";
  if (/\b(out of office|on vacation|away until|auto[- ]?reply)\b/.test(t)) return "out_of_office";
  if (/\b(not interested|no thanks|not a fit|please stop|already partnered)\b/.test(t)) return "not_interested";
  if (/\b(how much|what.s the rate|commission|tell me more|interested|sounds good|let.s talk|sign me up)\b/.test(t))
    return "interested";
  if (/\?\s*$/.test(text.trim()) || /\b(question|wondering|can you|do you)\b/.test(t)) return "question";
  return "unknown";
}

/**
 * Personalization (Section 8.4). Template-constrained, references the prospect's
 * content + the merchant's offer. Tokens: {{name}} {{merchant}} {{offer}}
 * {{commission}} {{angle}}. Real impl uses an LLM; this fills tokens to keep the
 * merchant's voice and avoid AI-cold-email tells.
 */
export function renderTemplate(template: string, tokens: Record<string, string> = {}): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => tokens[key] ?? `{{${key}}}`);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // both already L2-normalized
}
