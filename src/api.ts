/**
 * Spotify Web API client: token lifecycle, pagination, id batching, and
 * rate-limit handling in one place so tool handlers stay declarative.
 */
import { AuthError, loadTokens, refreshTokens, type StoredTokens } from "./auth.js";

const API = "https://api.spotify.com/v1";
const TIMEOUT_MS = 15_000;

export class SpotifyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let cached: StoredTokens | null = null;
let inFlightRefresh: Promise<StoredTokens> | null = null;

/** Refresh 60s early, and collapse concurrent refreshes into one request. */
async function accessToken(): Promise<string> {
  cached ??= await loadTokens();

  if (Date.now() < cached.expires_at - 60_000) return cached.access_token;

  inFlightRefresh ??= refreshTokens(cached).finally(() => {
    inFlightRefresh = null;
  });
  cached = await inFlightRefresh;
  return cached.access_token;
}

/**
 * One request. Retries once on 401 (token revoked mid-flight) and honours
 * Retry-After on 429 rather than hammering a rate limit.
 */
export async function api<T>(pathAndQuery: string, retry = true): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 429) {
    const wait = Number(res.headers.get("retry-after") ?? "1");
    if (retry && wait <= 30) {
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      return api<T>(pathAndQuery, false);
    }
    throw new SpotifyError(`Rate limited; retry after ${wait}s.`, 429);
  }

  if (res.status === 401 && retry) {
    cached = null; // force a refresh and try once more
    return api<T>(pathAndQuery, false);
  }

  if (res.status === 403) {
    throw new SpotifyError(
      "Spotify returned 403. If this was audio-features, audio-analysis, " +
        "recommendations or related-artists, those were restricted for new " +
        "apps on 2024-11-27 and are permanently unavailable. Otherwise the " +
        "granted scopes may be insufficient - re-run `npm run spotify:login`.",
      403,
    );
  }

  if (!res.ok) {
    let detail = await res.text();
    try {
      detail =
        (JSON.parse(detail) as { error?: { message?: string } }).error?.message ??
        detail;
    } catch {
      /* keep raw body */
    }
    throw new SpotifyError(`Spotify ${res.status}: ${detail}`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Page<T> {
  items: T[];
  next: string | null;
  total: number;
}

/** Follow `next` links until `max` items are collected. */
export async function paginate<T>(
  firstPath: string,
  max: number,
): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = firstPath;

  while (next && out.length < max) {
    const page: Page<T> = await api<Page<T>>(next);
    out.push(...page.items);
    // `next` comes back absolute; strip the base to reuse the same client.
    next = page.next ? page.next.replace(API, "") : null;
  }
  return out.slice(0, max);
}

/* ------------------------------- entities ------------------------------- */

/**
 * Note on missing fields, verified against a live account in Feb 2026:
 * `genres`, `followers` and `popularity` are gone from Artist, and
 * `popularity` from Track. They are not optional-and-sometimes-absent; the
 * API no longer returns them at this access tier. Nothing here may depend on
 * them, so they are not declared.
 */
export interface Artist {
  id: string;
  name: string;
  external_urls: { spotify: string };
}

export interface Track {
  id: string | null;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { name: string; release_date: string };
  duration_ms: number;
  external_urls: { spotify: string };
}

export interface Album {
  id: string;
  name: string;
  album_type?: string;
  release_date: string;
  total_tracks?: number;
  artists?: Array<{ name: string }>;
  external_urls: { spotify: string };
}

export interface PlaylistSummary {
  id: string;
  name: string;
  description: string | null;
  owner: { display_name: string | null };
  public: boolean | null;
  /** Renamed from `tracks` in the February 2026 API revision. */
  items: { total: number };
  external_urls: { spotify: string };
}

export interface PlayHistory {
  track: Track;
  played_at: string;
}

export const topArtists = (timeRange: string, limit: number) =>
  api<Page<Artist>>(`/me/top/artists?time_range=${timeRange}&limit=${limit}`);

export const topTracks = (timeRange: string, limit: number) =>
  api<Page<Track>>(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`);

export const recentlyPlayed = (limit: number) =>
  api<Page<PlayHistory>>(`/me/player/recently-played?limit=${limit}`);

export const myPlaylists = (max: number) =>
  paginate<PlaylistSummary>(`/me/playlists?limit=50`, max);

/**
 * `/playlists/{id}/tracks` was renamed to `/items` in February 2026, and each
 * entry's `track` key became `item`.
 */
export const playlistItems = (id: string, max: number) =>
  paginate<{ item: Track | null }>(
    `/playlists/${id}/items?limit=50&fields=next,total,items(item(id,name,duration_ms,external_urls,album(name,release_date),artists(id,name)))`,
    max,
  );

export const savedTracks = (max: number) =>
  paginate<{ track: Track; added_at: string }>(`/me/tracks?limit=50`, max);

export const currentlyPlaying = () =>
  api<{ is_playing: boolean; item: Track | null; progress_ms: number } | undefined>(
    "/me/player/currently-playing",
  );

/**
 * Catalog endpoints cap `limit` at 10 as of February 2026 - anything higher
 * returns HTTP 400 "Invalid limit". Verified against /search and
 * /artists/{id}/albums. User endpoints (/me/*, playlists) still allow 50.
 */
export const SEARCH_MAX_LIMIT = 10;
const CATALOG_PAGE = 10;

export function search(query: string, type: string, limit: number) {
  const q = new URLSearchParams({
    q: query,
    type,
    limit: String(Math.min(limit, SEARCH_MAX_LIMIT)),
  });
  return api<{
    tracks?: Page<Track>;
    artists?: Page<Artist>;
    albums?: Page<Album>;
  }>(`/search?${q}`);
}

export const getArtist = (id: string) => api<Artist>(`/artists/${id}`);

/**
 * Stands in for the removed `/artists/{id}/top-tracks`: an artist's catalogue
 * is still reachable, so "what have they put out" remains answerable even
 * though "what is most played" no longer is.
 */
export const artistAlbums = (id: string, max = 20) =>
  paginate<Album>(
    `/artists/${id}/albums?limit=${CATALOG_PAGE}&include_groups=album,single`,
    max,
  );

export { AuthError };
