import assert from "node:assert/strict";
import test from "node:test";
import { resolveAppRoute } from "./appRoute.js";

test("resolves the three canonical application paths", () => {
  assert.deepEqual(resolveAppRoute("/home"), { type: "app", app: "home" });
  assert.deepEqual(resolveAppRoute("/family"), { type: "app", app: "family" });
  assert.deepEqual(resolveAppRoute("/debug"), { type: "app", app: "debug" });
});

test("redirects the root and legacy HTML entry points", () => {
  assert.deepEqual(resolveAppRoute("/"), { type: "redirect", pathname: "/home" });
  assert.deepEqual(resolveAppRoute("/index.html"), { type: "redirect", pathname: "/home" });
  assert.deepEqual(resolveAppRoute("/viewer.html"), { type: "redirect", pathname: "/family" });
  assert.deepEqual(resolveAppRoute("/typical-demo.html"), { type: "redirect", pathname: "/debug" });
});

test("canonicalizes one trailing slash on known routes", () => {
  assert.deepEqual(resolveAppRoute("/home/"), { type: "redirect", pathname: "/home" });
  assert.deepEqual(resolveAppRoute("/family/"), { type: "redirect", pathname: "/family" });
  assert.deepEqual(resolveAppRoute("/debug/"), { type: "redirect", pathname: "/debug" });
  assert.deepEqual(resolveAppRoute("/viewer.html/"), { type: "redirect", pathname: "/family" });
});

test("does not turn unknown or lookalike paths into an application route", () => {
  for (const pathname of [
    "",
    "home",
    "/unknown",
    "/Home",
    "/family-member",
    "/family/child",
    "/family//",
    "/debug/tools",
  ]) {
    assert.deepEqual(resolveAppRoute(pathname), { type: "not_found" }, pathname);
  }
});
