import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "tests/e2e/**"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/cli.ts",
        "src/commands/**",
        "src/engine/browser.ts",
        "src/engine/collect.ts",
        "src/engine/flows.ts",
        "src/server/**",
        "**/*.test.ts",
        "**/*.d.ts",
      ],
    },
  },
});
