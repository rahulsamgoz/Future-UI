import React from "react";
import { createRoot } from "react-dom/client";
import { loadBuildId } from "./build.js";
import { App } from "./App.js";
import "./styles.css";
import "./editor.css";

async function main() {
  await loadBuildId();
  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("#root missing");
  createRoot(rootEl).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void main();
