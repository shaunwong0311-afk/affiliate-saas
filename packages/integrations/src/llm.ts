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

/** Words a short "stop" line may be made of — "STOP please", "pls unsubscribe me, thanks". */
const STOP_LINE_WORDS =
  "please|pls|plz|kindly|stop|unsubscribe|remove|me|us|from|your|the|this|that|these|list|mailing|e-?mails?|e-?mailing|sending|contacting|messaging|messages?|thanks|thank|you|thx|ty|now|immediately|all|further|any|more|it|opt|out|of|off|take|hi|hello";
const STOP_LINE = new RegExp(`^[\\W_]*(?:(?:${STOP_LINE_WORDS})\\b[\\W_]*){1,9}$`, "i");
const STOP_TRIGGER = /\b(stop|unsubscribe|remove me|opt(?: me)? out|take me off)\b/i;
/**
 * Sentences in which the WRITER asks to be left alone. Deliberately narrow: a missed opt-out
 * still reaches a person (anything unrecognized goes to human review, and the sequence stops
 * on any reply), whereas a false one would suppress a warm lead — so phrases that merely
 * look alike are excluded ("please stop me if…", "get us off to a good start", "don't message
 * me on Instagram", "remove me from the cc").
 */
const OPT_OUT_REQUESTS: RegExp[] = [
  /\b(unsubscribe|remove|delete)\s+(me|us|my (e-?mail|address|name)|this (e-?mail|address))\b(?!\s+from\s+(the\s+)?(cc|thread|chain|loop))/i,
  /\b(take|get)\s+(me|us)\s+off(?=\s+(of\s+)?(your|this|the|that|these|all|any)\b|\s*[.!,;]|\s*$)/im,
  /\bopt\s+(me|us)\s+out\b/i,
  /\bstop\s+(e-?mailing|contacting|sending|spamming|bothering)\b/i,
  /\b(please|pls|kindly)\s+stop(?=\s*[.!,;]|\s*$|\s+(e-?mail|contact|send|this\b|these\b|it\b|now\b|all\b))/im,
  /\b(do not|don'?t|never)\s+(e-?mail|contact)\s+(me|us)\b(?!\s+(on|by|via|through|at)\b)/i,
  /\b(i want|i'd like|i would like|i wish|please|pls|kindly)\s+(to\s+)?(unsubscribe|opt[- ]?out|be removed|be taken off)\b(?!\s+(here|at|by|using|via|below|from (this|our|the)|with|through|any ?time|link))/i,
  /\bno (more|further) (e-?mails?|messages|contact)\b/i,
  /\bleave (me|us) alone\b/i,
];

/**
 * True when the sender's own words ASK to be removed. Honors the footer-advertised opt-out
 * deterministically — a line that is just a stop phrase ("STOP", "Stop please", "unsubscribe
 * me, thanks"), anywhere in the reply — plus an explicit request inside a sentence. It does
 * NOT fire on the mere word "unsubscribe": that is in the footer of every newsletter, and
 * matching it anywhere used to suppress prospects on their own mailing-list mail.
 */
export function isUnsubscribeRequest(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (l && l.length <= 80 && STOP_LINE.test(l) && STOP_TRIGGER.test(l)) return true;
  }
  return OPT_OUT_REQUESTS.some((re) => re.test(text));
}

/** Keyword-grounded reply classifier (Section 8.5). */
export function classifyReply(text: string): string {
  const t = text.toLowerCase();
  // An opt-out request always wins — whatever else the reply says, whatever any LLM would say.
  if (isUnsubscribeRequest(text)) return "unsubscribe";
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
