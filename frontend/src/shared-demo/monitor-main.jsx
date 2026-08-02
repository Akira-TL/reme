import { createRoot } from "react-dom/client";
import { MonitorApp } from "./MonitorApp.jsx";
import "./shared-demo.css";
import "./main-aligned.css";

document.title = "Reme · 手机监控端";
createRoot(document.getElementById("shared-demo-root")).render(<MonitorApp />);
