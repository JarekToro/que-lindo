// Fixture media: the placeholder images/clips/music that
// examples/make-test-media.sh generates. Created on first run.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const MEDIA = path.join(ROOT, "examples", "media");

export function ensureFixtures(): void {
  // music2.mp3 is the last thing the script writes, so it is the one file that
  // proves a previous run finished rather than died partway through.
  if (!existsSync(path.join(MEDIA, "music2.mp3"))) {
    execFileSync("bash", [path.join(ROOT, "examples", "make-test-media.sh")], {
      cwd: ROOT,
      stdio: "inherit",
    });
  }
}

export const IMG = (name: string): string => path.join(MEDIA, name);
