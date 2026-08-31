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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
