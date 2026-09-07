// WebdriverIO configuration for the Qué lindo end-to-end suite.
//
// Drives the real app — Rust backend, compositor, ffmpeg, WKWebView — through
// the W3C WebDriver protocol. @wdio/tauri-service launches the binary built by
// `npm run e2e:build` (debug build with the `e2e` cargo feature), which embeds
// a WebDriver server, so no external driver is needed on any platform.
//
//   cd app && npm run e2e:build     # once, and after Rust/frontend changes
//   cd app && npm run e2e           # all specs
//   cd app && npm run e2e -- --spec e2e/specs/import.spec.ts

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFixtures } from "./page/fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BINARY = path.join(ROOT, "target", "debug", "slideshow-app");
const LOGS = path.join(ROOT, "app", "e2e", "logs");

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.spec.ts"],
  // One app instance, one window, shared store: specs must not run in parallel.
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      // Typed as a vendor extension by the service, not by WebdriverIO itself.
      ...({ "tauri:options": { application: BINARY } } as Record<string, unknown>),
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        startTimeout: 90_000,
        commandTimeout: 60_000,
        captureBackendLogs: true,
        captureFrontendLogs: true,
        logDir: LOGS,
      },
    ],
  ],
  // The service's own `logDir` only applies to its standalone entry point;
  // under the testrunner it writes captured backend/frontend logs to WDIO's
  // `outputDir`, which defaults to app/logs — where CI wasn't looking.
  outputDir: LOGS,
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 90_000 },
  reporters: ["spec"],
  logLevel: "warn",
  waitforTimeout: 15_000,
  onPrepare() {
    // @wdio/cli logs a throw from here and then starts the workers anyway, so a
    // single missing prerequisite turns into a full run of specs failing on
    // absent fixtures. Exit instead, and leave the real reason as the last line.
    try {
      if (!existsSync(BINARY)) {
        throw new Error(`e2e binary missing at ${BINARY} — run \`npm run e2e:build\` in app/ first`);
      }
      ensureFixtures();
    } catch (err) {
      console.error(`\ne2e setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
  },
};
