import type { Song } from "./types";

const NOISE = /official|video|audio|lyrics?|clip|\bhd\b|\b4k\b|remaster(ed)?|visuali[sz]er|премьера|клип/i;

export function cleanTitle(title: string) {
  const cleaned = title
    .replace(/[(\[{【][^)\]}】]*[)\]}】]/g, (segment) => (NOISE.test(segment) ? "" : segment))
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-–—|:·•,]+|[\s\-–—|:·•,]+$/g, "");
  return cleaned || title;
}

export const artistOf = (song: Song) => song.artist ?? song.channel;
