import React from "react";
import ReactDOM from "react-dom/client";
import { applyPlatformClass } from "../shared/platform";
import { SettingsApp } from "./SettingsApp";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SettingsApp />
  </React.StrictMode>,
);
