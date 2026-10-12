import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveryOutcome } from "../delivery.js";

test("authenticated delivery requires explicit transaction and receiver success", () => {
  assert.equal(deliveryOutcome("authenticated", true, "success"), "receiver reported success; independently verify authenticated onchain acceptance");
  for (const status of ["unknown", "reverted"] as const) {
    assert.throws(() => deliveryOutcome("authenticated", true, status), /delivery|receiver/);
  }
  assert.throws(() => deliveryOutcome("authenticated", false, "success"), /delivery/);
});

test("simulation cannot imply verified delivery on missing/default receiver status", () => {
  assert.match(deliveryOutcome("simulation", true, "unknown"), /unverified/);
  assert.match(deliveryOutcome("simulation", true, "success"), /simulation forwarder.*unconfirmed.*not authenticated onchain proof/);
  assert.throws(() => deliveryOutcome("simulation", true, "reverted"), /delivery/);
  assert.throws(() => deliveryOutcome("simulation", false, "unknown"), /delivery/);
});
