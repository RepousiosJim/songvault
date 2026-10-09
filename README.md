# songvault

A Windows desktop app that downloads songs from YouTube with [yt-dlp](https://github.com/yt-dlp/yt-dlp) and keeps them in a local library with playlists.

| Search | Settings |
| --- | --- |
| ![Search](docs/search.png) | ![Settings](docs/settings.png) |

## Features

- Paste a YouTube link to download it as MP4, or as M4A audio only.
- Search YouTube from the same field, with as-you-type suggestions, and preview a result before downloading.
- Pick a playlist for each song once it finishes downloading.
- Playlists can be reordered by drag and drop.
- Built-in player with shuffle, repeat, volume and an up-next queue.
- Settings: library folder (move existing songs or not), quality cap, audio only, number of search results.
- Update yt-dlp from Settings. Failed downloads keep the full yt-dlp log.

## Requirements

Windows 10 or 11. On first launch songvault downloads [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ffmpeg](https://github.com/yt-dlp/FFmpeg-Builds) and [Deno](https://deno.com) (about 150 MB in total) into `%LOCALAPPDATA%\com.gemelon.songvault\bin`. Nothing else needs installing.

## Install

Download `songvault_<version>_x64-setup.exe` from [Releases](https://github.com/RepousiosJim/songvault/releases) and run it. It installs per user and needs no admin rights. The installer is unsigned, so SmartScreen may warn on first run.

Songs are stored in `Music\songvault` by default. Change the folder in Settings.

## Build from source

Needs [Rust](https://rustup.rs), Node.js 20+ and pnpm.

```powershell
pnpm install
pnpm tauri dev      # run in development
pnpm tauri build    # installer in src-tauri/target/release/bundle/nsis
cd src-tauri; cargo test
```

## Disclaimer

Download only content you have the right to download. Respect YouTube's Terms of Service and the copyright of the creators. songvault is not affiliated with YouTube or Google.

## License

[MIT](LICENSE)
