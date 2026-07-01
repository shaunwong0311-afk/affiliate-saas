/**
 * Pre-send content gate (OUTREACH-SPEC §16 #7). Every outbound email — especially unique
 * LLM-personalized bodies — is scanned for the signals that tank deliverability or read as
 * spam BEFORE it leaves. This is the per-email complement to the seed/placement test (which
 * samples infrastructure): the seed test can't see a one-off body that an LLM made spammy.
 *
 * Deterministic + pure (no I/O, no model) so it's a hard, testable guardrail. Two severities:
 * "block" (won't send — empty subject/body, egregious spam) vs "warn" (sends, but flagged).
 * An optional cheap-LLM "off-brand/spammy?" pass is layered on at the call site, never here.
 */

export interface ContentIssue {
  code: string;
  message: string;
  severity: "warn" | "block";
}

export interface ContentScanResult {
  /** False when any blocking issue is present (do not send). */
  ok: boolean;
  severity: "clean" | "warn" | "block";
  /** 0–100 spamminess estimate (heuristic, for the dashboard — not the block decision). */
  score: number;
  issues: ContentIssue[];
}

// Phrases with a strong spam signal in cold email. Multiple hits compound.
const SPAM_PHRASES = [
  "act now", "buy now", "order now", "click here", "click below", "limited time", "limited offer",
  "risk-free", "risk free", "100% free", "free money", "make money", "extra cash", "earn cash",
  "guaranteed", "guarantee", "no obligation", "no strings", "once in a lifetime", "urgent",
  "congratulations", "you have been selected", "winner", "cash bonus", "double your", "get paid",
  "this is not spam", "increase sales", "cheap", "discount", "lowest price", "best price",
  "amazing", "incredible deal", "don't miss", "why pay more", "call now", "apply now",
];
// Egregious signals that alone push toward a hard block.
const SEVERE_PATTERNS: { re: RegExp; message: string }[] = [
  { re: /\bfree money\b/i, message: "\"free money\" is a near-guaranteed spam trap" },
  { re: /\bguaranteed income\b/i, message: "\"guaranteed income\" reads as a scam signal" },
  { re: /\$\$\$|€€€/, message: "repeated currency symbols ($$$) are a classic spam marker" },
  { re: /!{3,}/, message: "3+ consecutive exclamation marks" },
  { re: /\b(viagra|crypto giveaway|nigerian prince|wire transfer)\b/i, message: "hard spam keyword" },
];

const URL_RE = /https?:\/\/[^\s<>)]+/gi;
const SHORTENER_RE = /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly)\b/i;

/** Scan an email's subject + body for spam/deliverability risks. Deterministic. */
export function scanContent(email: { subject: string; body: string }): ContentScanResult {
  const issues: ContentIssue[] = [];
  const subject = (email.subject ?? "").trim();
  const body = (email.body ?? "").trim();
  let score = 0;

  if (!subject) issues.push({ code: "empty_subject", message: "subject is empty", severity: "block" });
  if (!body) issues.push({ code: "empty_body", message: "body is empty", severity: "block" });

  if (subject.length > 90) {
    issues.push({ code: "subject_too_long", message: `subject is ${subject.length} chars (aim < 60)`, severity: "warn" });
    score += 8;
  }
  if (subject && subject === subject.toUpperCase() && /[A-Z]{4,}/.test(subject)) {
    issues.push({ code: "subject_all_caps", message: "subject is ALL CAPS", severity: "warn" });
    score += 15;
  }
  if (/^(re|fwd):/i.test(subject)) {
    issues.push({ code: "fake_reply_subject", message: "faking Re:/Fwd: in a cold email erodes trust + trips filters", severity: "warn" });
    score += 10;
  }

  const hay = `${subject}\n${body}`.toLowerCase();
  const hitPhrases = SPAM_PHRASES.filter((p) => hay.includes(p));
  if (hitPhrases.length) {
    score += hitPhrases.length * 6;
    issues.push({
      code: "spam_phrases",
      message: `spam-trigger phrase${hitPhrases.length > 1 ? "s" : ""}: ${hitPhrases.slice(0, 5).join(", ")}`,
      severity: hitPhrases.length >= 4 ? "block" : "warn",
    });
  }
  for (const sev of SEVERE_PATTERNS) {
    if (sev.re.test(hay)) {
      issues.push({ code: "severe_spam", message: sev.message, severity: "block" });
      score += 25;
    }
  }

  // Excessive links / shorteners hurt reputation.
  const links = body.match(URL_RE) ?? [];
  if (links.length > 8) {
    issues.push({ code: "too_many_links", message: `${links.length} links (keep it to 1–2 in a cold email)`, severity: "block" });
    score += 20;
  } else if (links.length > 3) {
    issues.push({ code: "many_links", message: `${links.length} links may hurt deliverability`, severity: "warn" });
    score += 10;
  }
  if (links.some((l) => SHORTENER_RE.test(l))) {
    issues.push({ code: "link_shortener", message: "URL shorteners are heavily filtered — use full links", severity: "warn" });
    score += 12;
  }

  // Very short bodies read as bulk blasts; extremely long ones as newsletters.
  const words = body.split(/\s+/).filter(Boolean).length;
  if (body && words < 15) {
    issues.push({ code: "body_too_short", message: `body is only ${words} words — reads as a bulk blast`, severity: "warn" });
    score += 8;
  }
  if (words > 400) {
    issues.push({ code: "body_too_long", message: `body is ${words} words — cold emails convert far better short`, severity: "warn" });
    score += 6;
  }

  // Excessive capitalization across the body.
  const letters = body.replace(/[^a-zA-Z]/g, "");
  if (letters.length > 40) {
    const capsRatio = (body.replace(/[^A-Z]/g, "").length) / letters.length;
    if (capsRatio > 0.35) {
      issues.push({ code: "excessive_caps", message: "excessive capitalization", severity: "warn" });
      score += 12;
    }
  }
  // Excessive exclamation across the whole email.
  const bangs = (hay.match(/!/g) ?? []).length;
  if (bangs >= 4) {
    issues.push({ code: "excessive_exclamation", message: `${bangs} exclamation marks`, severity: "warn" });
    score += 10;
  }

  const hasBlock = issues.some((i) => i.severity === "block");
  const severity: ContentScanResult["severity"] = hasBlock ? "block" : issues.length ? "warn" : "clean";
  return { ok: !hasBlock, severity, score: Math.min(100, score), issues };
}
