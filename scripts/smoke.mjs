#!/usr/bin/env node
/**
 * Spotify server smoke test.
 *
 * Runs in two modes automatically:
 *   - No tokens yet: asserts the handshake works and that every tool fails
 *     *gracefully* with an actionable "run login" message rather than crashing.
 *   - Authorized: exercises the real tools against the live account.
 *
 *   npm run spotify:smoke
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const TOKEN_PATH = path.join(homedir(), ".spotify-mcp", "tokens.json");
const authorized = existsSync(TOKEN_PATH);

const client = new Client({ name: "spotify-smoke", version: "0.1.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: ["dist/index.js"] }),
);

const line = (s) => console.log(`\n=== ${s} ===`);
const body = (r) => r.content.map((c) => c.text).join("\n");
const preview = (r, n = 500) => {
  const b = body(r);
  console.log(b.length > n ? `${b.slice(0, n)}\n...[${b.length} chars]` : b);
};

line("tools/list");
const { tools } = await client.listTools();
console.log(tools.map((t) => `${t.name} - ${t.title}`).join("\n"));
console.log(`\n${tools.length} tools registered.`);

if (!authorized) {
  line("unauthorized behaviour (no token file present)");
  console.log(`No tokens at ${TOKEN_PATH} - checking every tool degrades cleanly.\n`);

  let clean = 0;
  for (const tool of tools) {
    // Fill required args with throwaway values; we only care about the failure mode.
    const args = {};
    for (const [key, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      if ((tool.inputSchema.required ?? []).includes(key)) {
        args[key] = schema.type === "number" ? 1 : "test";
      }
    }
    const res = await client.callTool({ name: tool.name, arguments: args });
    const msg = body(res);
    const ok = res.isError === true && /spotify:login/.test(msg);
    if (ok) clean++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${tool.name}: ${msg.slice(0, 90)}`);
  }
  console.log(`\n${clean}/${tools.length} tools returned an actionable auth error.`);
  console.log("Run `npm run spotify:login`, then re-run this for the live tests.");
} else {
  line("now_playing");
  preview(await client.callTool({ name: "now_playing", arguments: {} }));

  line("my_listening_profile (short_term)");
  preview(
    await client.callTool({
      name: "my_listening_profile",
      arguments: { time_range: "short_term", limit: 10 },
    }),
  );

  line("taste_evolution");
  preview(await client.callTool({ name: "taste_evolution", arguments: { limit: 20 } }));

  line("recently_played");
  preview(await client.callTool({ name: "recently_played", arguments: { limit: 20 } }));

  line("my_playlists");
  const playlists = await client.callTool({
    name: "my_playlists",
    arguments: { max: 20 },
  });
  preview(playlists);

  // Analyze whichever playlist is listed first, so this covers the
  // /playlists/{id}/items path against a real playlist rather than a fixture.
  const firstPlaylist = playlists.content
    .map((c) => c.text)
    .join("\n")
    .match(/^- (.+?) \(\d+ tracks/m)?.[1];

  line(`analyze_playlist (${firstPlaylist ?? "skipped - no playlists"})`);
  if (firstPlaylist) {
    preview(
      await client.callTool({
        name: "analyze_playlist",
        arguments: { playlist: firstPlaylist },
      }),
      600,
    );
  }

  line("artist_profile");
  preview(
    await client.callTool({ name: "artist_profile", arguments: { name: "Radiohead" } }),
  );

  line("search_catalog");
  preview(
    await client.callTool({
      name: "search_catalog",
      arguments: { query: "bonobo", type: "artist", limit: 5 },
    }),
  );
}

await client.close();
console.log("\nSmoke test complete.");
