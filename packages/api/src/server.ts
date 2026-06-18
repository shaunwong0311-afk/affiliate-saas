import { buildApp } from "./app.js";
import { seedDemo } from "./dev/seed.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";

async function start() {
  const app = await buildApp();

  // Optional: populate a demo tenant so the dashboards are not empty.
  if (process.env.SEED_DEMO === "true") {
    const creds = await seedDemo(app.appContext);
    // eslint-disable-next-line no-console
    console.log(`seeded demo tenant — login: ${creds.email} / ${creds.password}`);
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
