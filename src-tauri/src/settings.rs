use serde::{Deserialize, Serialize};
use std::{fs, io, path::{Path, PathBuf}};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
pub enum Quality {
    #[default]
    #[serde(rename = "best")]
    Best,
    #[serde(rename = "1080")]
    P1080,
    #[serde(rename = "720")]
    P720,
    #[serde(rename = "480")]
    P480,
}

impl Quality {
    pub fn max_height(self) -> Option<u32> {
        match self {
            Quality::Best => None,
            Quality::P1080 => Some(1080),
            Quality::P720 => Some(720),
            Quality::P480 => Some(480),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub library_dir: PathBuf,
    pub quality: Quality,
    pub audio_only: bool,
    pub search_count: u32,
    pub cut_non_music: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            library_dir: PathBuf::new(),
            quality: Quality::Best,
            audio_only: false,
            search_count: 20,
            cut_non_music: true,
        }
    }
}

impl Settings {
    pub fn load(path: &Path, default_library: PathBuf) -> io::Result<Self> {
        let mut settings: Self = match fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => Self::default(),
            Err(e) => return Err(e),
        };
        if settings.library_dir.as_os_str().is_empty() {
            settings.library_dir = default_library;
        }
        Ok(settings)
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_vec_pretty(self)?)
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    #[test]
    fn missing_file_is_defaults() {
        let dir = tempdir("settings-missing");
        let settings = Settings::load(&dir.join("settings.json"), PathBuf::from(r"C:\Music\songvault")).unwrap();
        assert_eq!(settings.library_dir, PathBuf::from(r"C:\Music\songvault"));
        assert_eq!((settings.quality, settings.audio_only, settings.search_count), (Quality::Best, false, 20));
    }

    #[test]
    fn partial_file_fills_defaults() {
        let settings: Settings = serde_json::from_str(r#"{"quality":"720","audioOnly":true}"#).unwrap();
        assert_eq!(settings.quality, Quality::P720);
        assert!(settings.audio_only);
        assert_eq!(settings.search_count, 20);
        assert!(settings.cut_non_music);
    }

    #[test]
    fn round_trip_camel_case() {
        let dir = tempdir("settings-roundtrip");
        let path = dir.join("nested").join("settings.json");
        let settings = Settings { library_dir: PathBuf::from(r"D:\songs"), quality: Quality::P480, search_count: 50, ..Settings::default() };
        settings.save(&path).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"libraryDir\"") && text.contains("\"480\"") && text.contains("\"searchCount\""));
        assert_eq!(Settings::load(&path, PathBuf::from("unused")).unwrap(), settings);
    }

    pub fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("songvault-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
