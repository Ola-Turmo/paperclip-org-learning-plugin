import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/plugin.spec.ts"],
    environment: "node"
  }
});
