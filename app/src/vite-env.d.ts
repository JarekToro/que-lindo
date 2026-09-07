/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by `npm run e2e:build`; enables the WebdriverIO guest bindings. */
  readonly VITE_E2E?: string;
}

interface Window {
  /** Mock table @wdio/tauri-service fills from `browser.tauri.mock(command)`;
   * consulted by `src/e2e/tauriCore.ts` in e2e builds only. */
  __wdio_mocks__?: Record<string, (args: unknown) => unknown>;
}

/** Real `@tauri-apps/api/core`, reachable under this name only in e2e builds
 * (see the alias in vite.config.ts). */
declare module "@tauri-apps/api/core-real" {
  export * from "@tauri-apps/api/core";
}
