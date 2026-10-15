import { createDatabaseFromEnv } from "@affiliate/db";
import { registerWorkers, buildQueue, runScheduler } from "@affiliate/recruitment";
import { createContext } from "./context.js";

/**
 * Standalone worker entrypoint (`npm run worker` / the docker-compose worker service).
 * Builds the SAME fully-wired AppContext as the API — env-gated discovery sources, real
 * mailbox resolver + secret store, IMAP reply poller, enrichers, notifier, transactional
 * ESP — so the production scheduler has identical capabilities to the API-embedded one.
 * (The old recruitment-package entrypoint built a mock/synthetic dependency set: sends
 * went to the mock sender and were still recorded as sent — see AUDIT-2026-07 T0.)
 */
async function main(): Promise<void> {
  const db = await createDatabaseFromEnv();
  const ctx = createContext({ db });
  const queue = buildQueue();
  registerWorkers(queue, ctx);
  // Each tick reads every mailbox for replies/bounces and then sends for each merchant
  // (isolated per merchant; failures are logged and recorded, never swallowed). Sourcing runs
  // on its own per-merchant interval (default daily), not on this one.
  // A blank or non-numeric value must not become a 0 ms loop.
  const rawInterval = Number(process.env.SCHEDULER_INTERVAL_MS);
  const handle = runScheduler(ctx, Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 60_000);
  const drain = setInterval(
    () =>
      void queue.drain().catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[worker] stage queue drain failed:", err);
      }),
    5_000,
  );
  // eslint-disable-next-line no-console
  console.log("recruitment worker running (scheduler + stage queue, full app wiring)");
  const shutdown = () => {
    handle.stop();
    clearInterval(drain);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
