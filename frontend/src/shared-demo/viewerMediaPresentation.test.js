import assert from "node:assert/strict";
import test from "node:test";

import { selectViewerMediaStage } from "./viewerMediaPresentation.js";

const kitchenGrant = Object.freeze({
  grant_id: "grant-kitchen",
  scope: "kitchen_moment",
});

test("kitchen keeps its abstract background only before an active real-media grant", () => {
  assert.deepEqual(selectViewerMediaStage({ grant: null, status: "idle", stream: null }), {
    kind: "none",
    videoVisible: false,
    neutralBackdrop: false,
  });
});

test("authorized kitchen uses a neutral skeleton backdrop until a verified first frame", () => {
  for (const status of ["authorized", "credentialing", "waiting", "connecting"]) {
    assert.deepEqual(selectViewerMediaStage({ grant: kitchenGrant, status, stream: null }), {
      kind: "pending",
      videoVisible: false,
      neutralBackdrop: true,
    });
  }
  assert.deepEqual(selectViewerMediaStage({
    grant: kitchenGrant,
    status: "failed",
    stream: null,
  }), {
    kind: "failed",
    videoVisible: false,
    neutralBackdrop: true,
  });
});

test("kitchen real video replaces every backdrop only after LIVE has a stream", () => {
  assert.deepEqual(selectViewerMediaStage({
    grant: kitchenGrant,
    status: "live",
    stream: null,
  }), {
    kind: "pending",
    videoVisible: false,
    neutralBackdrop: true,
  });
  assert.deepEqual(selectViewerMediaStage({
    grant: kitchenGrant,
    status: "live",
    stream: { id: "remote-stream" },
  }), {
    kind: "live",
    videoVisible: true,
    neutralBackdrop: false,
  });
});
