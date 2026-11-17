import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Some engine tests run whole strategies; shared CI runners need more than the 5-second default.
    testTimeout: 30_000,
  },
});
