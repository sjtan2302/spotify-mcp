/**
 * Aggregation helpers. These exist so tools return *answers* rather than raw
 * API payloads - the model should not have to tally artists or bucket release
 * years itself, and shipping it 200 raw track objects to do so wastes context.
 */
import type { Artist, PlayHistory, Track } from "./api.js";

export interface Counted {
  name: string;
  count: number;
  share: number;
}

/** Rank a bag of strings by frequency, with percentage share of the total. */
export function tally(values: string[], top: number): Counted[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const total = values.length || 1;

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([name, count]) => ({
      name,
      count,
      share: Math.round((count / total) * 100),
    }));
}

/**
 * Artist concentration: how much of a track set is carried by how few names.
 *
 * This replaces the genre breakdown this module used to compute. Genre data
 * was inherited from artist objects, and the February 2026 API revision
 * removed `genres` from Artist entirely - there is no longer any genre signal
 * at this access tier, from any endpoint. Credited-artist frequency is the
 * closest honest substitute: it still answers "is this varied or narrow", it
 * just does it by artist rather than by style.
 */
export function artistMix(tracks: Track[], top = 12): Counted[] {
  const credits = tracks.flatMap((t) => t.artists.map((a) => a.name));
  return tally(credits, top);
}

/** Share of the set held by the top N artists - a one-number diversity read. */
export function concentration(tracks: Track[], topN = 5): number {
  const credits = tracks.flatMap((t) => t.artists.map((a) => a.name));
  if (credits.length === 0) return 0;
  const leaders = tally(credits, topN).reduce((sum, c) => sum + c.count, 0);
  return Math.round((leaders / credits.length) * 100);
}

/** Release-decade distribution - a cheap proxy for "how retro is this". */
export function decadesOf(tracks: Track[]): Counted[] {
  const decades = tracks
    .map((t) => Number(t.album.release_date?.slice(0, 4)))
    .filter((year) => Number.isFinite(year) && year > 1900)
    .map((year) => `${Math.floor(year / 10) * 10}s`);

  return tally(decades, 10).sort((a, b) => a.name.localeCompare(b.name));
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export interface Movement {
  rising: string[];
  falling: string[];
  steady: string[];
}

/**
 * Compare long-term against short-term top artists. Spotify exposes three
 * fixed windows and no history, so this diff is the only way to see direction
 * of travel in someone's taste.
 */
export function movement(longTerm: Artist[], shortTerm: Artist[]): Movement {
  const longNames = new Set(longTerm.map((a) => a.name));
  const shortNames = new Set(shortTerm.map((a) => a.name));

  return {
    rising: shortTerm.filter((a) => !longNames.has(a.name)).map((a) => a.name),
    falling: longTerm.filter((a) => !shortNames.has(a.name)).map((a) => a.name),
    steady: shortTerm.filter((a) => longNames.has(a.name)).map((a) => a.name),
  };
}

/** Listening clock: which parts of the day recent plays cluster in. */
export function timeOfDay(history: PlayHistory[]): Counted[] {
  const buckets = history.map(({ played_at }) => {
    const hour = new Date(played_at).getHours();
    if (hour < 6) return "night (00-06)";
    if (hour < 12) return "morning (06-12)";
    if (hour < 18) return "afternoon (12-18)";
    return "evening (18-24)";
  });
  return tally(buckets, 4);
}

export const bullet = (items: Counted[]) =>
  items.map((i) => `  ${i.name} - ${i.count} (${i.share}%)`).join("\n");

export const trackLine = (t: Track, i?: number) =>
  `${i !== undefined ? `${i + 1}. ` : ""}${t.name} - ${t.artists
    .map((a) => a.name)
    .join(", ")}`;
