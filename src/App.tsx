import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  IconBrandYoutube,
  IconChevronRight,
  IconClock,
  IconCircleCheckFilled,
  IconDownload,
  IconExternalLink,
  IconFileExport,
  IconFolder,
  IconHistory,
  IconMusic,
  IconPencil,
  IconPlayerTrackNext,
  IconPlaylist,
  IconPlaylistAdd,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTrash,
  IconTrendingUp,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import type { Job, LibraryView, Playlist, PlaylistInfo, Preview, Quality, SearchResult, Settings, Song } from "./types";
import { artistOf, cleanTitle, parseYouTubeLink, type YouTubeLink } from "./songs";
import { formatDuration, isTyping, Player, type Track } from "./Player";
import { Setup } from "./Setup";
import "./App.css";

const LIBRARY = "library";
const SEARCH = "search";
const SETTINGS = "settings";

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const thumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const artworkUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const playlistUrl = (list: string) => `https://www.youtube.com/playlist?list=${list}`;
const MAX_DOWNLOADS = 3;
const isSong = (r: SearchResult) => r.duration > 0 && r.duration < 600;

type SortKey = "added" | "title" | "artist" | "length";

const SORTS: Record<SortKey, [label: string, compare: (a: Song, b: Song) => number]> = {
  added: ["Date added", (a, b) => b.addedAt - a.addedAt],
  title: ["Title", (a, b) => cleanTitle(a.title).localeCompare(cleanTitle(b.title))],
  artist: ["Artist", (a, b) => artistOf(a).localeCompare(artistOf(b))],
  length: ["Length", (a, b) => a.duration - b.duration],
};

const BULK = "bulk";

const DAY = 24 * 60 * 60 * 1000;

const SMART: Record<string, [label: string, icon: typeof IconClock, pick: (songs: Song[], now: number) => Song[]]> = {
  "smart:recent": [
    "Recently added",
    IconClock,
    (songs, now) => songs.filter((s) => now - s.addedAt < 30 * DAY).sort((a, b) => b.addedAt - a.addedAt),
  ],
  "smart:most": [
    "Most played",
    IconTrendingUp,
    (songs) =>
      songs
        .filter((s) => s.plays > 0)
        .sort((a, b) => b.plays - a.plays)
        .slice(0, 50),
  ],
  "smart:lapsed": [
    "Not played lately",
    IconHistory,
    (songs, now) =>
      songs
        .filter((s) => !s.lastPlayed || now - s.lastPlayed > 30 * DAY)
        .sort((a, b) => (a.lastPlayed ?? 0) - (b.lastPlayed ?? 0)),
  ],
};

function totalLength(songs: Song[]) {
  const mins = Math.round(songs.reduce((sum, s) => sum + s.duration, 0) / 60);
  return mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
}

