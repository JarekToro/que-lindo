// e2e-only stand-in for `@tauri-apps/api/core`, wired in by vite.config.ts
// when VITE_E2E is set. Everything is the real module except `invoke`, which
// first consults the mock table that @wdio/tauri-service fills from
// `browser.tauri.mock(command)`. The service itself only proxies
// `window.__TAURI__.core.invoke`, which a bundled frontend never calls, and
// `__TAURI_INTERNALS__.invoke` is non-writable, so this is the seam.

import { invoke as realInvoke } from "@tauri-apps/api/core-real";
import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core-real";

export * from "@tauri-apps/api/core-real";

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  const mock = window.__wdio_mocks__?.[cmd];
  if (mock) return (await mock(args)) as T;
  return realInvoke<T>(cmd, args, options);
}
