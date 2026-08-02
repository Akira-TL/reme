import { createRoot } from "react-dom/client";
import { ViewerApp } from "./ViewerApp.jsx";
import "./shared-demo.css";

document.title = "Reme · 评委只读演示";
createRoot(document.getElementById("shared-demo-root")).render(<ViewerApp />);
