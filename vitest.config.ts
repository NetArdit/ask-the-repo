import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Two workers: on a 4 GB machine more of them have run a worker out of memory mid-run, which loses that file's tests.
    maxWorkers: 2,
    // The same flag the server runs with (package.json, Dockerfile). Without it V8 tiers up the WASM grammars and a worker can
    // die with "Fatal process out of memory: Zone" (reports/phase2-report.md).
    execArgv: ["--liftoff-only"],
  },
});
