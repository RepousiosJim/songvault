use crate::{library::Song, settings::Settings};
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, BufReader, Read},
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    thread,
};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const RESULT_PRINT: &str = "SVJSON %(.{id,title,channel,uploader,duration})j";

#[derive(Deserialize)]
struct RawSong {
    id: String,
    title: String,
    channel: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    filepath: String,
}

#[derive(Deserialize)]
struct RawResult {
    id: String,
    title: String,
    channel: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct SearchResult {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration: u64,
}

pub fn parse_result(line: &str) -> Option<SearchResult> {
    let raw: RawResult = serde_json::from_str(line.strip_prefix("SVJSON ")?).ok()?;
    Some(SearchResult {
        id: raw.id,
        title: raw.title,
        channel: raw.channel.or(raw.uploader).unwrap_or_default(),
        duration: raw.duration.unwrap_or(0.0).round() as u64,
    })
}

/// Reads YouTube's own results page rather than `ytsearch:`, so ranking and loose matching match
/// the site; `ytsearch:` returns nothing for misspellings such as "krycak 200".
pub fn search(query: &str, count: u32) -> Result<Vec<SearchResult>, String> {
    let output = hidden("yt-dlp")
        .args(search_args(query, count))
        .output()
        .map_err(|e| format!("could not start yt-dlp: {e}"))?;
    let results: Vec<_> = String::from_utf8_lossy(&output.stdout).lines().filter_map(parse_result).collect();
    if results.is_empty() && !output.status.success() {
        return Err(last_error(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(results)
}

pub fn search_args(query: &str, count: u32) -> Vec<String> {
    let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    vec![
        "--flat-playlist".into(),
        "--playlist-end".into(),
        count.to_string(),
        "--print".into(),
        RESULT_PRINT.into(),
        format!("https://www.youtube.com/results?search_query={encoded}"),
    ]
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PlaylistInfo {
    pub title: String,
    pub entries: Vec<SearchResult>,
}

pub fn playlist_info(url: &str) -> Result<PlaylistInfo, String> {
    let output = hidden("yt-dlp")
        .args(playlist_args(url))
        .output()
        .map_err(|e| format!("could not start yt-dlp: {e}"))?;
    let info = parse_playlist(&String::from_utf8_lossy(&output.stdout));
    if info.entries.is_empty() {
        return Err(last_error(&String::from_utf8_lossy(&output.stderr)));
    }
    Ok(info)
}

pub fn playlist_args(url: &str) -> Vec<String> {
    ["--flat-playlist", "--print", "SVPL %(playlist_title)s", "--print", RESULT_PRINT, url].map(String::from).into()
}

/// yt-dlp prints the `SVPL` title line before every entry; the first one is enough.
pub fn parse_playlist(stdout: &str) -> PlaylistInfo {
    let title = stdout.lines().find_map(|l| l.trim().strip_prefix("SVPL ")).filter(|t| *t != "NA");
    PlaylistInfo {
        title: title.unwrap_or("Playlist").to_string(),
        entries: stdout.lines().filter_map(|l| parse_result(l.trim())).collect(),
    }
}

/// YouTube only offers separate video and audio streams, so previews are audio-only.
pub fn stream_url(id: &str) -> Result<String, String> {
    let output = hidden("yt-dlp")
        .args(["-f", "ba[ext=m4a]/ba", "-g"])
        .arg(format!("https://www.youtube.com/watch?v={id}"))
        .output()
        .map_err(|e| format!("could not start yt-dlp: {e}"))?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|l| l.starts_with("https://"))
        .map(str::to_string)
        .ok_or_else(|| last_error(&String::from_utf8_lossy(&output.stderr)))
}

/// Stream count and expected total bytes, from the `SVFMT <format_id> <filesize>` line.
pub fn parse_formats(line: &str) -> Option<(u32, Option<u64>)> {
    let mut parts = line.strip_prefix("SVFMT ")?.split_whitespace();
    let streams = parts.next()?.matches('+').count() as u32 + 1;
    Some((streams, parts.next().and_then(|t| t.parse().ok())))
}

/// Downloaded and total bytes of the current stream, from `SVPROG <downloaded> <total> <estimate>`.
pub fn parse_progress(line: &str) -> Option<(u64, Option<u64>)> {
    let mut parts = line.strip_prefix("SVPROG ")?.split_whitespace();
    let downloaded = parts.next()?.parse().ok()?;
    let total = parts.take(2).find_map(|t| t.parse().ok());
    Some((downloaded, total))
}

/// yt-dlp reports each stream (video, then audio) from 0 to 100%; this folds them into one bar.
pub struct Progress {
    streams: u32,
    expected: Option<u64>,
    finished: u64,
    index: u32,
    bytes: u64,
    total: Option<u64>,
    percent: f64,
}

impl Progress {
    pub fn new() -> Self {
        Progress { streams: 1, expected: None, finished: 0, index: 0, bytes: 0, total: None, percent: 0.0 }
    }

    pub fn set_formats(&mut self, streams: u32, expected: Option<u64>) {
        self.streams = streams;
        self.expected = expected;
    }

    pub fn update(&mut self, bytes: u64, total: Option<u64>) -> f32 {
        if bytes < self.bytes {
            self.finished += self.total.unwrap_or(self.bytes);
            self.index += 1;
        }
        self.bytes = bytes;
        self.total = total;
        let fraction = match (self.expected, total) {
            (Some(expected), _) => (self.finished + bytes) as f64 / expected as f64,
            (None, Some(total)) => (self.index as f64 + bytes as f64 / total as f64) / self.streams as f64,
            (None, None) => self.index as f64 / self.streams as f64,
        };
        self.percent = self.percent.max((fraction * 100.0).clamp(0.0, 100.0));
        self.percent as f32
    }
}

pub fn parse_song(line: &str, added_at: u64) -> Option<Song> {
    let raw: RawSong = serde_json::from_str(line.strip_prefix("SVJSON ")?).ok()?;
    let file = Path::new(&raw.filepath).file_name()?.to_string_lossy().into_owned();
    Some(Song {
        id: raw.id,
        title: raw.title,
        channel: raw.channel.or(raw.uploader).unwrap_or_default(),
        artist: None,
        duration: raw.duration.unwrap_or(0.0).round() as u64,
        file,
        thumbnail: raw.thumbnail.unwrap_or_default(),
        added_at,
        gain: None,
        plays: 0,
        last_played: None,
    })
}

/// yt-dlp prefixes fatal messages with "ERROR:"; warnings (e.g. missing JS runtime) are noise.
pub fn last_error(stderr: &str) -> String {
    let lines = || stderr.lines().map(str::trim).filter(|l| !l.is_empty());
    let line = lines()
        .rev()
        .find(|l| l.starts_with("ERROR:"))
        .or_else(|| lines().rev().find(|l| !l.starts_with("WARNING:")))
        .unwrap_or("yt-dlp failed");
    line.trim_start_matches("ERROR:").trim().to_string()
}

pub fn hidden(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub fn version() -> Result<String, String> {
    let output = hidden("yt-dlp").arg("--version").output().map_err(|e| format!("could not start yt-dlp: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Updaters print progress with carriage returns; the last real line is the verdict.
pub fn last_line(output: &str) -> String {
    output
        .split(['\r', '\n'])
        .map(str::trim)
        .filter(|l| l.chars().any(char::is_alphanumeric))
        .last()
        .unwrap_or("")
        .to_string()
}

/// Runs yt-dlp's self-updater on the app's copy; its last line is the verdict.
pub fn update() -> Result<(String, String), String> {
    let output = hidden("yt-dlp").arg("-U").output().map_err(|e| format!("could not start yt-dlp: {e}"))?;
    Ok((version()?, last_line(&String::from_utf8_lossy(&output.stdout))))
}

pub fn download_args(settings: &Settings, url: &str) -> Vec<String> {
    let mut args: Vec<String> = if settings.audio_only {
        ["-f", "ba[ext=m4a]/ba", "-x", "--audio-format", "m4a"].map(String::from).into()
    } else {
        let mut video = vec!["-t".to_string(), "mp4".to_string()];
        if let Some(h) = settings.quality.max_height() {
            video.push("-f".into());
            video.push(format!("bv*[height<={h}]+ba/b[height<={h}]/b"));
        }
        video
    };
    args.extend(
        [
            "--no-playlist",
            "--newline",
            "--progress",
            "--progress-template",
            "download:SVPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
            "-P",
        ]
        .map(String::from),
    );
    args.push(settings.library_dir.to_string_lossy().into_owned());
    args.extend(
        [
            "-o",
            "%(artist,uploader)s - %(title)s [%(id)s].%(ext)s",
            "--embed-metadata",
            "--embed-thumbnail",
            "--convert-thumbnails",
            "jpg",
            "--print",
            "before_dl:SVFMT %(format_id)s %(filesize,filesize_approx)s",
            "--print",
            "after_move:SVJSON %(.{id,title,channel,uploader,duration,thumbnail,filepath})j",
        ]
        .map(String::from),
    );
    if settings.cut_non_music {
        args.extend(["--sponsorblock-remove", "music_offtopic"].map(String::from));
    }
    args.push(url.to_string());
    args
}

/// Runs yt-dlp, calling `on_progress` per percent update. Returns the downloaded song, or the
/// full stderr on failure.
pub fn run(
    settings: &Settings,
    url: &str,
    added_at: u64,
    mut on_progress: impl FnMut(f32),
) -> Result<Song, String> {
    let mut child = hidden("yt-dlp")
        .args(download_args(settings, url))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start yt-dlp: {e}"))?;

    let mut stderr = child.stderr.take().unwrap();
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });

    let mut song = None;
    let mut progress = Progress::new();
    for line in BufReader::new(child.stdout.take().unwrap()).split(b'\n').map_while(Result::ok) {
        let line = String::from_utf8_lossy(&line);
        let line = line.trim();
        if let Some((streams, expected)) = parse_formats(line) {
            progress.set_formats(streams, expected);
        } else if let Some((bytes, total)) = parse_progress(line) {
            on_progress(progress.update(bytes, total));
        } else if let Some(parsed) = parse_song(line, added_at) {
            song = Some(parsed);
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let stderr = stderr_reader.join().unwrap_or_default();
    match song {
        Some(song) if status.success() => Ok(song),
        _ => Err(stderr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Quality;

    const GREEK: &str = r#"SVJSON {"id": "abc123DEF45", "title": "\u039a\u03b1\u03bb\u03b7\u03bc\u03ad\u03c1\u03b1 \u03ba\u03cc\u03c3\u03bc\u03b5", "channel": null, "uploader": "\u0391\u03b8\u03ae\u03bd\u03b1", "duration": 212.4, "thumbnail": "https://i.ytimg.com/vi/abc123DEF45/hqdefault.jpg", "filepath": "E:\\Music\\songvault\\abc123DEF45.mp4"}"#;

    fn settings(quality: Quality, audio_only: bool) -> Settings {
        Settings { library_dir: r"D:\lib".into(), quality, audio_only, ..Settings::default() }
    }

    fn tail(quality: Quality, audio_only: bool) -> Vec<String> {
        let args = download_args(&settings(quality, audio_only), "URL");
        let p = args.iter().position(|a| a == "--no-playlist").unwrap();
        assert_eq!(args[p..p + 7], ["--no-playlist", "--newline", "--progress", "--progress-template", "download:SVPROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s", "-P", r"D:\lib"]);
        assert!(args.contains(&"before_dl:SVFMT %(format_id)s %(filesize,filesize_approx)s".to_string()));
        assert_eq!(args.last().unwrap(), "URL");
        args[..p].to_vec()
    }

    #[test]
    fn best_video_is_the_plain_mp4_preset() {
        assert_eq!(tail(Quality::Best, false), ["-t", "mp4"]);
    }

    #[test]
    fn capped_video_restricts_height() {
        assert_eq!(
            tail(Quality::P720, false),
            ["-t", "mp4", "-f", "bv*[height<=720]+ba/b[height<=720]/b"]
        );
        assert_eq!(tail(Quality::P1080, false)[3], "bv*[height<=1080]+ba/b[height<=1080]/b");
        assert_eq!(tail(Quality::P480, false)[3], "bv*[height<=480]+ba/b[height<=480]/b");
    }

    #[test]
    fn audio_only_ignores_quality() {
        let expected = ["-f", "ba[ext=m4a]/ba", "-x", "--audio-format", "m4a"];
        assert_eq!(tail(Quality::Best, true), expected);
        assert_eq!(tail(Quality::P480, true), expected);
    }

    #[test]
    fn files_are_named_and_tagged() {
        let args = download_args(&settings(Quality::Best, false), "URL");
        let o = args.iter().position(|a| a == "-o").unwrap();
        assert_eq!(args[o + 1], "%(artist,uploader)s - %(title)s [%(id)s].%(ext)s");
        assert_eq!(args[o + 2..o + 6], ["--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"]);
    }

    #[test]
    fn non_music_parts_are_cut_only_when_enabled() {
        let mut s = settings(Quality::Best, false);
        let args = download_args(&s, "URL");
        let p = args.iter().position(|a| a == "--sponsorblock-remove").unwrap();
        assert_eq!(args[p + 1], "music_offtopic");
        s.cut_non_music = false;
        assert!(!download_args(&s, "URL").contains(&"--sponsorblock-remove".to_string()));
    }

    #[test]
    fn search_uses_count_and_encodes_query() {
        let args = search_args("krycak 200", 50);
        assert_eq!(args[1..3], ["--playlist-end", "50"]);
        assert_eq!(args.last().unwrap(), "https://www.youtube.com/results?search_query=krycak+200");
    }

    #[test]
    fn playlist_title_and_ordered_entries() {
        let out = concat!(
            "SVPL Road trip\n",
            "SVJSON {\"id\": \"aaaaaaaaaaa\", \"title\": \"One\", \"channel\": \"A\", \"uploader\": \"A\", \"duration\": 120}\n",
            "SVPL Road trip\n",
            "SVJSON {\"id\": \"bbbbbbbbbbb\", \"title\": \"Two\", \"channel\": null, \"uploader\": \"B\", \"duration\": null}\r\n",
            "WARNING: noise\n",
        );
        let info = parse_playlist(out);
        assert_eq!(info.title, "Road trip");
        let ids: Vec<_> = info.entries.iter().map(|e| (e.id.as_str(), e.channel.as_str(), e.duration)).collect();
        assert_eq!(ids, [("aaaaaaaaaaa", "A", 120), ("bbbbbbbbbbb", "B", 0)]);
        assert_eq!(parse_playlist("SVPL NA\n").title, "Playlist");
        assert_eq!(playlist_args("U").last().unwrap(), "U");
    }

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress("SVPROG 1024 4096 NA"), Some((1024, Some(4096))));
        assert_eq!(parse_progress("SVPROG 1024 NA 5000"), Some((1024, Some(5000))));
        assert_eq!(parse_progress("SVPROG 1024 NA NA"), Some((1024, None)));
        assert_eq!(parse_progress("[download] Destination: x.mp4"), None);
        assert_eq!(parse_formats("SVFMT 137+140 5000"), Some((2, Some(5000))));
        assert_eq!(parse_formats("SVFMT 18 NA"), Some((1, None)));
    }

    fn run_streams(p: &mut Progress, streams: &[(u64, &[u64])]) -> Vec<f32> {
        let mut out = vec![];
        for &(total, steps) in streams {
            for &b in steps {
                out.push(p.update(b, Some(total)));
            }
        }
        out
    }

    #[test]
    fn single_stream_is_plain_percent() {
        let mut p = Progress::new();
        p.set_formats(1, Some(1000));
        assert_eq!(run_streams(&mut p, &[(1000, &[0, 500, 1000])]), [0.0, 50.0, 100.0]);
    }

    #[test]
    fn two_streams_weigh_by_bytes() {
        let mut p = Progress::new();
        p.set_formats(2, Some(1000));
        let got = run_streams(&mut p, &[(800, &[0, 400, 800]), (200, &[0, 100, 200])]);
        assert_eq!(got, [0.0, 40.0, 80.0, 80.0, 90.0, 100.0]);
    }

    #[test]
    fn unknown_total_weighs_streams_equally() {
        let mut p = Progress::new();
        p.set_formats(2, None);
        let got = run_streams(&mut p, &[(800, &[0, 400, 800]), (200, &[0, 100, 200])]);
        assert_eq!(got, [0.0, 25.0, 50.0, 50.0, 75.0, 100.0]);
    }

    #[test]
    fn progress_never_goes_backwards() {
        let mut p = Progress::new();
        p.set_formats(2, Some(1000));
        assert_eq!(p.update(600, Some(600)), 60.0);
        assert_eq!(p.update(0, Some(400)), 60.0);
        assert_eq!(p.update(400, Some(400)), 100.0);
        assert_eq!(p.update(400, Some(400)), 100.0);
    }

    #[test]
    fn greek_title_and_uploader_fallback() {
        let song = parse_song(GREEK, 7).unwrap();
        assert_eq!(song.id, "abc123DEF45");
        assert_eq!(song.title, "Καλημέρα κόσμε");
        assert_eq!(song.channel, "Αθήνα");
        assert_eq!(song.duration, 212);
        assert_eq!(song.file, "abc123DEF45.mp4");
        assert_eq!(song.added_at, 7);
    }

    #[test]
    fn real_line() {
        let line = r#"SVJSON {"id": "jNQXAC9IVRw", "title": "Me at the zoo", "channel": "jawed", "uploader": "jawed", "duration": 19, "thumbnail": "https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg?sqp=-oaymwEmCOADEOgC8quKqQMa8AEB-AG-AoAC8AGKAgwIABABGFUgWShlMA8=&rs=AOn4CLA9eLBatYv9WbkD4BbZ2Im-biSPTw", "filepath": "C:\\tmp\\smoke\\jNQXAC9IVRw.mp4"}"#;
        let song = parse_song(line, 0).unwrap();
        assert_eq!((song.title.as_str(), song.channel.as_str(), song.duration), ("Me at the zoo", "jawed", 19));
        assert_eq!(song.file, "jNQXAC9IVRw.mp4");
    }

    #[test]
    fn non_song_lines() {
        assert!(parse_song("SVJSON not json", 0).is_none());
        assert!(parse_song("something else", 0).is_none());
    }

    #[test]
    fn search_lines() {
        let line = r#"SVJSON {"id": "rFZHOHl-L8A", "title": "lofi hip hop radio 📚 beats", "channel": null, "uploader": "Lofi Girl", "duration": null}"#;
        assert_eq!(
            parse_result(line),
            Some(SearchResult {
                id: "rFZHOHl-L8A".into(),
                title: "lofi hip hop radio 📚 beats".into(),
                channel: "Lofi Girl".into(),
                duration: 0,
            })
        );
        assert_eq!(parse_result("WARNING: something"), None);
    }

    #[test]
    fn winget_last_line() {
        let out = "   - \r   \\ \r  ██████  1.2 MB / 3.4 MB\r\nSuccessfully installed\r\n";
        assert_eq!(last_line(out), "Successfully installed");
        assert_eq!(last_line("No available upgrade found.\n  \r"), "No available upgrade found.");
        assert_eq!(last_line(""), "");
    }

    #[test]
    fn error_line_skips_warnings() {
        let stderr = "WARNING: no js runtime\nERROR: [youtube] xyz: Video unavailable\nWARNING: trailing\n";
        assert_eq!(last_error(stderr), "[youtube] xyz: Video unavailable");
        assert_eq!(last_error(""), "yt-dlp failed");
    }
}
