#!/usr/bin/env node
/**
 * spotify-mcp - an MCP server over the Spotify Web API.
 *
 * Tools are shaped around the questions people actually ask ("how has my taste
 * shifted?") rather than mirroring REST endpoints. A tool that maps 1:1 onto
 * GET /me/top/artists just makes the model do the API's paperwork; these
 * fetch, join and aggregate, and return an answer.
 *
 * Read-only: every granted scope is a *-read scope. The server can observe the
 * account and cannot modify it.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import * as sp from "./api.js";
import {
  artistMix,
  bullet,
  concentration,
  decadesOf,
  formatDuration,
  movement,
  tally,
  timeOfDay,
  trackLine,
} from "./analyze.js";
import { guard, sections, text } from "./tool.js";

const server = new McpServer(
  { name: "spotify", version: "0.1.0" },
  {
    instructions:
      "Read-only access to the authorized user's Spotify account. " +
      "my_listening_profile answers 'what do I listen to'; taste_evolution " +
      "answers 'how has that changed'. " +
      "Unavailable at this access tier, so do not ask for them or infer " +
      "them: audio features (danceability, energy, tempo, valence), " +
      "genres, artist follower counts, and popularity scores. Spotify " +
      "restricted audio features in Nov 2024 and removed genres, followers " +
      "and popularity in Feb 2026. " +
      "The substitute for genre is repeated-artist share, which these tools " +
      "report directly - treat it as a measure of variety, not of style.",
  },
);

const TimeRange = z
  .enum(["short_term", "medium_term", "long_term"])
  .describe(
    "short_term = last ~4 weeks, medium_term = last ~6 months, long_term = last ~1 year.",
  );

const RANGE_LABEL: Record<string, string> = {
  short_term: "last ~4 weeks",
  medium_term: "last ~6 months",
  long_term: "last ~1 year",
};

/* ------------------------------------------------------------------ *
 * Listening identity
 * ------------------------------------------------------------------ */

