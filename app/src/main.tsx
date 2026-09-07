import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// Guest bindings for tauri-plugin-mcp, which the DOM/JS tools need. The plugin
// is only compiled in under the `mcp` cargo feature (`npm run dev:mcp`), so in
// an ordinary dev run it is simply not there -- hence the quiet catch.
if (import.meta.env.DEV) {
  void import("tauri-plugin-mcp")
    .then((mcp) => mcp.setupPluginListeners())
    .catch(() => {});
}

// Guest bindings for tauri-plugin-wdio (WebdriverIO e2e). `VITE_E2E=1` is set
// by `npm run e2e:build`, which also turns on the `e2e` cargo feature; in any
// other build the import is dead code and Vite drops it.
if (import.meta.env.VITE_E2E) {
  void import("@wdio/tauri-plugin").catch(() => {});
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