function shuffled<T>(items: T[]) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function App() {
  const [dir, setDir] = useState("");
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [pending, setPending] = useState<{ ids: string[]; timer: number } | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [showJobs, setShowJobs] = useState(false);
  const [view, setView] = useState(LIBRARY);
  const [filter, setFilter] = useState("");
  const [queue, setQueue] = useState<Song[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragIds, setDragIds] = useState<string[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; song: Song; sub: boolean } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("added");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Song[]>([]);
  const [toolsReady, setToolsReady] = useState<boolean | null>(null);
  const [ytdlp, setYtdlp] = useState("");
  const [updating, setUpdating] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [installing, setInstalling] = useState(false);
  const [updateOutput, setUpdateOutput] = useState("");
  const [field, setField] = useState("");
  const latest = useRef({ jobs: [] as Job[], songs: [] as Song[], playlists: [] as Playlist[] });
  const importOrder = useRef<Record<string, string[]>>({});
  const [searchedFor, setSearchedFor] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [songsOnly, setSongsOnly] = useState(true);
  const [fromLink, setFromLink] = useState<{ playlist?: PlaylistInfo } | null>(null);
  const requests = useRef(0);
  const lookedUp = useRef("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const previewId = useRef<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(-1);
  const suggestFor = useRef("");
  const fieldRef = useRef<HTMLInputElement>(null);
  const searchedQuery = useRef("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [pendingDir, setPendingDir] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [dirError, setDirError] = useState("");

  latest.current = { jobs, songs: allSongs, playlists };

  useEffect(() => {
    const q = field.trim();
    suggestFor.current = q;
    if (!q || parseYouTubeLink(q) || q === searchedQuery.current) return setSuggestions([]);
    const timer = setTimeout(() => {
      invoke<string[]>("suggest", { query: q }).then((found) => {
        if (suggestFor.current === q) {
          setSuggestions(found);
          setHighlight(-1);
        }
      }, () => setSuggestions([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [field]);

  const link = parseYouTubeLink(field);
  const linkKey = link ? (link.kind === "video" ? link.id : `list:${link.list}`) : "";

  useEffect(() => {
    if (!link) {
      lookedUp.current = "";
      return;
    }
    const timer = setTimeout(() => lookedUp.current !== linkKey && lookUp(link), 300);
    return () => clearTimeout(timer);
  }, [linkKey]);

  useEffect(() => {
    invoke<boolean>("tools_ready").then(setToolsReady);
    invoke<LibraryView>("get_library").then(applyLibrary);
    invoke<Settings>("get_settings").then(setSettings);

    const unlisten = Promise.all([
      listen<{ jobId: string; percent: number }>("download-progress", ({ payload }) =>
        setJobs((js) => js.map((j) => (j.id === payload.jobId ? { ...j, percent: payload.percent } : j))),
      ),
      listen<{ jobId: string; song: Song }>("download-done", ({ payload }) => {
        const into = latest.current.jobs.find((j) => j.id === payload.jobId)?.into;
        setJobs((js) => js.filter((j) => j.id !== payload.jobId));
        if (into) insertImported(into, payload.song.id);
        else setJustAdded((a) => [...a.filter((s) => s.id !== payload.song.id), payload.song]);
        setAllSongs((ss) =>
          ss.some((s) => s.id === payload.song.id)
            ? ss.map((s) => (s.id === payload.song.id ? payload.song : s))
            : [...ss, payload.song],
        );
      }),
      listen<{ id: string; gain: number }>("gain-measured", ({ payload }) => {
        const patch = (s: Song) => (s.id === payload.id ? { ...s, gain: payload.gain } : s);
        setAllSongs((ss) => ss.map(patch));
        setQueue((q) => q.map(patch));
      }),
      listen<{ jobId: string; message: string; log: string }>("download-error", ({ payload }) =>
        setJobs((js) =>
          js.map((j) => (j.id === payload.jobId ? { ...j, error: payload.message, log: payload.log } : j)),
        ),
      ),
    ]);
    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    const running = jobs.filter((j) => !j.queued && !j.error).length;
    const next = jobs.filter((j) => j.queued).slice(0, MAX_DOWNLOADS - running);
    if (!next.length) return;
    setJobs((js) => js.map((j) => (next.some((n) => n.id === j.id) ? { ...j, queued: false } : j)));
    next.forEach((j) => invoke("download", { jobId: j.id, url: j.url }));
  }, [jobs]);

  useEffect(() => {
    setExpanded(false);
    setSelected(new Set());
  }, [view]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        fieldRef.current?.focus();
        fieldRef.current?.select();
      }
      if (isTyping(e.target)) return;
      if (e.key === "Escape") {
        if (ctx || menuFor) {
          setCtx(null);
          setMenuFor(null);
        } else if (expanded) setExpanded(false);
        else setSelected(new Set());
      }
      if (e.key === "Delete" && selected.size) deleteSongs([...selected]);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (!toolsReady) return;
    invoke<string>("ytdlp_version").then(setYtdlp, (e) => setYtdlp(String(e)));
    invoke<string | null>("auto_update_ytdlp").then((version) => version && setYtdlp(version), () => {});
  }, [toolsReady]);

  useEffect(() => {
    check().then((found) => found && setUpdate(found), () => {});
  }, []);

  function applyLibrary(lib: LibraryView) {
    setDir(lib.dir);
    setAllSongs(lib.songs);
    setPlaylists(lib.playlists);
  }

  function updateSettings(patch: Partial<Pick<Settings, "quality" | "audioOnly" | "searchCount" | "cutNonMusic" | "evenVolume">>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    invoke("save_settings", {
      quality: next.quality,
      audioOnly: next.audioOnly,
      searchCount: next.searchCount,
      cutNonMusic: next.cutNonMusic,
      evenVolume: next.evenVolume,
    });
  }

  async function pickFolder() {
    const picked = await open({ directory: true, defaultPath: dir });
    if (picked) setPendingDir(picked);
  }

  async function changeDir(moveSongs: boolean) {
    if (!pendingDir) return;
    setMoving(true);
    setDirError("");
    try {
      const lib = await invoke<LibraryView>("change_library_dir", { path: pendingDir, moveSongs });
      applyLibrary(lib);
      setSettings((s) => s && { ...s, libraryDir: lib.dir });
      setQueue([]);
      setPlayingId(null);
      setPendingDir(null);
    } catch (e) {
      setDirError(String(e));
    }
    setMoving(false);
  }

  const songs = useMemo(() => allSongs.filter((s) => !pending?.ids.includes(s.id)), [allSongs, pending]);
  const playlist = playlists.find((p) => p.id === view);

  const smartLists = useMemo(
    () => Object.fromEntries(Object.entries(SMART).map(([key, [, , pick]]) => [key, pick(songs, Date.now())])),
    [songs],
  );

  const visible = useMemo(() => {
    if (smartLists[view]) return smartLists[view];
    if (playlist) {
      const byId = new Map(songs.map((s) => [s.id, s]));
      return playlist.songIds.flatMap((id) => byId.get(id) ?? []);
    }
    const q = filter.trim().toLowerCase();
    return [...songs]
      .sort(SORTS[sort][1])
      .filter((s) => !q || cleanTitle(s.title).toLowerCase().includes(q) || artistOf(s).toLowerCase().includes(q));
  }, [songs, smartLists, view, playlist, filter, sort]);

  const ctxIds = ctx ? (selected.has(ctx.song.id) ? [...selected] : [ctx.song.id]) : [];
  const queueIndex = queue.findIndex((s) => s.id === playingId);
  const playing = queue[queueIndex];
  const activeJobs = jobs.filter((j) => !j.error);
  const failedJobs = jobs.filter((j) => j.error);
  const importable = fromLink?.playlist;
  const shownResults = songsOnly && !fromLink ? results.filter(isSong) : results;

  function startDownload(target: string, extra: Partial<Job> = {}) {
    setJobs((js) => [...js, { id: crypto.randomUUID(), url: target, percent: 0, queued: true, ...extra }]);
  }

  function submitField(text = field) {
    const q = text.trim();
    if (!q) return;
    const typed = parseYouTubeLink(q);
    if (typed) lookUp(typed);
    else runSearch(q);
  }

  async function lookUp(target: YouTubeLink) {
    const request = ++requests.current;
    lookedUp.current = target.kind === "video" ? target.id : `list:${target.list}`;
    suggestFor.current = "";
    setSuggestions([]);
    setView(SEARCH);
    setFromLink({});
    setResults([]);
    setSearching(true);
    setSearchError("");
    try {
      if (target.kind === "video") {
        const found = await invoke<SearchResult>("video_info", { url: watchUrl(target.id) });
        if (request === requests.current) setResults([found]);
      } else {
        const info = await invoke<PlaylistInfo>("playlist_info", { url: playlistUrl(target.list) });
        if (request !== requests.current) return;
        setResults(info.entries);
        setFromLink({ playlist: info });
      }
    } catch (e) {
      if (request !== requests.current) return;
      setSearchError(String(e));
    }
    if (request === requests.current) setSearching(false);
  }

  function importPlaylist(info: PlaylistInfo) {
    const id = crypto.randomUUID();
    const order = [...new Set(info.entries.map((e) => e.id))];
    importOrder.current[id] = order;
    const have = new Set(latest.current.songs.map((s) => s.id));
    savePlaylists([
      ...latest.current.playlists,
      { id, name: info.title, songIds: order.filter((songId) => have.has(songId)) },
    ]);
    info.entries
      .filter((e) => !have.has(e.id))
      .forEach((e) => startDownload(watchUrl(e.id), { into: id, title: e.title }));
    setView(id);
  }

  function insertImported(playlistId: string, songId: string) {
    const order = importOrder.current[playlistId];
    savePlaylists(
      latest.current.playlists.map((p) => {
        if (p.id !== playlistId || p.songIds.includes(songId)) return p;
        const at = p.songIds.findIndex((id) => order.indexOf(id) > order.indexOf(songId));
        const songIds = [...p.songIds];
        songIds.splice(at < 0 ? songIds.length : at, 0, songId);
        return { ...p, songIds };
      }),
    );
  }

  async function runSearch(q: string) {
    const request = ++requests.current;
    setFromLink(null);
    suggestFor.current = "";
    searchedQuery.current = q;
    setSuggestions([]);
    setField(q);
    setView(SEARCH);
    setSearchedFor(q);
    setSearching(true);
    setSearchError("");
    try {
      const found = await invoke<SearchResult[]>("search", { query: q });
      if (request !== requests.current) return;
      setResults(found);
      if (!found.length) setSearchError(`No results for "${q}".`);
    } catch (e) {
      if (request !== requests.current) return;
      setSearchError(String(e));
    }
    setSearching(false);
  }

  async function previewResult(r: SearchResult) {
    previewId.current = r.id;
    setPlayingId(null);
    setPreview({ id: r.id, title: r.title });
    try {
      const streamUrl = await invoke<string>("stream_url", { id: r.id });
      if (previewId.current === r.id) setPreview({ id: r.id, title: r.title, url: streamUrl });
    } catch (e) {
      if (previewId.current === r.id) setPreview({ id: r.id, title: r.title, error: String(e) });
    }
  }

  async function installUpdate() {
    if (!update) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall();
      await relaunch();
    } catch {
      setInstalling(false);
    }
  }

  async function updateYtdlp() {
    setUpdating(true);
    try {
      const result = await invoke<{ version: string; output: string }>("update_ytdlp");
      setYtdlp(result.version);
      setUpdateOutput(result.output);
    } catch (e) {
      setUpdateOutput(String(e));
    }
    setUpdating(false);
  }

  function savePlaylists(next: Playlist[]) {
    latest.current.playlists = next;
    setPlaylists(next);
    invoke("save_playlists", { playlists: next });
  }

  function createPlaylist(name: string) {
    setCreating(false);
    if (!name.trim()) return;
    const created = { id: crypto.randomUUID(), name: name.trim(), songIds: [] };
    savePlaylists([...playlists, created]);
    setView(created.id);
  }

  function fileJustAdded(song: Song, target: { playlistId: string } | { newName: string } | null) {
    setJustAdded((a) => a.filter((s) => s.id !== song.id));
    if (!target) return;
    if ("playlistId" in target) return addToPlaylist(target.playlistId, [song.id]);
    savePlaylists([...playlists, { id: crypto.randomUUID(), name: target.newName, songIds: [song.id] }]);
  }

  function renamePlaylist(id: string, name: string) {
    setRenamingId(null);
    if (!name.trim()) return;
    savePlaylists(playlists.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)));
  }

  async function exportPlaylist(p: Playlist) {
    const path = await save({
      defaultPath: `${dir}\\${p.name.replace(/[\\/:*?"<>|]/g, "_")}.m3u8`,
      filters: [{ name: "Playlist", extensions: ["m3u8"] }],
    });
    if (path) invoke("export_m3u", { playlistId: p.id, path });
  }

  function deletePlaylist(p: Playlist) {
    if (!window.confirm(`Delete playlist "${p.name}"?`)) return;
    savePlaylists(playlists.filter((x) => x.id !== p.id));
    setView(LIBRARY);
  }

  function addToPlaylist(playlistId: string, ids: string[]) {
    setMenuFor(null);
    savePlaylists(
      playlists.map((p) =>
        p.id === playlistId ? { ...p, songIds: [...p.songIds, ...ids.filter((id) => !p.songIds.includes(id))] } : p,
      ),
    );
  }

  function updateSongIds(update: (ids: string[]) => string[]) {
    savePlaylists(playlists.map((p) => (p.id === view ? { ...p, songIds: update(p.songIds) } : p)));
  }

  function moveSong(from: number, to: number) {
    updateSongIds((ids) => {
      const next = [...ids];
      next.splice(to, 0, next.splice(from, 1)[0]);
      return next;
    });
  }

  function deleteSongs(ids: string[]) {
    if (pending) clearTimeout(pending.timer);
    const all = [...(pending?.ids ?? []), ...ids];
    setPending({ ids: all, timer: window.setTimeout(() => commitDelete(all), 5000) });
    setQueue((q) => q.filter((s) => !ids.includes(s.id)));
    if (playingId && ids.includes(playingId)) setPlayingId(null);
    setSelected(new Set());
  }

  function commitDelete(ids: string[]) {
    Promise.allSettled(
      ids.map((id) =>
        invoke("delete_song", { id }).then(() => {
          setAllSongs((ss) => ss.filter((s) => s.id !== id));
          setPlaylists((ps) => ps.map((p) => ({ ...p, songIds: p.songIds.filter((x) => x !== id) })));
        }),
      ),
    ).then(() => setPending(null));
  }

  function undoDelete() {
    if (pending) clearTimeout(pending.timer);
    setPending(null);
  }

  function recordPlay(id: string) {
    invoke<Song>("record_play", { id }).then(({ plays, lastPlayed }) => {
      const patch = (s: Song) => (s.id === id ? { ...s, plays, lastPlayed } : s);
      setAllSongs((ss) => ss.map(patch));
      setQueue((q) => q.map(patch));
    });
  }

  function editSong(song: Song, edit: { title: string; artist: string } | null) {
    setEditingId(null);
    if (!edit) return;
    const patch = (s: Song) => (s.id === song.id ? { ...s, title: edit.title, artist: edit.artist || undefined } : s);
    setAllSongs((ss) => ss.map(patch));
    setQueue((q) => q.map(patch));
    invoke("edit_song", { id: song.id, title: edit.title, artist: edit.artist });
  }

  function pick(i: number, range: boolean) {
    if (range && anchor.current !== null) {
      const [lo, hi] = [anchor.current, i].sort((a, b) => a - b);
      setSelected(new Set(visible.slice(lo, hi + 1).map((s) => s.id)));
      return;
    }
    anchor.current = i;
    const id = visible[i].id;
    setSelected((sel) => {
      const next = new Set(sel);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function play(song: Song) {
    previewId.current = null;
    setPreview(null);
    setQueue(shuffle ? [song, ...shuffled(visible.filter((s) => s.id !== song.id))] : visible);
    setPlayingId(song.id);
  }

  function playNext(song: Song) {
    if (!playing) return play(song);
    if (song.id === playing.id) return;
    setQueue((q) => {
      const rest = q.filter((s) => s.id !== song.id);
      rest.splice(rest.findIndex((s) => s.id === playing.id) + 1, 0, song);
      return rest;
    });
  }

  function toggleShuffle() {
    const on = !shuffle;
    setShuffle(on);
    if (on && playing) setQueue([playing, ...shuffled(queue.filter((s) => s.id !== playing.id))]);
  }

  function step(delta: number) {
    const target = queueIndex + delta;
    const next = queue[target] ?? (repeat ? queue[(target + queue.length) % queue.length] : undefined);
    if (next) setPlayingId(next.id);
  }

  const track: Track | null = preview
    ? {
        key: `preview-${preview.id}`,
        src: preview.url,
        artwork: artworkUrl(preview.id),
        audioOnly: true,
        title: cleanTitle(preview.title),
        status: preview.error ?? (preview.url ? "Preview" : "Loading preview…"),
      }
    : playing
      ? {
          key: playing.id,
          src: convertFileSrc(`${dir}\\${playing.file}`),
          artwork: artworkUrl(playing.id),
          audioOnly: playing.file.endsWith(".m4a"),
          title: cleanTitle(playing.title),
          artist: artistOf(playing),
          gain: settings?.evenVolume ? playing.gain : undefined,
        }
      : null;
  const previewDownloadable =
    preview && !songs.some((s) => s.id === preview.id) && !activeJobs.some((j) => j.url === watchUrl(preview.id));

  const heading =
    view === SEARCH
      ? fromLink
        ? (fromLink.playlist?.title ?? "From link")
        : searchedFor
          ? `Results for "${searchedFor}"`
          : "Search"
      : playlist
        ? playlist.name
        : (SMART[view]?.[0] ?? "Library");

  if (toolsReady === false) return <Setup onReady={() => setToolsReady(true)} />;

  return (
    <div
      className="app"
      onClick={() => {
        setMenuFor(null);
        setCtx(null);
      }}
      onContextMenu={() => setCtx(null)}
    >
      <header className="topbar">
        <div className="field">
          <IconSearch size={16} />
          <input
            ref={fieldRef}
            value={field}
            placeholder="Paste a YouTube link or search"
            onChange={(e) => setField(e.target.value)}
            onBlur={() => setSuggestions([])}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => Math.max(-1, Math.min(suggestions.length - 1, h + delta)));
              }
              if (e.key === "Enter") submitField(suggestions[highlight] ?? field);
              if (e.key === "Escape") setSuggestions([]);
            }}
          />
          {field && (
            <button className="icon" aria-label="Clear" onClick={() => setField("")}>
              <IconX size={14} />
            </button>
          )}
          {suggestions.length > 0 && (
            <ul className="suggestions">
              {suggestions.map((s, i) => (
                <li
                  key={s}
                  className={i === highlight ? "active" : undefined}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    runSearch(s);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                >
                  <IconSearch size={14} />
                  {s}
                </li>
              ))}
            </ul>
          )}
        </div>
        {update && (
          <button className="pill update" disabled={installing} onClick={installUpdate}>
            {installing ? "Updating…" : `Update to v${update.version}`}
          </button>
        )}
        {jobs.length > 0 && (
          <div className="downloads" onClick={(e) => e.stopPropagation()}>
            <button className={failedJobs.length ? "pill failed" : "pill"} onClick={() => setShowJobs((s) => !s)}>
              <IconDownload size={16} />
              {activeJobs.length > 0 &&
                `${activeJobs.length} · ${Math.round(
                  activeJobs.reduce((sum, j) => sum + j.percent, 0) / activeJobs.length,
                )}%`}
              {failedJobs.length > 0 && <span className="failed-count">{failedJobs.length} failed</span>}
            </button>
            {showJobs && (
              <ul className="jobs">
                {jobs.map((job) => (
                  <li key={job.id} className={job.error ? "failed" : undefined}>
                    <span className="job-url">{job.title ?? job.url}</span>
                    {job.error ? (
                      <>
                        <span className="job-error">{job.error}</span>
                        <button
                          onClick={() =>
                            setJobs((js) => js.map((j) => (j.id === job.id ? { ...j, showLog: !j.showLog } : j)))
                          }
                        >
                          Log
                        </button>
                        <button
                          className="icon"
                          aria-label="Dismiss"
                          onClick={() => setJobs((js) => js.filter((j) => j.id !== job.id))}
                        >
                          <IconX size={14} />
                        </button>
                        {job.showLog && <pre className="job-log">{job.log}</pre>}
                      </>
                    ) : (
                      <>
                        <progress value={job.queued ? 0 : job.percent} max={100} />
                        <span className="job-percent">{job.queued ? "Queued" : `${Math.round(job.percent)}%`}</span>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </header>

      <aside className="sidebar">
        <button
          className={view === SEARCH ? "nav active" : "nav"}
          onClick={() => {
            setView(SEARCH);
            fieldRef.current?.focus();
          }}
        >
          <IconBrandYoutube size={18} />
          <span className="nav-label">Search</span>
        </button>
        <button className={view === LIBRARY ? "nav active" : "nav"} onClick={() => setView(LIBRARY)}>
          <IconMusic size={18} />
          <span className="nav-label">Library</span>
          <span className="count">{songs.length}</span>
        </button>
        <div className="sidebar-head">
          <span>Smart</span>
        </div>
        {Object.entries(SMART).map(([key, [label, Icon]]) => (
          <button key={key} className={view === key ? "nav active" : "nav"} onClick={() => setView(key)}>
            <Icon size={18} />
            <span className="nav-label">{label}</span>
            <span className="count">{smartLists[key].length}</span>
          </button>
        ))}
        <div className="sidebar-head">
          <span>Playlists</span>
          <button className="icon" aria-label="New playlist" onClick={() => setCreating(true)}>
            <IconPlus size={16} />
          </button>
        </div>
        {creating && <NameInput placeholder="Playlist name" onDone={createPlaylist} />}
        {playlists.map((p) =>
          renamingId === p.id ? (
            <NameInput key={p.id} initial={p.name} onDone={(name) => renamePlaylist(p.id, name)} />
          ) : (
            <div
              key={p.id}
              className={`nav playlist${view === p.id ? " active" : ""}${dropTarget === p.id ? " drop" : ""}`}
              onClick={() => setView(p.id)}
              onDragOver={(e) => {
                if (!dragIds) return;
                e.preventDefault();
                setDropTarget(p.id);
              }}
              onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDropTarget(null)}
              onDrop={() => {
                if (dragIds) addToPlaylist(p.id, dragIds);
                setDropTarget(null);
              }}
            >
              <IconPlaylist size={18} />
              <span className="nav-label">{p.name}</span>
              {view === p.id ? (
                <span className="row-tools">
                  <button className="icon" aria-label="Rename" onClick={() => setRenamingId(p.id)}>
                    <IconPencil size={14} />
                  </button>
                  <button className="icon" aria-label="Export M3U" onClick={() => exportPlaylist(p)}>
                    <IconFileExport size={14} />
                  </button>
                  <button className="icon" aria-label="Delete playlist" onClick={() => deletePlaylist(p)}>
                    <IconTrash size={14} />
                  </button>
                </span>
              ) : (
                <span className="count">{p.songIds.length}</span>
              )}
            </div>
          ),
        )}
        <button className={view === SETTINGS ? "nav active settings-nav" : "nav settings-nav"} onClick={() => setView(SETTINGS)}>
          <IconSettings size={18} />
          <span className="nav-label">Settings</span>
        </button>
      </aside>

      <main className="main">
        {view === SETTINGS ? (
          settings && (
            <div className="settings">
              <h1>Settings</h1>
              <div className="setting">
                <span>Library folder</span>
                <span className="setting-value">{dir}</span>
                <button disabled={moving || activeJobs.length > 0} onClick={pickFolder}>
                  {moving ? "Moving…" : "Change…"}
                </button>
              </div>
              {pendingDir && (
                <div className="setting-choice">
                  <span className="setting-value">{pendingDir}</span>
                  <button disabled={moving} onClick={() => changeDir(true)}>
                    Move songs
                  </button>
                  <button disabled={moving} onClick={() => changeDir(false)}>
                    Switch only
                  </button>
                  <button disabled={moving} onClick={() => setPendingDir(null)}>
                    Cancel
                  </button>
                </div>
              )}
              {dirError && <div className="error">{dirError}</div>}
              <label className="setting">
                <span>Quality</span>
                <select value={settings.quality} onChange={(e) => updateSettings({ quality: e.target.value as Quality })}>
                  <option value="best">Best</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select>
              </label>
              <label className="setting">
                <span>Audio only</span>
                <input
                  type="checkbox"
                  checked={settings.audioOnly}
                  onChange={(e) => updateSettings({ audioOnly: e.target.checked })}
                />
              </label>
              <label className="setting">
                <span>Cut non-music parts</span>
                <input
                  type="checkbox"
                  checked={settings.cutNonMusic}
                  onChange={(e) => updateSettings({ cutNonMusic: e.target.checked })}
                />
              </label>
              <label className="setting">
                <span>Even volume</span>
                <input
                  type="checkbox"
                  checked={settings.evenVolume}
                  onChange={(e) => updateSettings({ evenVolume: e.target.checked })}
                />
              </label>
              <label className="setting">
                <span>Search results</span>
                <select
                  value={settings.searchCount}
                  onChange={(e) => updateSettings({ searchCount: Number(e.target.value) })}
                >
                  {[10, 20, 30, 50].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <div className="setting">
                <span>yt-dlp</span>
                <span className="setting-value">{ytdlp}</span>
                <button disabled={updating} onClick={updateYtdlp}>
                  {updating ? "Updating…" : "Update"}
                </button>
              </div>
              {updateOutput && <div className="setting-note">{updateOutput}</div>}
            </div>
          )
        ) : (
          <>
            <div className="view-head">
              <h1>{heading}</h1>
              <span className="view-meta">
                {view === SEARCH
                  ? searching
                    ? "Searching…"
                    : importable
                      ? `${results.length} songs`
                      : results.length > 0 &&
                      (shownResults.length < results.length
                        ? `${shownResults.length} songs · ${results.length - shownResults.length} hidden`
                        : `${results.length} results`)
                  : `${visible.length} ${visible.length === 1 ? "song" : "songs"} · ${totalLength(visible)}`}
              </span>
              {view === SEARCH && importable && (
                <button onClick={() => importPlaylist(importable)}>
                  <IconPlaylistAdd size={16} /> Import playlist
                </button>
              )}
              {view === LIBRARY && (
                <>
                  <input
                    className="filter"
                    value={filter}
                    placeholder="Filter"
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <select className="sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                    {Object.entries(SORTS).map(([key, [label]]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
            {selected.size > 0 && (
              <div className="bulk" onClick={(e) => e.stopPropagation()}>
                <span>{selected.size} selected</span>
                <span className="bulk-add">
                  <button onClick={() => setMenuFor(menuFor === BULK ? null : BULK)}>
                    <IconPlaylistAdd size={16} /> Add to playlist
                  </button>
                  {menuFor === BULK && (
                    <ul className="menu">
                      <PlaylistItems
                        playlists={playlists}
                        ids={[...selected]}
                        onPick={(playlistId) => addToPlaylist(playlistId, [...selected])}
                      />
                    </ul>
                  )}
                </span>
                <button onClick={() => deleteSongs([...selected])}>
                  <IconTrash size={16} /> Delete
                </button>
              </div>
            )}
            {view === SEARCH && !fromLink && results.length > 0 && (
              <div className="chips">
                <button className={songsOnly ? "chip on" : "chip"} onClick={() => setSongsOnly(true)}>
                  Songs
                </button>
                <button className={songsOnly ? "chip" : "chip on"} onClick={() => setSongsOnly(false)}>
                  Everything
                </button>
              </div>
            )}
            {view === SEARCH && searchError && <div className="error">{searchError}</div>}
            {view === SEARCH && !searchedFor && !fromLink && (
              <button className="search-empty" onClick={() => fieldRef.current?.focus()}>
                <IconSearch size={36} />
                <span>Type a song or artist in the field above</span>
              </button>
            )}
            <ul className="songs">
              {view === SEARCH
                ? shownResults.map((r) => {
                    const inLibrary = songs.some((s) => s.id === r.id);
                    const active = activeJobs.find((j) => j.url === watchUrl(r.id));
                    const failed = failedJobs.find((j) => j.url === watchUrl(r.id));
                    return (
                      <li
                        key={r.id}
                        className={preview?.id === r.id ? "song playing" : "song"}
                        onClick={() => previewResult(r)}
                      >
                        <img src={thumbnailUrl(r.id)} alt="" />
                        <span className="meta">
                          <span className="title">{cleanTitle(r.title)}</span>
                          <span className="channel">{r.channel}</span>
                          {active && (
                            <span className="row-progress">
                              <span style={{ width: `${active.percent}%` }} />
                            </span>
                          )}
                        </span>
                        <span className="duration">{r.duration ? formatDuration(r.duration) : ""}</span>
                        <span className="actions always" onClick={(e) => e.stopPropagation()}>
                          {inLibrary ? (
                            <span className="in-library">
                              <IconCircleCheckFilled size={16} /> In library
                            </span>
                          ) : active ? (
                            <span className="tag">{active.queued ? "Queued" : `${Math.round(active.percent)}%`}</span>
                          ) : failed ? (
                            <button
                              className="icon"
                              aria-label="Retry"
                              onClick={() => {
                                setJobs((js) => js.filter((j) => j.id !== failed.id));
                                startDownload(watchUrl(r.id));
                              }}
                            >
                              <IconRefresh size={18} />
                            </button>
                          ) : (
                            <button className="icon" aria-label="Download" onClick={() => startDownload(watchUrl(r.id))}>
                              <IconDownload size={18} />
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })
                : visible.map((song, i) => (
                    <li
                      key={song.id}
                      className={`song${song.id === playingId ? " playing" : ""}${selected.has(song.id) ? " picked" : ""}`}
                      draggable={editingId !== song.id}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setMenuFor(null);
                        setCtx({ x: e.clientX, y: e.clientY, song, sub: false });
                      }}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "copyMove";
                        e.dataTransfer.setData("text/plain", song.id);
                        setDragIds(selected.has(song.id) ? [...selected] : [song.id]);
                        if (playlist) setDragIndex(i);
                      }}
                      onDragOver={(e) => dragIndex !== null && e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== i) moveSong(dragIndex, i);
                        setDragIndex(null);
                      }}
                      onDragEnd={() => {
                        setDragIds(null);
                        setDropTarget(null);
                        setDragIndex(null);
                      }}
                      onClick={(e) => (e.ctrlKey || e.shiftKey ? pick(i, e.shiftKey) : play(song))}
                    >
                      <img src={song.thumbnail} alt="" />
                      <input
                        className="pick"
                        type="checkbox"
                        aria-label="Select"
                        checked={selected.has(song.id)}
                        readOnly
                        onClick={(e) => {
                          e.stopPropagation();
                          pick(i, e.shiftKey);
                        }}
                      />
                      {editingId === song.id ? (
                        <EditSong song={song} onDone={(edit) => editSong(song, edit)} />
                      ) : (
                        <span className="meta">
                          <span className="title">{cleanTitle(song.title)}</span>
                          <span className="channel">{artistOf(song)}</span>
                        </span>
                      )}
                      <span className="duration">
                        {song.id === playingId ? <IconVolume size={16} /> : formatDuration(song.duration)}
                      </span>
                      <span
                        className={menuFor === song.id ? "actions always" : "actions"}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button className="icon" aria-label="Edit" onClick={() => setEditingId(song.id)}>
                          <IconPencil size={16} />
                        </button>
                        {playlist ? (
                          <button
                            className="icon"
                            aria-label="Remove from playlist"
                            onClick={() => updateSongIds((ids) => ids.filter((id) => id !== song.id))}
                          >
                            <IconX size={16} />
                          </button>
                        ) : (
                          <>
                            <button
                              className="icon"
                              aria-label="Add to playlist"
                              onClick={() => setMenuFor(menuFor === song.id ? null : song.id)}
                            >
                              <IconPlaylistAdd size={18} />
                            </button>
                            <button className="icon" aria-label="Delete" onClick={() => deleteSongs([song.id])}>
                              <IconTrash size={16} />
                            </button>
                            {menuFor === song.id && (
                              <ul className="menu">
                                <PlaylistItems
                                  playlists={playlists}
                                  ids={[song.id]}
                                  onPick={(playlistId) => addToPlaylist(playlistId, [song.id])}
                                />
                              </ul>
                            )}
                          </>
                        )}
                      </span>
                    </li>
                  ))}
            </ul>
          </>
        )}
      </main>

      {ctx && (
        <ul
          className="menu ctx"
          style={{ left: Math.min(ctx.x, innerWidth - 220), top: Math.min(ctx.y, innerHeight - 280) }}
          onClick={(e) => e.stopPropagation()}
        >
          <li
            onClick={() => {
              playNext(ctx.song);
              setCtx(null);
            }}
          >
            <IconPlayerTrackNext size={16} /> Play next
          </li>
          <li onClick={() => setCtx({ ...ctx, sub: !ctx.sub })}>
            <IconPlaylistAdd size={16} /> Add to playlist <IconChevronRight size={14} className="chevron" />
          </li>
          {ctx.sub && (
            <PlaylistItems
              nested
              playlists={playlists}
              ids={ctxIds}
              onPick={(playlistId) => {
                addToPlaylist(playlistId, ctxIds);
                setCtx(null);
              }}
            />
          )}
          <li
            onClick={() => {
              setEditingId(ctx.song.id);
              setCtx(null);
            }}
          >
            <IconPencil size={16} /> Edit title and artist
          </li>
          <li
            onClick={() => {
              invoke("reveal_song", { id: ctx.song.id });
              setCtx(null);
            }}
          >
            <IconFolder size={16} /> Show in folder
          </li>
          <li
            onClick={() => {
              invoke("open_youtube", { id: ctx.song.id });
              setCtx(null);
            }}
          >
            <IconExternalLink size={16} /> Open on YouTube
          </li>
          <li
            onClick={() => {
              deleteSongs(ctxIds);
              setCtx(null);
            }}
          >
            <IconTrash size={16} /> Delete
          </li>
        </ul>
      )}

      {pending && (
        <div className="toast" onClick={(e) => e.stopPropagation()}>
          {pending.ids.length === 1 ? "Song deleted" : `${pending.ids.length} songs deleted`} ·
          <button className="link" onClick={undoDelete}>
            Undo
          </button>
        </div>
      )}

      {justAdded[0] && (
        <PlaylistPrompt
          key={justAdded[0].id}
          song={justAdded[0]}
          waiting={justAdded.length - 1}
          playlists={playlists}
          onDone={(target) => fileJustAdded(justAdded[0], target)}
        />
      )}

      <Player
        track={track}
        upNext={preview ? [] : queue.slice(queueIndex + 1)}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((e) => !e)}
        canPrev={!preview && (queueIndex > 0 || (repeat && queue.length > 1))}
        canNext={!preview && queueIndex >= 0 && (queueIndex < queue.length - 1 || (repeat && queue.length > 1))}
        shuffle={shuffle}
        repeat={repeat}
        onPrev={() => step(-1)}
        onNext={() => step(1)}
        onEnded={() => !preview && step(1)}
        onShuffle={toggleShuffle}
        onRepeat={() => setRepeat((r) => !r)}
        onPick={(s) => setPlayingId(s.id)}
        onPlayed={playing && !preview ? () => recordPlay(playing.id) : undefined}
        onDownload={previewDownloadable ? () => startDownload(watchUrl(preview.id)) : undefined}
      />
    </div>
  );
}

function PlaylistPrompt({
  song,
  waiting,
  playlists,
  onDone,
}: {
  song: Song;
  waiting: number;
  playlists: Playlist[];
  onDone: (target: { playlistId: string } | { newName: string } | null) => void;
}) {
  const [naming, setNaming] = useState(false);
  return (
    <div className="prompt" onClick={(e) => e.stopPropagation()}>
      <img className="prompt-art" src={song.thumbnail} alt="" />
      <div className="prompt-body">
        <div className="prompt-head">
          <span className="prompt-done">
            <IconCircleCheckFilled size={16} /> Downloaded
            {waiting > 0 && <span className="prompt-waiting">+{waiting} more</span>}
          </span>
          <button className="icon" aria-label="Skip" onClick={() => onDone(null)}>
            <IconX size={16} />
          </button>
        </div>
        <div className="prompt-title">{cleanTitle(song.title)}</div>
        <div className="prompt-channel">{artistOf(song)}</div>
        <div className="prompt-label">Add to playlist</div>
        <div className="prompt-chips">
          {playlists.map((p) => (
            <button key={p.id} className="prompt-chip" onClick={() => onDone({ playlistId: p.id })}>
              <IconPlaylist size={15} />
              {p.name}
              <span className="count">{p.songIds.length}</span>
            </button>
          ))}
          {naming ? (
            <input
              className="prompt-name"
              autoFocus
              placeholder="Playlist name"
              onBlur={() => setNaming(false)}
              onKeyDown={(e) => {
                const name = e.currentTarget.value.trim();
                if (e.key === "Enter" && name) onDone({ newName: name });
                if (e.key === "Escape") setNaming(false);
              }}
            />
          ) : (
            <button className="prompt-chip new" onClick={() => setNaming(true)}>
              <IconPlus size={15} />
              New playlist
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PlaylistItems({
  playlists,
  ids,
  nested,
  onPick,
}: {
  playlists: Playlist[];
  ids: string[];
  nested?: boolean;
  onPick: (playlistId: string) => void;
}) {
  return (
    <>
      {playlists.length === 0 && <li className={nested ? "disabled nested" : "disabled"}>No playlists</li>}
      {playlists.map((p) => (
        <li
          key={p.id}
          className={[nested && "nested", ids.every((id) => p.songIds.includes(id)) && "disabled"].filter(Boolean).join(" ") || undefined}
          onClick={() => onPick(p.id)}
        >
          {p.name}
        </li>
      ))}
    </>
  );
}

function EditSong({ song, onDone }: { song: Song; onDone: (edit: { title: string; artist: string } | null) => void }) {
  const form = useRef<HTMLSpanElement>(null);
  const settled = useRef(false);

  function finish(save: boolean) {
    if (settled.current) return;
    settled.current = true;
    const [title, artist] = Array.from(form.current!.querySelectorAll("input"), (i) => i.value.trim());
    onDone(save && title ? { title, artist } : null);
  }

  return (
    <span
      ref={form}
      className="meta edit"
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => e.currentTarget.contains(e.relatedTarget) || finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") finish(false);
      }}
    >
      <input autoFocus defaultValue={cleanTitle(song.title)} placeholder="Title" />
      <input defaultValue={artistOf(song)} placeholder="Artist" />
    </span>
  );
}

function NameInput({
  initial = "",
  placeholder,
  onDone,
}: {
  initial?: string;
  placeholder?: string;
  onDone: (name: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => ref.current?.select(), []);

  function finish(name: string) {
    if (settled.current) return;
    settled.current = true;
    onDone(name);
  }

  return (
    <input
      ref={ref}
      className="name-input"
      autoFocus
      defaultValue={initial}
      placeholder={placeholder}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish("");
      }}
    />
  );
}

export default App;
