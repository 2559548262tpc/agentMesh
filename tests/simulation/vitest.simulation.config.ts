import { defineConfig } from "vitest/config";

/**
 * M1 fake-vendor simulation suite (ROADMAP_v0.4 M1).
 *
 * Runs as a separate vitest pass (`npm run test:simulation`) so the default
 * `npm test` stays fast. Scenario files use the `*.sim.ts` suffix, which
 * matches neither vitest.config.ts (star-star slash star.test.ts) nor
 * vitest.integ.config.ts (star-star slash star.integ.ts), so neither existing
 * run needs to exclude this directory.
 *
 * This config lives under tests/ (not the repo root) so it is covered by the
 * existing tsconfig `tests/**` include for typecheck and typed lint without
 * touching tsconfig.json.
 */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    environment: "node",
    // Scenarios spawn real vendor-child processes and drive watchdog sweeps;
    // serial files keep process accounting deterministic on Windows.
    fileParallelism: false,
    include: ["**/*.sim.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
