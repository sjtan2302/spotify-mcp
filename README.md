# spotify-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants answer
questions about your Spotify listening history.

Ask *"how has my taste changed this year?"* in Claude and get a real answer,
computed from your actual listening data — not a guess.

```
> How has my music taste changed over the past year?

# Taste evolution (top 30 artists per window)

## Rising — in the last 4 weeks but not the last year
Phoenix, Men I Trust, Jungle, Rex Orange County

## Fading — in the last year but not the last 4 weeks
Radiohead, Kendrick Lamar, Fleetwood Mac, Interpol, Portishead

## Constant — present in both
Tame Impala, Frank Ocean, Daft Punk, The Strokes

Overlap between the 4-week and 1-year windows: 11/30 artists.
```

<sub>Example output. The tool reports whatever your own account contains.</sub>

Built on the Model Context Protocol, an open standard — so one server works in
Claude Desktop, Claude Code, Cursor, or any other MCP client, with no
integration code written per client.

**Read-only.** Every granted scope is a `*-read` scope: the server can observe
your account and cannot modify it. No playback control, no playlist edits.

## Tools

| Tool | Question it answers |
| --- | --- |
| `my_listening_profile` | "What am I into lately?" — top artists and tracks for a 4-week, 6-month, or 1-year window |
| `taste_evolution` | "How has my taste changed?" — who's rising, fading, and constant across all three windows |
| `recently_played` | "What have I had on?" — recent plays, repeat artists, time-of-day pattern |
| `my_playlists` | Your playlists, with track counts |
| `analyze_playlist` | "What *is* this playlist?" — dominant artists, how varied it is, release decades, runtime |
| `artist_profile` | An artist's albums and singles, newest first |
| `search_catalog` | Search tracks, artists, or albums |
| `now_playing` | What's playing right now |

Tools are designed around questions rather than API endpoints. `taste_evolution`
makes three API calls and diffs them server-side, because Spotify exposes three
fixed windows and no history — returning an answer rather than three pages of
raw JSON for the model to reconcile itself.

## Requirements

- Node.js 20.12 or newer
- A Spotify account
- A free Spotify developer app (below) — no paid tier needed

## Setup

### 1. Install

```bash
git clone https://github.com/sjtan2302/spotify-mcp.git
cd spotify-mcp
npm install
npm run build
```

### 2. Create a Spotify app

Go to the [Spotify developer dashboard](https://developer.spotify.com/dashboard)
and click **Create app**.

| Field | Value |
| --- | --- |
| App name | Anything, e.g. `spotify-mcp` |
| App description | Required; anything, e.g. `Personal MCP server` |
| Website | Leave blank |
| Redirect URI | `http://127.0.0.1:8888/callback` — **click Add** |
| Which API/SDKs | Check **Web API** |

Two things that trip people up:

- **Click "Add" before "Save".** The redirect URI is silently dropped otherwise,
  and the resulting error looks like an invalid client ID.
- **Use `127.0.0.1`, not `localhost`.** Spotify disallowed `localhost` hostnames
  in February 2025; `http://localhost:8888/callback` is rejected with
  `INVALID_CLIENT: Insecure redirect URI`.

Then open the app's **Settings** and copy the Client ID.

### 3. Add your Client ID

```bash
cp .env.example .env
```

Put the ID in `.env`:

```
SPOTIFY_CLIENT_ID=your_client_id_here
```

No client secret is needed. This server uses OAuth 2.0 with PKCE, which exists
precisely so that no secret has to be stored. The Client ID is not sensitive.

### 4. Authorize

```bash
npm run login
```

A browser opens; approve the request. Tokens are written to
`~/.spotify-mcp/tokens.json` with `0600` permissions, and refreshed
automatically from then on. You only do this once.

### 5. Verify

```bash
npm run smoke
```

This launches the server the way a real client does and exercises every tool
against your account.

## Connecting an AI assistant

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "spotify": {
      "command": "/usr/local/bin/node",
      "args": ["/absolute/path/to/spotify-mcp/dist/index.js"]
    }
  }
}
```

Then **fully quit and reopen** Claude Desktop — it only reads this file at
launch.

> Use the absolute path to `node` (`which node`). Claude Desktop does not
> inherit your shell `PATH`, and a bare `"node"` is the most common reason a
> server silently fails to start.

### Claude Code

```bash
claude mcp add spotify -- node /absolute/path/to/spotify-mcp/dist/index.js
```

The server locates `.env` relative to its own installed location, so it works
regardless of which directory the client launches it from.

## Development

```bash
npm run build     # compile
npm run dev       # compile on change
npm run smoke     # end-to-end test against a live account
npm run inspect   # open the MCP Inspector UI
```

```
src/
  index.ts     tool registration and transport wiring
  auth.ts      OAuth 2.0 PKCE flow, loopback callback, 0600 token store
  api.ts       API client: token refresh, pagination, 429/401 handling
  analyze.ts   aggregation: artist mix, decades, taste diff, listening clock
  login.ts     one-time authorization CLI
  env.ts       optional .env loading
  tool.ts      shared MCP result helpers
scripts/
  smoke.mjs    end-to-end test over a real stdio client connection
```

## What this server cannot do, and why

Spotify has restricted its Web API substantially for apps created recently.
These are not bugs here — the data no longer exists at this access tier:

**November 2024** — restricted for apps without prior extended access:
Audio Features (danceability, energy, tempo, valence), Audio Analysis,
Recommendations, Related Artists, Featured Playlists, Category Playlists,
30-second preview URLs.

**February 2026** — removed outright:

| Removed | Effect |
| --- | --- |
| `GET /artists` (several artists) | No batch artist lookup |
| `GET /artists/{id}/top-tracks` | `artist_profile` reports catalogue instead |
| `GET /playlists/{id}/tracks` | Renamed `/items`; row key `track` → `item` |
| Artist `genres`, `followers`, `popularity` | No genre analysis is possible |
| Track `popularity` | No "mainstream vs deep cuts" measure |
| Playlist `tracks` → `items` | Track counts come from `items.total` |
| Search `limit` 50 → 10 | Catalog endpoints cap pages at 10 |

Most Spotify tutorials are built on `audio-features` and `recommendations`.
They no longer run. **Genre data is gone entirely** — genres existed only on
artist objects, and both the batch endpoint and the field itself were removed.

This server uses *artist concentration* instead: what share of a track set's
credits belong to its top few artists. It answers the same underlying question
— is this varied or narrow? — from data that still exists.

## License

MIT
