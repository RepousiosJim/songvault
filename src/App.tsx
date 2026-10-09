import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  IconBrandYoutube,
  IconCircleCheckFilled,
  IconDownload,
  IconMusic,
  IconPencil,
  IconPlaylist,
  IconPlaylistAdd,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconTrash,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import type { Job, LibraryView, Playlist, Preview, Quality, SearchResult, Settings, Song } from "./types";
import { artistOf, cleanTitle } from "./songs";
import { formatDuration, isTyping, Player, type Track } from "./Player";
import { Setup } from "./Setup";
import "./App.css";

const LIBRARY = "library";
const SEARCH = "search";
const SETTINGS = "settings";

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const thumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const artworkUrl = (id: string) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const isLink = (text: string) => /^https?:\/\/|youtu\.?be/i.test(text);
const isSong = (r: SearchResult) => r.duration > 0 && r.duration < 600;

type SortKey = "added" | "title" | "artist" | "length";

const SORTS: Record<SortKey, [label: string, compare: (a: Song, b: Song) => number]> = {
  added: ["Date added", (a, b) => b.addedAt - a.addedAt],
  title: ["Title", (a, b) => cleanTitle(a.title).localeCompare(cleanTitle(b.title))],
  artist: ["Artist", (a, b) => artistOf(a).localeCompare(artistOf(b))],
  length: ["Length", (a, b) => a.duration - b.duration],
};

