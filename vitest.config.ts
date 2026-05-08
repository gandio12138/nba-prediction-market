import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "__tests__/**/*.test.ts",
      "strategies/**/__tests__/**/*.test.ts",
    ],
    exclude: ["nba-momentum/**", "node_modules/**", "dist/**"],
    passWithNoTests: true,
  },
});
