import { selectSharedDemoRole } from "./route-role.js";

if (selectSharedDemoRole(window.location) === "monitor") {
  void import("./monitor-main.jsx");
} else {
  void import("./viewer-main.jsx");
}
