/**
 * Per-prospect state machine (Section 8.7). Pure transition rules so the
 * orchestrator (queue + workers, in the recruitment package) can validate every
 * move and so transitions are unit-testable without any infrastructure.
 *
 *   discovered → enriched → scored → queued → contacted → in_sequence → replied → converted
 *   terminal: dead, suppressed, bounced
 */
export type ProspectState =
  | "discovered"
  | "enriched"
  | "scored"
  | "queued"
  | "contacted"
  | "in_sequence"
  | "replied"
  | "converted"
  | "dead"
  | "suppressed"
  | "bounced";

export const TERMINAL_STATES: ReadonlySet<ProspectState> = new Set([
  "converted",
  "dead",
  "suppressed",
  "bounced",
]);

/**
 * Allowed transitions. Suppression and bounce can happen from almost anywhere
 * (a global unsubscribe or hard bounce overrides the pipeline), so they are added
 * as universal exits below.
 */
const TRANSITIONS: Record<ProspectState, ProspectState[]> = {
  discovered: ["enriched", "dead"],
  enriched: ["scored", "dead"],
  scored: ["queued", "dead"],
  queued: ["contacted", "dead"],
  contacted: ["in_sequence", "replied", "dead"],
  in_sequence: ["replied", "contacted", "dead"], // contacted = next sequence step sent
  replied: ["converted", "in_sequence", "dead"], // a reply may be re-sequenced or close
  converted: [],
  dead: [],
  suppressed: [],
  bounced: [],
};

/** States from which a hard suppression/bounce/unsubscribe may exit the pipeline. */
const UNIVERSAL_EXITS: ProspectState[] = ["suppressed", "bounced"];
const ACTIVE_STATES: ProspectState[] = [
  "discovered",
  "enriched",
  "scored",
  "queued",
  "contacted",
  "in_sequence",
  "replied",
];

export function canTransition(from: ProspectState, to: ProspectState): boolean {
  if (from === to) return false;
  if (UNIVERSAL_EXITS.includes(to) && ACTIVE_STATES.includes(from)) return true;
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: ProspectState,
    public readonly to: ProspectState,
  ) {
    super(`illegal prospect transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function transition(from: ProspectState, to: ProspectState): ProspectState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

export function isTerminal(state: ProspectState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The next "happy path" state for a prospect, or null if terminal/branching. */
export function happyPathNext(state: ProspectState): ProspectState | null {
  const map: Partial<Record<ProspectState, ProspectState>> = {
    discovered: "enriched",
    enriched: "scored",
    scored: "queued",
    queued: "contacted",
    contacted: "in_sequence",
  };
  return map[state] ?? null;
}
