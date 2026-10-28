import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.spec.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
    resolve: {
      alias: {
        "@/": path.resolve(__dirname, "./src"),
      },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        "tests",
        "*.config.ts",
        "*.config.js",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
