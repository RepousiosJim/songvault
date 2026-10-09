import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  IconArrowsShuffle,
  IconDownload,
  IconMusic,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconRepeat,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";
import type { Song } from "./types";

export interface Track {
  key: string;
  src?: string;
  poster?: string;
  title: string;
  channel?: string;
  status?: string;
}

export function formatDuration(secs: number) {
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Props {
  track: Track | null;
  upNext: Song[];
  canPrev: boolean;
  canNext: boolean;
  shuffle: boolean;
  repeat: boolean;
  onPrev: () => void;
  onNext: () => void;
  onEnded: () => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onPick: (song: Song) => void;
  onDownload?: () => void;
}

export function Player(props: Props) {
  const { track } = props;
  const video = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    setTime(0);
    setDuration(0);
  }, [track?.key]);

  useEffect(() => {
    if (video.current) video.current.volume = volume;
  }, [volume, track?.key]);

  function toggle() {
    const v = video.current;
    if (!v?.src) return;
    v.paused ? v.play() : v.pause();
  }

  return (
    <section className="player">
      {track ? (
        <video
          key={track.key}
          ref={video}
          className="screen"
          src={track.src}
          poster={track.poster}
          autoPlay
          onClick={toggle}
          onDoubleClick={() => video.current?.requestFullscreen()}
          onPlay={() => setPaused(false)}
          onPause={() => setPaused(true)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          onEnded={props.onEnded}
        />
      ) : (
        <div className="screen empty">
          <IconMusic size={40} />
        </div>
      )}

      <div className="track">
        <div className="track-title">{track?.title ?? "Nothing playing"}</div>
        <div className="track-sub">
          {track?.status ?? track?.channel}
          {props.onDownload && (
            <button className="chip" onClick={props.onDownload}>
              <IconDownload size={14} /> Download
            </button>
          )}
        </div>
      </div>

      <input
        className="seek"
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={time}
        style={{ "--pct": `${duration ? (time / duration) * 100 : 0}%` } as CSSProperties}
        onChange={(e) => {
          if (video.current) video.current.currentTime = Number(e.target.value);
        }}
      />
      <div className="times">
        <span>{formatDuration(time)}</span>
        <span>{formatDuration(duration)}</span>
      </div>

      <div className="transport">
        <button className={props.shuffle ? "icon on" : "icon"} aria-label="Shuffle" onClick={props.onShuffle}>
          <IconArrowsShuffle size={18} />
        </button>
        <button className="icon" aria-label="Previous" disabled={!props.canPrev} onClick={props.onPrev}>
          <IconPlayerSkipBackFilled size={20} />
        </button>
        <button className="play" aria-label={paused ? "Play" : "Pause"} disabled={!track?.src} onClick={toggle}>
          {paused ? <IconPlayerPlayFilled size={20} /> : <IconPlayerPauseFilled size={20} />}
        </button>
        <button className="icon" aria-label="Next" disabled={!props.canNext} onClick={props.onNext}>
          <IconPlayerSkipForwardFilled size={20} />
        </button>
        <button className={props.repeat ? "icon on" : "icon"} aria-label="Repeat" onClick={props.onRepeat}>
          <IconRepeat size={18} />
        </button>
      </div>

      <div className="volume">
        <button className="icon" aria-label="Mute" onClick={() => setVolume((v) => (v ? 0 : 1))}>
          {volume ? <IconVolume size={16} /> : <IconVolumeOff size={16} />}
        </button>
        <input
          className="seek"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          style={{ "--pct": `${volume * 100}%` } as CSSProperties}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </div>

      {props.upNext.length > 0 && (
        <div className="up-next">
          <div className="label">Up next</div>
          {props.upNext.map((s) => (
            <button key={s.id} className="up-next-row" onClick={() => props.onPick(s)}>
              <img src={s.thumbnail} alt="" />
              <span className="meta">
                <span className="title">{s.title}</span>
                <span className="channel">{s.channel}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