server.registerTool(
  "my_listening_profile",
  {
    title: "My listening profile",
    description:
      "Top artists and tracks for a time window in one call - answers " +
      "'what am I into lately'.",
    inputSchema: {
      time_range: TimeRange.default("medium_term"),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  guard(async ({ time_range, limit }) => {
    const [artistPage, trackPage] = await Promise.all([
      sp.topArtists(time_range, limit),
      sp.topTracks(time_range, limit),
    ]);

    // Genres were removed from Artist in the Feb 2026 API revision, so the
    // breakdown this used to print has no data source. Repeat-artist share
    // across top tracks is the remaining signal.
    const repeats = artistMix(trackPage.items, 8).filter((a) => a.count > 1);

    return text(
      sections(
        `# Listening profile (${RANGE_LABEL[time_range]})`,
        `## Top artists\n${artistPage.items
          .map((a, i) => `${i + 1}. ${a.name}`)
          .join("\n")}`,
        `## Top tracks\n${trackPage.items.map((t, i) => trackLine(t, i)).join("\n")}`,
        repeats.length
          ? `## Artists with more than one track in this window\n${bullet(repeats)}`
          : "",
      ),
    );
  }),
);

server.registerTool(
  "taste_evolution",
  {
    title: "How my taste is changing",
    description:
      "Compares top artists across all three time windows to show who is " +
      "rising, fading, and constant. Spotify exposes no listening history, " +
      "so this diff is the only way to see direction of travel.",
    inputSchema: {
      limit: z.number().int().min(5).max(50).default(25),
    },
  },
  guard(async ({ limit }) => {
    const [shortT, mediumT, longT] = await Promise.all([
      sp.topArtists("short_term", limit),
      sp.topArtists("medium_term", limit),
      sp.topArtists("long_term", limit),
    ]);

    const { rising, falling, steady } = movement(longT.items, shortT.items);

    const list = (names: string[]) =>
      names.length ? names.slice(0, 15).join(", ") : "none";

    return text(
      sections(
        `# Taste evolution (top ${limit} artists per window)`,
        `## Rising - in the last 4 weeks but not the last year\n${list(rising)}`,
        `## Fading - in the last year but not the last 4 weeks\n${list(falling)}`,
        `## Constant - present in both\n${list(steady)}`,
        `Overlap between the 4-week and 1-year windows: ${steady.length}/${limit} artists.`,
      ),
    );
  }),
);

server.registerTool(
  "recently_played",
  {
    title: "Recently played",
    description:
      "The most recent plays, with the artists repeated most and which parts " +
      "of the day the listening clustered in. Spotify caps this at 50 items.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).default(50),
    },
  },
  guard(async ({ limit }) => {
    const page = await sp.recentlyPlayed(limit);
    if (page.items.length === 0) return text("No recent plays returned.");

    const repeats = tally(
      page.items.flatMap((h) => h.track.artists.map((a) => a.name)),
      8,
    );

    return text(
      sections(
        `# Last ${page.items.length} plays`,
        `Span: ${new Date(
          page.items[page.items.length - 1].played_at,
        ).toLocaleString()} to ${new Date(page.items[0].played_at).toLocaleString()}`,
        `## Most repeated artists\n${bullet(repeats)}`,
        `## When\n${bullet(timeOfDay(page.items))}`,
        `## Plays\n${page.items
          .map((h) => `${new Date(h.played_at).toLocaleString()} - ${trackLine(h.track)}`)
          .join("\n")}`,
      ),
    );
  }),
);

/* ------------------------------------------------------------------ *
 * Playlists
 * ------------------------------------------------------------------ */

server.registerTool(
  "my_playlists",
  {
    title: "List my playlists",
    description:
      "Playlists the user owns or follows, with track counts. Use this to " +
      "find a name to pass to analyze_playlist.",
    inputSchema: {
      max: z.number().int().min(1).max(200).default(50),
    },
  },
  guard(async ({ max }) => {
    const playlists = await sp.myPlaylists(max);
    if (playlists.length === 0) return text("No playlists found.");
    return text(
      `${playlists.length} playlists:\n` +
        playlists
          .map(
            (p) =>
              `- ${p.name} (${p.items.total} tracks, by ${p.owner.display_name ?? "unknown"})`,
          )
          .join("\n"),
    );
  }),
);

server.registerTool(
  "analyze_playlist",
  {
    title: "Analyze a playlist",
    description:
      "Full breakdown of one playlist: dominant artists, how concentrated " +
      "it is, release decades and total runtime. Accepts a playlist name " +
      "(matched against the user's own playlists) or a Spotify playlist ID.",
    inputSchema: {
      playlist: z.string().describe("Playlist name or Spotify playlist ID."),
      max_tracks: z.number().int().min(10).max(1000).default(300),
    },
  },
  guard(async ({ playlist, max_tracks }) => {
    // Resolve a human-typed name to an id; fall back to treating it as an id.
    let id = playlist;
    let title = playlist;
    if (!/^[A-Za-z0-9]{22}$/.test(playlist)) {
      const mine = await sp.myPlaylists(200);
      const needle = playlist.toLowerCase();
      const match =
        mine.find((p) => p.name.toLowerCase() === needle) ??
        mine.find((p) => p.name.toLowerCase().includes(needle));
      if (!match) {
        return text(
          `No playlist matching "${playlist}". Available: ` +
            mine.map((p) => p.name).join(", "),
        );
      }
      id = match.id;
      title = match.name;
    }

    // `/playlists/{id}/tracks` became `/items`, and each row's `track` key
    // became `item`, in the February 2026 revision.
    const rows = await sp.playlistItems(id, max_tracks);
    const tracks = rows.map((r) => r.item).filter((t): t is sp.Track => !!t);
    if (tracks.length === 0) return text(`"${title}" has no playable tracks.`);

    const runtime = tracks.reduce((sum, t) => sum + t.duration_ms, 0);
    const top5Share = concentration(tracks, 5);

    return text(
      sections(
        `# ${title}`,
        `${tracks.length} tracks - ${formatDuration(runtime)} - avg track ${formatDuration(
          runtime / tracks.length,
        )}`,
        `Top 5 artists account for ${top5Share}% of credits (${
          top5Share > 60 ? "narrow" : top5Share > 35 ? "focused" : "varied"
        }).`,
        `## Dominant artists\n${bullet(artistMix(tracks, 10))}`,
        `## Release decades\n${bullet(decadesOf(tracks))}`,
      ),
    );
  }),
);

/* ------------------------------------------------------------------ *
 * Catalog
 * ------------------------------------------------------------------ */

server.registerTool(
  "artist_profile",
  {
    title: "Artist profile",
    description:
      "Look up an artist by name and return their catalogue - recent albums " +
      "and singles - in one call.",
    inputSchema: {
      name: z.string().describe("Artist name to search for."),
    },
  },
  guard(async ({ name }) => {
    const found = await sp.search(name, "artist", 1);
    const artist = found.artists?.items[0];
    if (!artist) return text(`No artist found for "${name}".`);

    // `/artists/{id}/top-tracks` was removed in February 2026, and genres,
    // followers and popularity are no longer on the artist object. The
    // catalogue is what remains answerable.
    const albums = await sp.artistAlbums(artist.id, 20);
    const byYear = [...albums].sort((a, b) =>
      (b.release_date ?? "").localeCompare(a.release_date ?? ""),
    );

    return text(
      sections(
        `# ${artist.name}`,
        `## Releases (most recent first)\n${byYear
          .slice(0, 15)
          .map(
            (a, i) =>
              `${i + 1}. ${a.name} (${a.release_date?.slice(0, 4) ?? "?"}${
                a.album_type ? `, ${a.album_type}` : ""
              }${a.total_tracks ? `, ${a.total_tracks} tracks` : ""})`,
          )
          .join("\n")}`,
        artist.external_urls.spotify,
      ),
    );
  }),
);

server.registerTool(
  "search_catalog",
  {
    title: "Search Spotify",
    description:
      "Search the public catalog for tracks, artists or albums.",
    inputSchema: {
      query: z.string(),
      type: z.enum(["track", "artist", "album"]).default("track"),
      // Spotify capped search at 10 in February 2026; 50 now returns HTTP 400.
      limit: z.number().int().min(1).max(sp.SEARCH_MAX_LIMIT).default(5),
    },
  },
  guard(async ({ query, type, limit }) => {
    const res = await sp.search(query, type, limit);

    if (type === "artist") {
      const items = res.artists?.items ?? [];
      if (!items.length) return text(`No artists match "${query}".`);
      return text(
        items
          .map((a, i) => `${i + 1}. ${a.name} - ${a.external_urls.spotify}`)
          .join("\n"),
      );
    }

    if (type === "album") {
      const items = res.albums?.items ?? [];
      if (!items.length) return text(`No albums match "${query}".`);
      return text(
        items
          .map(
            (a, i) =>
              `${i + 1}. ${a.name} - ${(a.artists ?? []).map((x) => x.name).join(", ") || "unknown"} (${a.release_date?.slice(0, 4) ?? "?"}, ${a.total_tracks ?? "?"} tracks)`,
          )
          .join("\n"),
      );
    }

    const items = res.tracks?.items ?? [];
    if (!items.length) return text(`No tracks match "${query}".`);
    return text(
      items
        .map(
          (t, i) =>
            `${trackLine(t, i)} - ${t.album.name} (${t.album.release_date?.slice(0, 4) ?? "?"})`,
        )
        .join("\n"),
    );
  }),
);

server.registerTool(
  "now_playing",
  {
    title: "Now playing",
    description: "What the user is listening to right now, if anything.",
    inputSchema: {},
  },
  guard(async () => {
    const state = await sp.currentlyPlaying();
    if (!state || !state.item) return text("Nothing is playing right now.");
    const { item, progress_ms, is_playing } = state;
    return text(
      `${is_playing ? "Playing" : "Paused"}: ${trackLine(item)}\n` +
        `Album: ${item.album.name} (${item.album.release_date?.slice(0, 4)})\n` +
        `Position: ${formatDuration(progress_ms)} / ${formatDuration(item.duration_ms)}\n` +
        item.external_urls.spotify,
    );
  }),
);

/* ------------------------------------------------------------------ */

async function main() {
  await server.connect(new StdioServerTransport());
  console.error("spotify MCP server ready (read-only scopes).");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
