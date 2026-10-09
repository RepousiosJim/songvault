mod library;
mod loudness;
mod settings;
mod suggest;
mod tools;
mod ytdlp;

use library::{Library, Playlist, Song};
use settings::{Quality, Settings};
use serde::Serialize;
use serde_json::json;
use std::{
    fs,
    path::PathBuf,
    sync::Mutex,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

/// Lock `library` before `settings` when holding both.
struct AppState {
    config_path: PathBuf,
    bin: PathBuf,
    settings: Mutex<Settings>,
    library: Mutex<Library>,
}

impl AppState {
    fn dir(&self) -> PathBuf {
        self.settings.lock().unwrap().library_dir.clone()
    }
}

#[derive(Serialize)]
struct LibraryView {
    dir: String,
    #[serde(flatten)]
    library: Library,
}

fn save(state: &AppState, library: &Library) -> Result<(), String> {
    library.save(&state.dir()).map_err(|e| e.to_string())
}

fn view(state: &AppState) -> LibraryView {
    let library = state.library.lock().unwrap();
    LibraryView {
        dir: state.dir().to_string_lossy().into_owned(),
        library: Library {
            songs: library.songs.clone(),
            playlists: library.playlists.clone(),
        },
    }
}

#[tauri::command]
fn get_library(state: State<AppState>) -> LibraryView {
    view(&state)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(
    state: State<AppState>,
    quality: Quality,
    audio_only: bool,
    search_count: u32,
    cut_non_music: bool,
    even_volume: bool,
) -> Result<(), String> {
    let mut settings = state.settings.lock().unwrap();
    settings.quality = quality;
    settings.audio_only = audio_only;
    settings.search_count = search_count;
    settings.cut_non_music = cut_non_music;
    settings.even_volume = even_volume;
    settings.save(&state.config_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn change_library_dir(app: AppHandle, path: String, move_songs: bool) -> Result<LibraryView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let to = PathBuf::from(path);
        {
            let mut library = state.library.lock().unwrap();
            if move_songs {
                library::move_to(&state.dir(), &to, &library)?;
            } else {
                *library = library::open_at(&to)?;
            }
            let mut settings = state.settings.lock().unwrap();
            settings.library_dir = to.clone();
            settings.save(&state.config_path).map_err(|e| e.to_string())?;
        }
        app.asset_protocol_scope().allow_directory(&to, true).map_err(|e| e.to_string())?;
        Ok(view(&state))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn download(app: AppHandle, job_id: String, url: String) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let added_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
        let settings = state.settings.lock().unwrap().clone();
        let result = ytdlp::run(&settings, &url, added_at, |percent| {
            let _ = app.emit("download-progress", json!({ "jobId": job_id, "percent": percent }));
        })
        .and_then(|mut song| {
            song.gain = loudness::measure(&state.dir().join(&song.file)).ok();
            upsert(&state, song)
        });
        let _ = match result {
            Ok(song) => app.emit("download-done", json!({ "jobId": job_id, "song": song })),
            Err(log) => app.emit(
                "download-error",
                json!({ "jobId": job_id, "message": ytdlp::last_error(&log), "log": log }),
            ),
        };
    });
}

/// Measures every song that has no gain yet, one at a time, and tells the frontend as each lands.
fn measure_missing_gains(app: AppHandle) {
    thread::spawn(move || {
        let state = app.state::<AppState>();
        let todo: Vec<(String, String)> = {
            let library = state.library.lock().unwrap();
            library.songs.iter().filter(|s| s.gain.is_none()).map(|s| (s.id.clone(), s.file.clone())).collect()
        };
        for (id, file) in todo {
            let Ok(gain) = loudness::measure(&state.dir().join(file)) else { continue };
            let mut library = state.library.lock().unwrap();
            if let Some(song) = library.songs.iter_mut().find(|s| s.id == id) {
                song.gain = Some(gain);
                let _ = save(&state, &library);
                let _ = app.emit("gain-measured", json!({ "id": id, "gain": gain }));
            }
        }
    });
}

fn upsert(state: &AppState, song: Song) -> Result<Song, String> {
    let mut library = state.library.lock().unwrap();
    match library.songs.iter_mut().find(|s| s.id == song.id) {
        Some(existing) => *existing = song.clone(),
        None => library.songs.push(song.clone()),
    }
    save(state, &library)?;
    Ok(song)
}

#[tauri::command]
fn delete_song(state: State<AppState>, id: String) -> Result<(), String> {
    let mut library = state.library.lock().unwrap();
    if let Some(song) = library.songs.iter().find(|s| s.id == id) {
        match fs::remove_file(state.dir().join(&song.file)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
            _ => {}
        }
    }
    library.songs.retain(|s| s.id != id);
    for playlist in &mut library.playlists {
        playlist.song_ids.retain(|s| *s != id);
    }
    save(&state, &library)
}

#[tauri::command]
fn edit_song(state: State<AppState>, id: String, title: String, artist: String) -> Result<(), String> {
    let mut library = state.library.lock().unwrap();
    if let Some(song) = library.songs.iter_mut().find(|s| s.id == id) {
        song.title = title;
        song.artist = Some(artist).filter(|a| !a.is_empty());
    }
    save(&state, &library)
}

#[tauri::command]
fn reveal_song(state: State<AppState>, id: String) -> Result<(), String> {
    let library = state.library.lock().unwrap();
    let song = library.songs.iter().find(|s| s.id == id).ok_or("song not found")?;
    ytdlp::hidden("explorer.exe")
        .arg("/select,")
        .arg(state.dir().join(&song.file))
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_youtube(id: String) -> Result<(), String> {
    ytdlp::hidden("explorer.exe")
        .arg(format!("https://www.youtube.com/watch?v={id}"))
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn tools_ready(state: State<AppState>) -> bool {
    tools::ready(&state.bin)
}

#[tauri::command]
async fn install_tools(app: AppHandle) -> Result<(), String> {
    let bin = app.state::<AppState>().bin.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        tools::install(&bin, |name, percent| {
            let _ = app.emit("tools-progress", json!({ "name": name, "percent": percent }));
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    measure_missing_gains(handle);
    Ok(())
}

#[tauri::command]
async fn ytdlp_version() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(ytdlp::version).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<ytdlp::SearchResult>, String> {
    let count = state.settings.lock().unwrap().search_count;
    tauri::async_runtime::spawn_blocking(move || ytdlp::search(&query, count)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn suggest(query: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || suggest::suggest(&query)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn stream_url(id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ytdlp::stream_url(&id)).await.map_err(|e| e.to_string())?
}

/// Updates yt-dlp if the last automatic update is over a week old. Returns the new version.
#[tauri::command]
async fn auto_update_ytdlp(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
        if !state.settings.lock().unwrap().ytdlp_update_due(now) {
            return Ok(None);
        }
        let (version, _) = ytdlp::update()?;
        let mut settings = state.settings.lock().unwrap();
        settings.ytdlp_checked_at = now;
        settings.save(&state.config_path).map_err(|e| e.to_string())?;
        Ok(Some(version))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct UpdateResult {
    version: String,
    output: String,
}

#[tauri::command]
async fn update_ytdlp() -> Result<UpdateResult, String> {
    let (version, output) = tauri::async_runtime::spawn_blocking(ytdlp::update).await.map_err(|e| e.to_string())??;
    Ok(UpdateResult { version, output })
}

#[tauri::command]
fn save_playlists(state: State<AppState>, playlists: Vec<Playlist>) -> Result<(), String> {
    let mut library = state.library.lock().unwrap();
    library.playlists = playlists;
    save(&state, &library)
}

#[tauri::command]
fn export_m3u(state: State<AppState>, playlist_id: String, path: String) -> Result<(), String> {
    let library = state.library.lock().unwrap();
    let playlist = library.playlists.iter().find(|p| p.id == playlist_id).ok_or("playlist not found")?;
    fs::write(path, library.m3u(playlist, &state.dir())).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("settings.json");
            let bin = app.path().app_local_data_dir()?.join("bin");
            tools::use_bin(&bin);
            let settings = Settings::load(&config_path, app.path().audio_dir()?.join("songvault"))?;
            fs::create_dir_all(&settings.library_dir)?;
            let library = Library::load(&settings.library_dir)?;
            app.asset_protocol_scope().allow_directory(&settings.library_dir, true)?;
            let ready = tools::ready(&bin);
            app.manage(AppState { config_path, bin, settings: Mutex::new(settings), library: Mutex::new(library) });
            if ready {
                measure_missing_gains(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            get_settings,
            save_settings,
            change_library_dir,
            download,
            delete_song,
            edit_song,
            reveal_song,
            open_youtube,
            save_playlists,
            export_m3u,
            tools_ready,
            install_tools,
            ytdlp_version,
            update_ytdlp,
            auto_update_ytdlp,
            search,
            suggest,
            stream_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
