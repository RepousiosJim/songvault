import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconDownload } from "@tabler/icons-react";

const TOOLS = [
  { name: "yt-dlp", size: "17 MB" },
  { name: "ffmpeg", size: "89 MB" },
];

export function Setup({ onReady }: { onReady: () => void }) {
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setError("");
    const unlisten = listen<{ name: string; percent: number }>("tools-progress", ({ payload }) =>
      setProgress((p) => ({ ...p, [payload.name]: payload.percent })),
    );
    invoke("install_tools").then(onReady, (e) => setError(String(e)));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [attempt]);

  return (
    <div className="setup">
      <IconDownload size={32} />
      <h1>Setting up songvault</h1>
      <p className="setup-sub">One-time download of the tools songvault uses.</p>
      <ul className="setup-tools">
        {TOOLS.map((t) => (
          <li key={t.name}>
            <span className="setup-name">{t.name}</span>
            <progress max={100} value={progress[t.name] ?? 0} />
            <span className="setup-size">{progress[t.name] ? `${Math.floor(progress[t.name])}%` : t.size}</span>
          </li>
        ))}
      </ul>
      {error && (
        <div className="setup-error">
          <span>{error}</span>
          <button onClick={() => setAttempt((a) => a + 1)}>Retry</button>
        </div>
      )}
    </div>
  );
}
