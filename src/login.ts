#!/usr/bin/env node
/**
 * One-time consent CLI: `npm run spotify:login`.
 * Writes tokens to ~/.spotify-mcp/tokens.json (0600). The MCP server itself
 * only ever refreshes them.
 */
import { REDIRECT_URI, SCOPES, TOKEN_PATH, clientId, login } from "./auth.js";

/**
 * Report which source the Client ID came from. A stale `export
 * SPOTIFY_CLIENT_ID=...` in the shell silently outranks .env, and the only
 * symptom downstream is an opaque INVALID_CLIENT from Spotify - so say it
 * out loud before opening the browser.
 */
function preflight(): void {
  const fromShell = process.env.SPOTIFY_CLIENT_ID;
  const id = clientId(); // loads .env only if the shell had nothing
  const source = fromShell ? "shell environment" : ".env file";

  console.error(`Client ID: ${id.slice(0, 4)}...${id.slice(-4)} (from ${source})`);

  if (!/^[0-9a-f]{32}$/.test(id)) {
    console.error(
      "  WARNING: a Spotify Client ID is 32 lowercase hex characters. This " +
        "value is not, so it is probably a placeholder and Spotify will " +
        "reject it with INVALID_CLIENT.",
    );
    if (fromShell) {
      console.error(
        "  It came from the shell, which overrides .env. Clear it with:\n" +
          "    unset SPOTIFY_CLIENT_ID",
      );
    }
  }
}

async function main() {
  console.error("Spotify MCP - authorization");
  preflight();
  console.error(`Redirect URI (must be registered on your app): ${REDIRECT_URI}`);
  console.error(`Scopes: ${SCOPES}\n`);

  const tokens = await login();

  console.error(`\nAuthorized. Tokens written to ${TOKEN_PATH} (mode 0600).`);
  console.error(`Granted scopes: ${tokens.scope}`);
  console.error(
    `Access token expires ${new Date(tokens.expires_at).toLocaleTimeString()}; ` +
      "the server refreshes it automatically from here on.",
  );
}

main().catch((err) => {
  console.error(`\nLogin failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
