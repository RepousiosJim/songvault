use crate::ytdlp::hidden;
use std::path::Path;

/// Songs louder than this get turned down to it; quieter ones are left alone, since the
/// element volume cannot go above 1.
const TARGET_LUFS: f64 = -16.0;

/// Integrated loudness from the summary ffmpeg's `ebur128` filter prints on stderr.
pub fn parse_integrated(stderr: &str) -> Option<f64> {
    let summary = stderr.rsplit_once("Integrated loudness:")?.1;
    let value = summary.lines().find_map(|l| l.trim().strip_prefix("I:"))?;
    value.split_whitespace().next()?.parse().ok()
}

pub fn gain_for(lufs: f64) -> f32 {
    10f64.powf((TARGET_LUFS - lufs) / 20.0).min(1.0) as f32
}

pub fn measure(file: &Path) -> Result<f32, String> {
    let output = hidden("ffmpeg")
        .args(["-hide_banner", "-nostats", "-i"])
        .arg(file)
        .args(["-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"])
        .output()
        .map_err(|e| format!("could not start ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_integrated(&stderr).map(gain_for).ok_or_else(|| "no loudness reading".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMMARY: &str = "[Parsed_ebur128_0 @ 000001] Summary:\n\n  Integrated loudness:\n    I:         -23.4 LUFS\n    Threshold: -33.4 LUFS\n\n  Loudness range:\n    LRA:         5.1 LU\n";

    #[test]
    fn reads_integrated_loudness() {
        assert_eq!(parse_integrated(SUMMARY), Some(-23.4));
        assert_eq!(parse_integrated("I: -9.0 LUFS"), None);
        assert_eq!(parse_integrated("Integrated loudness:\n    I:         -inf LUFS\n"), Some(f64::NEG_INFINITY));
    }

    #[test]
    fn only_loud_songs_are_turned_down() {
        assert_eq!(gain_for(-23.0), 1.0);
        assert_eq!(gain_for(-16.0), 1.0);
        assert!((gain_for(-10.0) - 0.501_187).abs() < 1e-5);
        assert_eq!(gain_for(f64::NEG_INFINITY), 1.0);
    }
}
