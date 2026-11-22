import React from "react";
import ReactDOM from "react-dom/client";
import { OrbApp } from "./OrbApp";

// Windows WebView2 透明窗对 filter/clip-path 更敏感，用 class 做样式分流（不影响 macOS）
if (/\bWindows\b/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("os-windows");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <OrbApp />
  </React.StrictMode>,
);
