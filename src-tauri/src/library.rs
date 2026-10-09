use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

const FILE_NAME: &str = "library.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub id: String,
    pub title: String,
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artist: Option<String>,
    pub duration: u64,
    pub file: String,
    pub thumbnail: String,
    pub added_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub song_ids: Vec<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Library {
    pub songs: Vec<Song>,
    pub playlists: Vec<Playlist>,
}

impl Library {
    pub fn load(dir: &Path) -> io::Result<Self> {
        match fs::read_to_string(dir.join(FILE_NAME)) {
            Ok(text) => Ok(serde_json::from_str(&text)?),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e),
        }
    }

    pub fn save(&self, dir: &Path) -> io::Result<()> {
        let tmp = dir.join(format!("{FILE_NAME}.tmp"));
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(tmp, dir.join(FILE_NAME))
    }

    /// An extended M3U listing of the playlist's songs, in order, with absolute paths.
    pub fn m3u(&self, playlist: &Playlist, dir: &Path) -> String {
        let mut out = String::from("#EXTM3U\n");
        for song in playlist.song_ids.iter().filter_map(|id| self.songs.iter().find(|s| s.id == *id)) {
            let artist = song.artist.as_deref().unwrap_or(&song.channel);
            out += &format!("#EXTINF:{},{artist} - {}\n{}\n", song.duration, song.title, dir.join(&song.file).display());
        }
        out
    }
}

fn move_file(from: &Path, to: &Path) -> io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    fs::remove_file(from)
}

/// Moves every song file and the library index into `to`, which must not already hold a library.
pub fn move_to(from: &Path, to: &Path, library: &Library) -> Result<(), String> {
    if to.join(FILE_NAME).exists() {
        return Err("The chosen folder already contains a songvault library.".into());
    }
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for song in &library.songs {
        match move_file(&from.join(&song.file), &to.join(&song.file)) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(format!("{}: {e}", song.file)),
            _ => {}
        }
    }
    library.save(to).map_err(|e| e.to_string())?;
    match fs::remove_file(from.join(FILE_NAME)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Opens the library in `to`, or an empty one if the folder has none yet.
pub fn open_at(to: &Path) -> Result<Library, String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    Library::load(to).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::tests::tempdir;

    fn song(id: &str, file: &str) -> Song {
        Song {
            id: id.into(),
            title: id.into(),
            channel: String::new(),
            artist: None,
            duration: 1,
            file: file.into(),
            thumbnail: String::new(),
            added_at: 0,
        }
    }

    fn library_with_files(dir: &Path) -> Library {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("a.mp4"), b"video").unwrap();
        fs::write(dir.join("b.m4a"), b"audio").unwrap();
        let library = Library {
            songs: vec![song("a", "a.mp4"), song("b", "b.m4a")],
            playlists: vec![Playlist { id: "p".into(), name: "P".into(), song_ids: vec!["a".into()] }],
        };
        library.save(dir).unwrap();
        library
    }

    #[test]
    fn songs_saved_before_artists_existed_still_load() {
        let json = r#"{"songs":[{"id":"a","title":"A","channel":"C","duration":1,"file":"a.mp4","thumbnail":"","addedAt":0}],"playlists":[]}"#;
        let library: Library = serde_json::from_str(json).unwrap();
        assert_eq!(library.songs[0].artist, None);
    }

    #[test]
    fn m3u_follows_playlist_order() {
        let mut a = song("a", "a.mp4");
        a.channel = "Chan".into();
        let mut b = song("b", "b.m4a");
        b.artist = Some("Artist".into());
        b.title = "Bé".into();
        let library = Library { songs: vec![a, b], playlists: vec![] };
        let playlist = Playlist { id: "q".into(), name: "Q".into(), song_ids: vec!["b".into(), "gone".into(), "a".into()] };
        assert_eq!(
            library.m3u(&playlist, Path::new(r"D:\lib")),
            "#EXTM3U\n#EXTINF:1,Artist - Bé\nD:\\lib\\b.m4a\n#EXTINF:1,Chan - a\nD:\\lib\\a.mp4\n"
        );
    }

    #[test]
    fn move_relocates_files_and_index() {
        let root = tempdir("move");
        let (from, to) = (root.join("old"), root.join("new"));
        let library = library_with_files(&from);
        move_to(&from, &to, &library).unwrap();
        assert_eq!(fs::read(to.join("a.mp4")).unwrap(), b"video");
        assert_eq!(fs::read(to.join("b.m4a")).unwrap(), b"audio");
        assert!(!from.join("a.mp4").exists() && !from.join("b.m4a").exists() && !from.join(FILE_NAME).exists());
        let moved = Library::load(&to).unwrap();
        assert_eq!((moved.songs.len(), moved.playlists.len()), (2, 1));
    }

    #[test]
    fn move_refuses_existing_library() {
        let root = tempdir("move-refuse");
        let (from, to) = (root.join("old"), root.join("new"));
        let library = library_with_files(&from);
        Library::default().save(&{ fs::create_dir_all(&to).unwrap(); to.clone() }).unwrap();
        assert!(move_to(&from, &to, &library).is_err());
        assert!(from.join("a.mp4").exists() && from.join(FILE_NAME).exists());
        assert!(!to.join("a.mp4").exists());
    }

    #[test]
    fn switch_loads_target_library_and_leaves_old() {
        let root = tempdir("switch");
        let (old, other) = (root.join("old"), root.join("other"));
        library_with_files(&old);
        library_with_files(&other);
        fs::remove_file(other.join("b.m4a")).unwrap();
        let mut target = Library::load(&other).unwrap();
        target.songs.truncate(1);
        target.save(&other).unwrap();
        let opened = open_at(&other).unwrap();
        assert_eq!(opened.songs, vec![song("a", "a.mp4")]);
        assert!(old.join("a.mp4").exists() && old.join(FILE_NAME).exists());
        assert!(open_at(&root.join("fresh")).unwrap().songs.is_empty());
    }
}
