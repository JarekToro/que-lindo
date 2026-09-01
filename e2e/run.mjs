#!/usr/bin/env node
// E2E runner: drives the real app through the MCP bridge socket.
//
//   node e2e/run.mjs [pattern]
//
// Connects to a running `npm run dev:mcp` instance if the socket exists;
// otherwise spawns one and tears it down afterwards. Every run RESETS the
// app's in-memory state — save your project first.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { AppClient, sleep } from "./client.mjs";
import { ensureFixtures, resetApp, ROOT } from "./harness.mjs";

const SOCKET = "/tmp/slideshow-studio-mcp.sock";
const pattern = process.argv[2] ?? "";

async function connectWithRetry(client, timeoutMs) {
  const start = Date.now();
  for (;;) {
    try {
      await client.connect();
      return;
    } catch (e) {
      if (Date.now() - start > timeoutMs) throw e;
      await sleep(1000);
    }
  }
}

async function main() {
  ensureFixtures();

  let child = null;
  if (!existsSync(SOCKET)) {
    console.log("· spawning app (npm run dev:mcp)…");
    child = spawn("npm", ["run", "dev:mcp"], {
      cwd: path.join(ROOT, "app"),
      stdio: "ignore",
      detached: true,
    });
  }

  const app = new AppClient();
  await connectWithRetry(app, child ? 120000 : 5000);
  // The socket can exist before the webview is ready.
  for (let i = 0; i < 60; i++) {
    const ok = await app.evalJs("!!window.__editorStore").catch(() => false);
    if (ok === true) break;
    await sleep(1000);
  }

  const dir = path.join(ROOT, "e2e", "tests");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".test.mjs") && f.includes(pattern))
    .sort();

  let passed = 0;
  const failures = [];
  for (const file of files) {
    const mod = await import(path.join(dir, file));
    const suite = mod.default;
    console.log(`\n▶ ${suite.name} (${file})`);
    await resetApp(app);
    for (const { title, fn } of suite.tests) {
      try {
        await fn(app);
        passed++;
        console.log(`  ✓ ${title}`);
      } catch (e) {
        failures.push({ file, title, error: e.message });
        console.log(`  ✗ ${title}\n      ${e.message}`);
      }
    }
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  app.close();
  if (child) {
    try {
      process.kill(-child.pid);
    } catch {
      // already gone
    }
  }
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
