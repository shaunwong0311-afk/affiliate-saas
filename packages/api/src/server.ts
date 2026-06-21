import { buildApp } from "./app.js";
import { seedDemo } from "./dev/seed.js";
import { runScheduler } from "@affiliate/recruitment";
import { createDatabaseFromEnv } from "@affiliate/db";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

async function start() {
  // Wire the real persistence: Postgres when DATABASE_URL/USE_POSTGRES is set
  // (shared across api/edge/worker), in-memory otherwise.
  const db = await createDatabaseFromEnv();
  const app = await buildApp({ db });

  // Optional: populate a demo tenant so the dashboards are not empty.
  if (process.env.SEED_DEMO === "true") {
    const creds = await seedDemo(app.appContext);
    // eslint-disable-next-line no-console
    console.log(`seeded demo tenant — login: ${creds.email} / ${creds.password}`);
  }

  // Optional: run the autonomous recruitment scheduler in-process (dev). In
  // production this runs as a separate worker against Postgres/Redis.
  if (process.env.SCHEDULER === "true") {
    const intervalMs = Number(process.env.SCHEDULER_INTERVAL_MS ?? 60_000);
    runScheduler(app.appContext, intervalMs);
    // eslint-disable-next-line no-console
    console.log(`recruitment scheduler running every ${intervalMs}ms`);
  }

  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`affiliate-platform API listening on http://${host}:${port}`);
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
