/**
 * Optional .env loading.
 *
 * This server is launched two different ways: by `npm run` from the repo, and
 * by an MCP client that spawns `node /abs/path/dist/spotify/index.js` with an
 * arbitrary working directory. Resolving .env from process.cwd() would work in
 * the first case and silently fail in the second, so the file is located
 * relative to *this module* by walking up to the package root.
 *
 * Precedence: real environment variables always win. .env is a fallback for
 * local development, never an override of what a client config passed in.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let attempted = false;

/** Walk up from this module until a package.json turns up. */
function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/**
 * Load .env if present. Idempotent, never throws, and reports which file was
 * used so callers can log it to stderr.
 */
export function loadDotEnv(): string | null {
  if (attempted) return null;
  attempted = true;

  const candidates = [
    path.join(packageRoot(), ".env"),
    path.join(process.cwd(), ".env"),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      // process.loadEnvFile is built into Node >=20.12 - no dependency needed.
      process.loadEnvFile(file);
      return file;
    } catch {
      /* malformed or unreadable; fall through to the next candidate */
    }
  }
  return null;
}
