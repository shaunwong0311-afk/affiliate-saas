import type { EngineKind } from "../types/common.js";
import type { CommissionEngine } from "./types.js";
import { AffiliateEngine } from "./affiliate-engine.js";
import { MlmEngineStub } from "./mlm-engine.js";

/**
 * Routes an offer to its commission engine via the `engine` field (Section 10).
 * The substrate looks up the engine here; nothing else knows which engine ran.
 */
export class EngineRegistry {
  private readonly engines = new Map<string, CommissionEngine>();

  constructor(engines?: CommissionEngine[]) {
    for (const e of engines ?? [new AffiliateEngine(), new MlmEngineStub()]) {
      this.engines.set(e.kind, e);
    }
  }

  get(kind: EngineKind | string): CommissionEngine {
    const engine = this.engines.get(kind);
    if (!engine) throw new Error(`no commission engine registered for "${kind}"`);
    return engine;
  }

  register(engine: CommissionEngine): void {
    this.engines.set(engine.kind, engine);
  }
}

export const defaultEngineRegistry = new EngineRegistry();
