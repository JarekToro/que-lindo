import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const TAURI_CORE = path.resolve(__dirname, "node_modules/@tauri-apps/api/core.js");

// Tauri expects a fixed dev port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2021" },
  resolve: {
    alias: process.env.VITE_E2E
      ? [
          // e2e builds: route every `@tauri-apps/api/core` import (ours and the
          // plugins') through a shim whose `invoke` honours WebdriverIO mocks.
          { find: /^@tauri-apps\/api\/core-real$/, replacement: TAURI_CORE },
          { find: /^@tauri-apps\/api\/core$/, replacement: path.resolve(__dirname, "src/e2e/tauriCore.ts") },
        ]
      : [],
  },
});
