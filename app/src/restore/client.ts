// HTTP client for the restore engine (tools/restore/server.py). The Rust side
// starts the process and hands back its base URL; from there the webview
// talks to it directly, which keeps full-resolution images off the IPC path.

import { restoreAlive, restoreStart, restoreStatus } from "../api";
import type { Quad, Step } from "./steps";

export interface EngineInfo {
  device: string;
  models_dir: string;
  /** What the engine is doing right now ("step 2/3: PMRF…"), "" when idle. */
  status: string;
  busy: boolean;
  capabilities: { pmrf: boolean; bopbtl: boolean };
}

export interface ModelInfo {
  name: string;
  arch: string;
  purpose: string;
  scale: number | null;
  loaded: boolean;
}

export interface RunResult {
  key: string;
  /** Server-relative URL of the result PNG. */
  url: string;
  w: number;
  h: number;
  ms: number;
  log: string[];
  cached: boolean;
}

/** Where tools/autocrop thinks the print is (corners as fractions), or found=false. */
export interface PrintDetection {
  w: number;
  h: number;
  found: boolean;
  quad?: Quad;
  confidence?: number;
  method?: string;
}

export interface CommitResult {
  ok: boolean;
  written: string;
  backup?: string;
}

/** Why the engine cannot be used right now. */
export type EngineProblem =
  | { kind: "not-installed"; lookedIn: string; log: string }
  | { kind: "failed"; message: string; log: string };

export class EngineError extends Error {
  constructor(public problem: EngineProblem) {
    super(problem.kind === "not-installed" ? "restore engine not installed" : problem.message);
  }
}

const splitPath = (path: string): { dir: string; name: string } => {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { dir: path.slice(0, at), name: path.slice(at + 1) };
};

export class RestoreClient {
  constructor(public readonly base: string) {}

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await fetch(this.base + path, init);
    if (!r.ok) {
      let text = await r.text();
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object" && "detail" in parsed && typeof parsed.detail === "string")
          text = parsed.detail;
      } catch {
        // plain-text error body
      }
      throw new Error(text || `${r.status} ${r.statusText}`);
    }
    return (await r.json()) as T;
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  info(): Promise<EngineInfo> {
    return this.json<EngineInfo>("/api/info");
  }

  models(): Promise<ModelInfo[]> {
    return this.json<ModelInfo[]>("/api/models");
  }

  /** URL of the photo as stored on disk (`maxPx` = longest side, for huge scans). */
  originalUrl(path: string, maxPx?: number, bust?: number): string {
    const { dir, name } = splitPath(path);
    const q = new URLSearchParams({ path: dir, name });
    if (maxPx) q.set("max", String(maxPx));
    if (bust) q.set("v", String(bust));
    return `${this.base}/api/folder/file?${q}`;
  }

  resultUrl(r: RunResult): string {
    return `${this.base}${r.url}?v=${r.key}`;
  }

  /** Find the print in a photographed print (corners as fractions). */
  detectPrint(path: string): Promise<PrintDetection> {
    const { dir, name } = splitPath(path);
    return this.post<PrintDetection>("/api/autocrop/detect", { path: dir, name });
  }

  /** Run a pipeline on one photo; resolves when the result is ready. */
  process(path: string, steps: Step[]): Promise<RunResult> {
    const { dir, name } = splitPath(path);
    return this.post<RunResult>("/api/curate/process", { path: dir, name, steps });
  }

  /** Overwrite the photo with a result; the original moves to `_originals/`. */
  replace(path: string, key: string, quality: number): Promise<CommitResult> {
    const { dir, name } = splitPath(path);
    return this.post<CommitResult>("/api/curate/commit", { path: dir, name, key, mode: "replace", quality });
  }

  /** Write a result to a new file (absolute path). */
  saveAs(path: string, key: string, newPath: string, quality: number): Promise<CommitResult> {
    const { dir, name } = splitPath(path);
    return this.post<CommitResult>("/api/curate/commit", {
      path: dir,
      name,
      key,
      mode: "saveas",
      new_path: newPath,
      quality,
    });
  }
}

let clientPromise: Promise<RestoreClient> | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The engine, started if need be and polled until it answers (importing
 * torch takes a few seconds). One shared instance; a failure clears it so
 * the next open retries.
 */
export async function engine(): Promise<RestoreClient> {
  // A server that died (or was restarted for an engine edit) must not be
  // handed out again; the Rust side knows whether its child still runs.
  if (clientPromise && !(await restoreAlive().catch(() => false))) clientPromise = null;
  if (!clientPromise) {
    clientPromise = connect().catch((e: unknown) => {
      clientPromise = null;
      throw e;
    });
  }
  return clientPromise;
}

async function connect(): Promise<RestoreClient> {
  const status = await restoreStatus();
  if (!status.available) {
    throw new EngineError({ kind: "not-installed", lookedIn: status.dir, log: status.log });
  }
  let base: string;
  try {
    base = await restoreStart();
  } catch (e) {
    throw new EngineError({ kind: "failed", message: String(e), log: status.log });
  }
  const client = new RestoreClient(base);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      await client.info();
      return client;
    } catch {
      // not listening yet
    }
    if (!(await restoreAlive())) {
      throw new EngineError({
        kind: "failed",
        message: "the restore engine exited while starting",
        log: status.log,
      });
    }
    await sleep(400);
  }
  throw new EngineError({ kind: "failed", message: "the restore engine did not answer in time", log: status.log });
}

/** Forget the shared instance (the process died or was stopped). */
export function resetEngine(): void {
  clientPromise = null;
}
