export interface Song {
  id: string;
  title: string;
  channel: string;
  artist?: string;
  duration: number;
  file: string;
  thumbnail: string;
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  songIds: string[];
}

export interface SearchResult {
  id: string;
  title: string;
  channel: string;
  duration: number;
}

export interface Preview {
  id: string;
  title: string;
  url?: string;
  error?: string;
}

export interface Job {
  id: string;
  url: string;
  percent: number;
  error?: string;
  log?: string;
  showLog?: boolean;
}

export type Quality = "best" | "1080" | "720" | "480";

export interface Settings {
  libraryDir: string;
  quality: Quality;
  audioOnly: boolean;
  searchCount: number;
  cutNonMusic: boolean;
}

export interface LibraryView {
  dir: string;
  songs: Song[];
  playlists: Playlist[];
}
