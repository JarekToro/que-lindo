// Socket client for the app's MCP bridge (`npm run dev:mcp`): newline-
// delimited JSON over a unix socket. `evalJs` runs code in the webview and
// returns the JSON-decoded completion value.

import { readFileSync } from "node:fs";
import net from "node:net";

const SOCKET_PATH = "/tmp/slideshow-studio-mcp.sock";
const TOKEN_PATH = `${SOCKET_PATH}.token`;

export class AppClient {
  constructor() {
    this.socket = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH);
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        this.socket = socket;
        resolve();
      });
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const waiter = this.pending.get(msg.id);
          if (waiter) {
            this.pending.delete(msg.id);
            waiter(msg);
          }
        }
      });
    });
  }

  request(command, payload, timeoutMs = 30000) {
    const id = String(this.nextId++);
    let authToken;
    try {
      authToken = readFileSync(TOKEN_PATH, "utf8").trim();
    } catch {
      authToken = undefined; // server may run without auth
    }
    const line = JSON.stringify({ command, payload, id, authToken }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${command}`));
      }, timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.success) resolve(msg.data);
        else reject(new Error(msg.error ?? "request failed"));
      });
      this.socket.write(line);
    });
  }

  /** Run JS in the webview; the last expression (promises awaited) comes
   * back JSON-decoded. Throws on page-side exceptions. */
  async evalJs(code, timeoutMs = 30000) {
    const data = await this.request(
      "execute_js",
      { code, timeout_ms: timeoutMs },
      timeoutMs + 5000,
    );
    const raw = data?.result;
    if (raw === undefined || raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // plain string results
    }
  }

  close() {
    this.socket?.end();
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
