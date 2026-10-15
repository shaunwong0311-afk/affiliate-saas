import { describe, it, expect } from "vitest";
import { canTransition, transition, IllegalTransitionError } from "../src/index.js";

/**
 * AUDIT-2026-10 O1/O3 — the send path returns a first touch that could not be sent from
 * `queued` to `scored` (so it is retried, never stranded in `queued`). The state machine
 * said that move was illegal; it now describes what the engine does.
 */
describe("prospect state machine — the send path", () => {
  it("a first touch that could not be sent goes back to scored", () => {
    expect(canTransition("queued", "scored")).toBe(true);
    expect(transition("queued", "scored")).toBe("scored");
  });

  it("still forbids the moves a retry must never make", () => {
    // Nothing un-sends: a contacted prospect cannot go back to queued or scored.
    expect(canTransition("contacted", "queued")).toBe(false);
    expect(canTransition("contacted", "scored")).toBe(false);
    expect(() => transition("in_sequence", "scored")).toThrow(IllegalTransitionError);
    // Terminal states stay terminal — a reply or a retry cannot reopen them.
    for (const terminal of ["converted", "suppressed", "bounced", "dead"] as const) {
      expect(canTransition(terminal, "queued")).toBe(false);
      expect(canTransition(terminal, "contacted")).toBe(false);
    }
    // Suppression and bounce remain universal exits from every active state.
    for (const active of ["scored", "queued", "contacted", "in_sequence", "replied"] as const) {
      expect(canTransition(active, "suppressed")).toBe(true);
      expect(canTransition(active, "bounced")).toBe(true);
    }
  });
});