const BULK = "bulk";

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
  const [songs, setSongs] = useState<Song[]>([]);
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
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("added");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Song[]>([]);
  const [toolsReady, setToolsReady] = useState<boolean | null>(null);
  const [ytdlp, setYtdlp] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState("");
  const [field, setField] = useState("");
  const [searchedFor, setSearchedFor] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [songsOnly, setSongsOnly] = useState(true);
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

  useEffect(() => {
    const q = field.trim();
    suggestFor.current = q;
    if (!q || isLink(q) || q === searchedQuery.current) return setSuggestions([]);
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

  useEffect(() => {
    invoke<boolean>("tools_ready").then(setToolsReady);
    invoke<LibraryView>("get_library").then(applyLibrary);
    invoke<Settings>("get_settings").then(setSettings);

    const unlisten = Promise.all([
      listen<{ jobId: string; percent: number }>("download-progress", ({ payload }) =>
        setJobs((js) => js.map((j) => (j.id === payload.jobId ? { ...j, percent: payload.percent } : j))),
      ),
      listen<{ jobId: string; song: Song }>("download-done", ({ payload }) => {
        setJobs((js) => js.filter((j) => j.id !== payload.jobId));
        setJustAdded((a) => [...a.filter((s) => s.id !== payload.song.id), payload.song]);
        setSongs((ss) =>
          ss.some((s) => s.id === payload.song.id)
            ? ss.map((s) => (s.id === payload.song.id ? payload.song : s))
            : [...ss, payload.song],
        );
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
    setExpanded(false);
    setSelected(new Set());
  }, [view]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isTyping(e.target)) return;
      if (menuFor) setMenuFor(null);
      else setSelected(new Set());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    if (toolsReady) invoke<string>("ytdlp_version").then(setYtdlp, (e) => setYtdlp(String(e)));
  }, [toolsReady]);

  function applyLibrary(lib: LibraryView) {
    setDir(lib.dir);
    setSongs(lib.songs);
    setPlaylists(lib.playlists);
  }

  function updateSettings(patch: Partial<Pick<Settings, "quality" | "audioOnly" | "searchCount">>) {
    if (!settings) return;
    const next = { ...settings, ...patch };
    setSettings(next);
    invoke("save_settings", { quality: next.quality, audioOnly: next.audioOnly, searchCount: next.searchCount });
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

  const playlist = playlists.find((p) => p.id === view);

  const visible = useMemo(() => {
    if (playlist) {
      const byId = new Map(songs.map((s) => [s.id, s]));
      return playlist.songIds.flatMap((id) => byId.get(id) ?? []);
    }
    const q = filter.trim().toLowerCase();
    return [...songs]
      .sort(SORTS[sort][1])
      .filter((s) => !q || cleanTitle(s.title).toLowerCase().includes(q) || artistOf(s).toLowerCase().includes(q));
  }, [songs, playlist, filter, sort]);

  const queueIndex = queue.findIndex((s) => s.id === playingId);
  const playing = queue[queueIndex];
  const activeJobs = jobs.filter((j) => !j.error);
  const failedJobs = jobs.filter((j) => j.error);
  const shownResults = songsOnly ? results.filter(isSong) : results;

  function startDownload(target: string) {
    const id = crypto.randomUUID();
    setJobs((js) => [...js, { id, url: target, percent: 0 }]);
    invoke("download", { jobId: id, url: target });
  }

  function submitField(text = field) {
    const q = text.trim();
    if (!q) return;
    if (isLink(q)) {
      setField("");
      setSuggestions([]);
      startDownload(q);
    } else {
      runSearch(q);
    }
  }

  async function runSearch(q: string) {
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
      setResults(found);
      if (!found.length) setSearchError(`No results for "${q}".`);
    } catch (e) {
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

  async function deleteSongs(targets: Song[]) {
    const what = targets.length === 1 ? `"${cleanTitle(targets[0].title)}"` : `${targets.length} songs`;
    if (!window.confirm(`Delete ${what} from disk?`)) return;
    const ids = targets.map((s) => s.id);
    for (const id of ids) await invoke("delete_song", { id });
    setSongs((ss) => ss.filter((s) => !ids.includes(s.id)));
    setPlaylists((ps) => ps.map((p) => ({ ...p, songIds: p.songIds.filter((id) => !ids.includes(id)) })));
    setQueue((q) => q.filter((s) => !ids.includes(s.id)));
    if (playingId && ids.includes(playingId)) setPlayingId(null);
    setSelected(new Set());
  }

  function editSong(song: Song, edit: { title: string; artist: string } | null) {
    setEditingId(null);
    if (!edit) return;
    const patch = (s: Song) => (s.id === song.id ? { ...s, title: edit.title, artist: edit.artist || undefined } : s);
    setSongs((ss) => ss.map(patch));
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
        }
      : null;
  const previewDownloadable =
    preview && !songs.some((s) => s.id === preview.id) && !activeJobs.some((j) => j.url === watchUrl(preview.id));

  const heading =
    view === SEARCH ? (searchedFor ? `Results for "${searchedFor}"` : "Search") : playlist ? playlist.name : "Library";

  if (toolsReady === false) return <Setup onReady={() => setToolsReady(true)} />;

  return (
    <div className="app" onClick={() => setMenuFor(null)}>
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
                    <span className="job-url">{job.url}</span>
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
                        <progress value={job.percent} max={100} />
                        <span className="job-percent">{Math.round(job.percent)}%</span>
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
            <div key={p.id} className={view === p.id ? "nav playlist active" : "nav playlist"} onClick={() => setView(p.id)}>
              <IconPlaylist size={18} />
              <span className="nav-label">{p.name}</span>
              {view === p.id ? (
                <span className="row-tools">
                  <button className="icon" aria-label="Rename" onClick={() => setRenamingId(p.id)}>
                    <IconPencil size={14} />
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
                    : results.length > 0 &&
                      (shownResults.length < results.length
                        ? `${shownResults.length} songs · ${results.length - shownResults.length} hidden`
                        : `${results.length} results`)
                  : `${visible.length} ${visible.length === 1 ? "song" : "songs"} · ${totalLength(visible)}`}
              </span>
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
                    <PlaylistMenu
                      playlists={playlists}
                      ids={[...selected]}
                      onPick={(playlistId) => addToPlaylist(playlistId, [...selected])}
                    />
                  )}
                </span>
                <button onClick={() => deleteSongs(songs.filter((s) => selected.has(s.id)))}>
                  <IconTrash size={16} /> Delete
                </button>
              </div>
            )}
            {view === SEARCH && results.length > 0 && (
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
            {view === SEARCH && !searchedFor && (
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
                            <span className="tag">{Math.round(active.percent)}%</span>
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
                      draggable={!!playlist && editingId !== song.id}
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => dragIndex !== null && e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== i) moveSong(dragIndex, i);
                        setDragIndex(null);
                      }}
                      onDragEnd={() => setDragIndex(null)}
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
                            <button className="icon" aria-label="Delete" onClick={() => deleteSongs([song])}>
                              <IconTrash size={16} />
                            </button>
                            {menuFor === song.id && (
                              <PlaylistMenu
                                playlists={playlists}
                                ids={[song.id]}
                                onPick={(playlistId) => addToPlaylist(playlistId, [song.id])}
                              />
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

function PlaylistMenu({
  playlists,
  ids,
  onPick,
}: {
  playlists: Playlist[];
  ids: string[];
  onPick: (playlistId: string) => void;
}) {
  return (
    <ul className="menu">
      {playlists.length === 0 && <li className="disabled">No playlists</li>}
      {playlists.map((p) => (
        <li
          key={p.id}
          className={ids.every((id) => p.songIds.includes(id)) ? "disabled" : undefined}
          onClick={() => onPick(p.id)}
        >
          {p.name}
        </li>
      ))}
    </ul>
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
