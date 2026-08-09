import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsRemoteCommand,
  exposesDebugInterface,
  initialSceneForSurface,
  normalizeSurface,
  remoteActionsForSurface,
} from "./surfacePolicy.js";

test("home starts from the quiet living context while debug keeps the fall acceptance scene", () => {
  assert.equal(initialSceneForSurface("home"), "living");
  assert.equal(initialSceneForSurface("debug"), "fall");
});

test("home accepts only family acknowledgement commands", () => {
  assert.equal(allowsRemoteCommand("home", "confirm_alarm"), true);
  assert.equal(allowsRemoteCommand("home", "confirm_action_card"), true);
  assert.equal(allowsRemoteCommand("home", "confirm_family_notification"), true);
  for (const command of [
    "select_scene",
    "select_source",
    "start_capture",
    "stop_capture",
    "run_demo_scenario",
    "reset_demo",
    "start_conversation",
    "submit_response",
    "replay_voice",
  ]) {
    assert.equal(allowsRemoteCommand("home", command), false, command);
  }
});

test("debug retains the complete engineering command surface", () => {
  for (const command of ["select_scene", "run_demo_scenario", "confirm_alarm"]) {
    assert.equal(allowsRemoteCommand("debug", command), true, command);
  }
  assert.equal(exposesDebugInterface("debug"), true);
  assert.equal(exposesDebugInterface("home"), false);
});

test("unknown surfaces fail closed into the product-safe home policy", () => {
  assert.equal(normalizeSurface("unknown"), "home");
  assert.equal(initialSceneForSurface("unknown"), "living");
  assert.equal(exposesDebugInterface("unknown"), false);
  assert.equal(allowsRemoteCommand("unknown", "run_demo_scenario"), false);
});

test("home registers family acknowledgements while debug keeps engineering actions", () => {
  const actions = {
    selectScene() {},
    selectSource() {},
    startCapture() {},
    runDemoScenario() {},
    confirmAlarm() {},
    confirmActionCard() {},
    confirmFamilyNotification() {},
  };

  assert.deepEqual(Object.keys(remoteActionsForSurface("home", actions)), [
    "confirmAlarm",
    "confirmActionCard",
    "confirmFamilyNotification",
  ]);
  assert.deepEqual(Object.keys(remoteActionsForSurface("debug", actions)), Object.keys(actions));
});
