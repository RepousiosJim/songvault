import type { Song } from "./types";

const NOISE = /official|video|audio|lyrics?|clip|\bhd\b|\b4k\b|remaster(ed)?|visuali[sz]er|премьера|клип/i;

export function cleanTitle(title: string) {
  const cleaned = title
    .replace(/[(\[{【][^)\]}】]*[)\]}】]/g, (segment) => (NOISE.test(segment) ? "" : segment))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—|:·•,]+|[\s\-–—|:·•,]+$/g, "");
  return cleaned || title;
}

export type YouTubeLink = { kind: "video"; id: string } | { kind: "playlist"; list: string };

export function parseYouTubeLink(text: string): YouTubeLink | null {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./i, "").toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean);
  const video = (id: string | null | undefined): YouTubeLink | null =>
    id && /^[A-Za-z0-9_-]{11}$/.test(id) ? { kind: "video", id } : null;
  if (host === "youtu.be") return video(segments[0]);
  if (host !== "youtube.com") return null;
  if (segments[0] === "watch") return video(url.searchParams.get("v"));
  if (segments[0] === "shorts") return video(segments[1]);
  const list = url.searchParams.get("list");
  if (segments[0] === "playlist" && list && /^[A-Za-z0-9_-]+$/.test(list)) return { kind: "playlist", list };
  return null;
}

export const artistOf = (song: Song) => song.artist ?? song.channel;
