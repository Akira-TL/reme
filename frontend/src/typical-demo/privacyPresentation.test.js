import assert from "node:assert/strict";
import test from "node:test";
import {
  homePrivacyViewMode,
  privacyAllowsEventVideo,
} from "./privacyPresentation.js";

test("Home executes every authoritative privacy mode and fails closed", () => {
  assert.equal(homePrivacyViewMode("living", null), "skeleton");
  assert.equal(homePrivacyViewMode("living", { privacy_mode: "visible" }), "video_skeleton");
  assert.equal(homePrivacyViewMode("living", { privacy_mode: "blurred" }), "blurred_skeleton");
  assert.equal(homePrivacyViewMode("living", { privacy_mode: "skeleton_only" }), "skeleton");
  assert.equal(homePrivacyViewMode("living", { privacy_mode: "hidden" }), "hidden");
  assert.equal(homePrivacyViewMode("bathroom", { privacy_mode: "visible" }), "skeleton");
});

test("event grants obey authoritative privacy hard vetoes", () => {
  assert.equal(privacyAllowsEventVideo("kitchen", { privacy_mode: "blurred" }), true);
  assert.equal(privacyAllowsEventVideo("fall", { privacy_mode: "skeleton_only" }), false);
  assert.equal(privacyAllowsEventVideo("fall", { privacy_mode: "hidden" }), false);
  assert.equal(privacyAllowsEventVideo("bathroom", { privacy_mode: "visible" }), false);
});
