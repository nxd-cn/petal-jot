import React from "react";
import ReactDOM from "react-dom/client";
import { applyPlatformClass } from "../shared/platform";
import { EditorApp } from "./EditorApp";

applyPlatformClass();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <EditorApp />
  </React.StrictMode>,
);
