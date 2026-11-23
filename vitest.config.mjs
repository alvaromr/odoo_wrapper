// The page's suite (tests/*.test.mjs) and its coverage, which the gate holds at 100 % of lines, branches and
// functions. The suites load the page's modules from disk into vm contexts (tests/page.mjs), never through
// Vite, so Vite's module runner is off: with it on, the coverage of each module would be mapped through Vite's
// transform of the file, which is not the code the harness ran, and every range after the first import would
// land on the wrong line. Off, the test files run as node runs them and the coverage reads each module as it is
// on disk.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    experimental: { viteModuleRunner: false },
    include: ["tests/*.test.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.js"],
      thresholds: { lines: 100, branches: 100, functions: 100 },
    },
  },
});
