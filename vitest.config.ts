import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "packages/web/**"],
    environment: "node",
    globals: false,
    passWithNoTests: false,
  },
});
