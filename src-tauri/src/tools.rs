use std::{
    env,
    fs::{self, File},
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};

const YTDLP: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
/// The shared build is 90 MB against 200 MB for the static one.
const FFMPEG: &str =
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip";
/// yt-dlp needs a JavaScript runtime to solve YouTube's challenges; Deno is the one it looks for.
const DENO: &str = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn err(e: impl ToString) -> String {
    e.to_string()
}

pub fn ready(bin: &Path) -> bool {
    bin.join("yt-dlp.exe").exists() && bin.join("ffmpeg.exe").exists() && bin.join("deno.exe").exists()
}

/// Puts `bin` first on PATH so every `yt-dlp` call, and yt-dlp's own ffmpeg lookup, use the
/// app's copies.
pub fn use_bin(bin: &Path) {
    let old = env::var_os("PATH").unwrap_or_default();
    let path = env::join_paths(std::iter::once(bin.to_path_buf()).chain(env::split_paths(&old))).unwrap();
    // SAFETY: runs during setup, before any thread reads the environment.
    unsafe { env::set_var("PATH", path) };
}

/// Serialises installs, so a second caller waits and then finds the tools present.
static INSTALLING: Mutex<()> = Mutex::new(());

pub fn install(bin: &Path, mut on_progress: impl FnMut(&str, f32)) -> Result<(), String> {
    let _guard = INSTALLING.lock().unwrap();
    fs::create_dir_all(bin).map_err(err)?;
    let ytdlp = bin.join("yt-dlp.exe");
    if !ytdlp.exists() {
        let part = bin.join("yt-dlp.exe.part");
        fetch(YTDLP, &part, |p| on_progress("yt-dlp", p))?;
        fs::rename(part, ytdlp).map_err(err)?;
    }
    if !bin.join("ffmpeg.exe").exists() {
        let zip = bin.join("ffmpeg.zip");
        fetch(FFMPEG, &zip, |p| on_progress("ffmpeg", p))?;
        let unpacked = bin.join("ffmpeg-unpacked");
        let _ = fs::remove_dir_all(&unpacked);
        fs::create_dir_all(&unpacked).map_err(err)?;
        unzip(&zip, &unpacked)?;
        for top in fs::read_dir(&unpacked).map_err(err)? {
            let top_bin = top.map_err(err)?.path().join("bin");
            for file in fs::read_dir(&top_bin).into_iter().flatten().flatten() {
                fs::rename(file.path(), bin.join(file.file_name())).map_err(err)?;
            }
        }
        fs::remove_dir_all(&unpacked).map_err(err)?;
        fs::remove_file(&zip).map_err(err)?;
    }
    if !bin.join("deno.exe").exists() {
        let zip = bin.join("deno.zip");
        fetch(DENO, &zip, |p| on_progress("deno", p))?;
        unzip(&zip, bin)?;
        fs::remove_file(&zip).map_err(err)?;
    }
    Ok(())
}

fn unzip(zip: &Path, dest: &Path) -> Result<(), String> {
    // Windows' bsdtar reads zip; a Git for Windows tar earlier on PATH would not.
    let tar = PathBuf::from(env::var_os("SystemRoot").unwrap_or("C:\\Windows".into())).join(r"System32\tar.exe");
    let status = Command::new(tar)
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-xf")
        .arg(zip)
        .arg("-C")
        .arg(dest)
        .status()
        .map_err(err)?;
    if !status.success() {
        return Err(format!("could not unpack {}", zip.display()));
    }
    Ok(())
}

fn fetch(url: &str, dest: &Path, mut on_progress: impl FnMut(f32)) -> Result<(), String> {
    let response = ureq::get(url).call().map_err(err)?;
    let total: f32 = response.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0.0);
    let mut reader = response.into_reader();
    let mut file = File::create(dest).map_err(err)?;
    let mut buf = vec![0u8; 256 * 1024];
    let (mut done, mut reported) = (0f32, -1i32);
    loop {
        let n = reader.read(&mut buf).map_err(err)?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(err)?;
        done += n as f32;
        let percent = if total > 0.0 { done / total * 100.0 } else { 0.0 };
        if percent as i32 != reported {
            reported = percent as i32;
            on_progress(percent);
        }
    }
    Ok(())
}
