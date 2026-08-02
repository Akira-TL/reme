import assert from "node:assert/strict";
import test from "node:test";

import { selectSharedDemoRole } from "./route-role.js";

test("the dedicated monitor hostname opens the controller at its root", () => {
  assert.equal(
    selectSharedDemoRole({ hostname: "monitor.reme.maniforld.com", pathname: "/" }),
    "monitor",
  );
});

test("the judge hostname stays read-only", () => {
  assert.equal(
    selectSharedDemoRole({ hostname: "reme.maniforld.com", pathname: "/" }),
    "viewer",
  );
});

test("the legacy monitor path remains a compatibility entrance", () => {
  assert.equal(
    selectSharedDemoRole({ hostname: "reme.maniforld.com", pathname: "/monitor/" }),
    "monitor",
  );
});
