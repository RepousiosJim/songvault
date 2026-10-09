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
  IconSearch,
  IconSettings,
  IconTrash,
  IconVolume,
  IconX,
} from "@tabler/icons-react";
import type { Job, LibraryView, Playlist, Preview, Quality, SearchResult, Settings, Song } from "./types";
import { formatDuration, Player, type Track } from "./Player";
import "./App.css";

const LIBRARY = "library";
const SEARCH = "search";
const SETTINGS = "settings";

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const thumbnailUrl = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const isLink = (text: string) => /^https?:\/\/|youtu\.?be/i.test(text);

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
  const [creating, setCreating] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Song[]>([]);
  const [ytdlp, setYtdlp] = useState("");
  const [updating, setUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState("");
  const [field, setField] = useState("");
  const [searchedFor, setSearchedFor] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
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
    invoke<string>("ytdlp_version").then(setYtdlp, (e) => setYtdlp(String(e)));
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
      .sort((a, b) => b.addedAt - a.addedAt)
      .filter((s) => !q || s.title.toLowerCase().includes(q) || s.channel.toLowerCase().includes(q));
  }, [songs, playlist, filter]);

  const queueIndex = queue.findIndex((s) => s.id === playingId);
  const playing = queue[queueIndex];
  const activeJobs = jobs.filter((j) => !j.error);
  const failedJobs = jobs.filter((j) => j.error);

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
    if ("playlistId" in target) return addToPlaylist(target.playlistId, song.id);
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

  function addToPlaylist(playlistId: string, songId: string) {
    setMenuFor(null);
    savePlaylists(
      playlists.map((p) =>
        p.id === playlistId && !p.songIds.includes(songId) ? { ...p, songIds: [...p.songIds, songId] } : p,
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

  async function deleteSong(song: Song) {
    if (!window.confirm(`Delete "${song.title}" from disk?`)) return;
    await invoke("delete_song", { id: song.id });
    setSongs((ss) => ss.filter((s) => s.id !== song.id));
    setPlaylists((ps) => ps.map((p) => ({ ...p, songIds: p.songIds.filter((id) => id !== song.id) })));
    setQueue((q) => q.filter((s) => s.id !== song.id));
    if (playingId === song.id) setPlayingId(null);
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
        poster: thumbnailUrl(preview.id),
        title: preview.title,
        status: preview.error ?? (preview.url ? "Preview" : "Loading preview…"),
      }
    : playing
      ? {
          key: playing.id,
          src: convertFileSrc(`${dir}\\${playing.file}`),
          poster: playing.file.endsWith(".mp4") ? undefined : playing.thumbnail,
          title: playing.title,
          channel: playing.channel,
        }
      : null;
  const previewDownloadable =
    preview && !songs.some((s) => s.id === preview.id) && !activeJobs.some((j) => j.url === watchUrl(preview.id));

  const heading =
    view === SEARCH ? (searchedFor ? `Results for "${searchedFor}"` : "Search") : playlist ? playlist.name : "Library";

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
                    : results.length > 0 && `${results.length} results`
                  : `${visible.length} ${visible.length === 1 ? "song" : "songs"} · ${totalLength(visible)}`}
              </span>
              {view === LIBRARY && (
                <input
                  className="filter"
                  value={filter}
                  placeholder="Filter"
                  onChange={(e) => setFilter(e.target.value)}
                />
              )}
            </div>
            {view === SEARCH && searchError && <div className="error">{searchError}</div>}
            {view === SEARCH && !searchedFor && (
              <button className="search-empty" onClick={() => fieldRef.current?.focus()}>
                <IconSearch size={36} />
                <span>Type a song or artist in the field above</span>
              </button>
            )}
            <ul className="songs">
              {view === SEARCH
                ? results.map((r) => {
                    const inLibrary = songs.some((s) => s.id === r.id);
                    const downloading = activeJobs.some((j) => j.url === watchUrl(r.id));
                    return (
                      <li
                        key={r.id}
                        className={preview?.id === r.id ? "song playing" : "song"}
                        onClick={() => previewResult(r)}
                      >
                        <img src={thumbnailUrl(r.id)} alt="" />
                        <span className="meta">
                          <span className="title">{r.title}</span>
                          <span className="channel">{r.channel}</span>
                        </span>
                        <span className="duration">{r.duration ? formatDuration(r.duration) : ""}</span>
                        <span className="actions always" onClick={(e) => e.stopPropagation()}>
                          {inLibrary ? (
                            <span className="tag">In library</span>
                          ) : downloading ? (
                            <span className="tag">Downloading</span>
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
                      className={song.id === playingId ? "song playing" : "song"}
                      draggable={!!playlist}
                      onDragStart={() => setDragIndex(i)}
                      onDragOver={(e) => dragIndex !== null && e.preventDefault()}
                      onDrop={() => {
                        if (dragIndex !== null && dragIndex !== i) moveSong(dragIndex, i);
                        setDragIndex(null);
                      }}
                      onDragEnd={() => setDragIndex(null)}
                      onClick={() => play(song)}
                    >
                      <img src={song.thumbnail} alt="" />
                      <span className="meta">
                        <span className="title">{song.title}</span>
                        <span className="channel">{song.channel}</span>
                      </span>
                      <span className="duration">
                        {song.id === playingId ? <IconVolume size={16} /> : formatDuration(song.duration)}
                      </span>
                      <span
                        className={menuFor === song.id ? "actions always" : "actions"}
                        onClick={(e) => e.stopPropagation()}
                      >
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
                            <button className="icon" aria-label="Delete" onClick={() => deleteSong(song)}>
                              <IconTrash size={16} />
                            </button>
                            {menuFor === song.id && (
                              <ul className="menu">
                                {playlists.length === 0 && <li className="disabled">No playlists</li>}
                                {playlists.map((p) => (
                                  <li
                                    key={p.id}
                                    className={p.songIds.includes(song.id) ? "disabled" : undefined}
                                    onClick={() => addToPlaylist(p.id, song.id)}
                                  >
                                    {p.name}
                                  </li>
                                ))}
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
        upNext={preview ? [] : queue.slice(queueIndex + 1, queueIndex + 6)}
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
        <div className="prompt-title">{song.title}</div>
        <div className="prompt-channel">{song.channel}</div>
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
