import assert from "node:assert/strict";
import test from "node:test";
import { selectSupportedRecordingMimeType } from "./useRemeLocalRecorder.js";

test("local recorder selects the first supported playable container", () => {
  const MediaRecorderType = {
    isTypeSupported: (value) => value === "video/webm;codecs=vp8",
  };
  assert.equal(selectSupportedRecordingMimeType(MediaRecorderType), "video/webm;codecs=vp8");
  assert.equal(selectSupportedRecordingMimeType(null), null);
});
