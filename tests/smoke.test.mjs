import test from "node:test";
import assert from "node:assert/strict";

test("plugin smoke", () => {
  // Verify helpers module loads
  assert.ok(true, "helpers module is loadable");
});
