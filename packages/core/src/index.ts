// ---- Money & primitives -----------------------------------------------------
export * from "./money.js";
export * from "./ids.js";

// ---- Domain types -----------------------------------------------------------
export * from "./types/common.js";
export * from "./types/identity.js";
export * from "./types/program.js";
export * from "./types/orders.js";
export * from "./types/ledger.js";

// ---- Commission engine seam -------------------------------------------------
export * from "./engine/types.js";
export * from "./engine/rules.js";
export { AffiliateEngine } from "./engine/affiliate-engine.js";
export { MlmEngineStub, NotImplementedError } from "./engine/mlm-engine.js";
export { EngineRegistry, defaultEngineRegistry } from "./engine/registry.js";

// ---- Ledger -----------------------------------------------------------------
export * from "./ledger/ledger.js";

// ---- Attribution ------------------------------------------------------------
export * from "./attribution/attribution.js";

// ---- Fraud ------------------------------------------------------------------
export * from "./fraud/fraud.js";

// ---- Security ---------------------------------------------------------------
export * from "./security/postback.js";

// ---- Recruitment (pure pieces) ----------------------------------------------
export * from "./recruitment/scoring.js";
export * from "./recruitment/state-machine.js";
export * from "./recruitment/affiliate-detection.js";

// ---- Creator identity graph (profile-graph plan) ----------------------------
export * from "./profile/identity.js";
