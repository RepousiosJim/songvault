import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  IconArrowsShuffle,
  IconDownload,
  IconListDetails,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconRepeat,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react";
import { artistOf, cleanTitle } from "./songs";
import type { Song } from "./types";

const PLAYED_SECONDS = 30;

export interface Track {
  key: string;
  src?: string;
  artwork: string;
  audioOnly: boolean;
  title: string;
  artist?: string;
  gain?: number;
  status?: string;
}

export const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && !!target.closest("input:not([type=range]), textarea, select");

export function formatDuration(secs: number) {
  const s = Math.floor(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Props {
  track: Track | null;
  upNext: Song[];
  expanded: boolean;
  canPrev: boolean;
  canNext: boolean;
  shuffle: boolean;
  repeat: boolean;
  onToggleExpanded: () => void;
  onPrev: () => void;
  onNext: () => void;
  onEnded: () => void;
  onShuffle: () => void;
  onRepeat: () => void;
  onPick: (song: Song) => void;
  onPlayed?: () => void;
  onDownload?: () => void;
}

export function Player(props: Props) {
  const { track } = props;
  const video = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [noVideo, setNoVideo] = useState(false);
  const played = useRef(false);
  const open = props.expanded && !!track;
  const showArt = !!track && (track.audioOnly || noVideo);

  useEffect(() => {
    setTime(0);
    setDuration(0);
    setNoVideo(false);
    played.current = false;
  }, [track?.key]);

  useEffect(() => {
    if (video.current) video.current.volume = volume * (track?.gain ?? 1);
  }, [volume, track?.key, track?.gain]);

  function toggle() {
    const v = video.current;
    if (!v?.src) return;
    v.paused ? v.play() : v.pause();
  }

  const latest = useRef(props);
  latest.current = props;

  function countPlay() {
    if (played.current) return;
    played.current = true;
    props.onPlayed?.();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const v = video.current;
      if (!v || isTyping(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === " ") toggle();
      else if (e.key === "ArrowLeft") v.currentTime -= 5;
      else if (e.key === "ArrowRight") v.currentTime += 5;
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!track) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      artwork: [{ src: track.artwork }],
    });
  }, [track?.key, track?.title, track?.artist]);

  useEffect(() => {
    const session = navigator.mediaSession;
    session.setActionHandler("play", () => video.current?.play());
    session.setActionHandler("pause", () => video.current?.pause());
    session.setActionHandler("seekto", (d) => {
      if (video.current && d.seekTime != null) video.current.currentTime = d.seekTime;
    });
  }, []);

  useEffect(() => {
    navigator.mediaSession.setActionHandler("previoustrack", props.canPrev ? () => latest.current.onPrev() : null);
    navigator.mediaSession.setActionHandler("nexttrack", props.canNext ? () => latest.current.onNext() : null);
  }, [props.canPrev, props.canNext]);

  const bar = (
    <footer className="player-bar">
      <div className="bar-track">
        {track && (
          <button className="bar-art" aria-label="Now playing" onClick={props.onToggleExpanded}>
            <img src={track.artwork} alt="" />
          </button>
        )}
        <div className="meta">
          <span className="title">{track?.title ?? "Nothing playing"}</span>
          <span className="channel">
            {track?.status ?? track?.artist}
            {props.onDownload && (
              <button className="chip" onClick={props.onDownload}>
                <IconDownload size={14} /> Download
              </button>
            )}
          </span>
        </div>
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

      <div className="bar-seek">
        <span>{formatDuration(time)}</span>
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
        <span>{formatDuration(duration)}</span>
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

      <button className={open ? "upnext-toggle on" : "upnext-toggle"} disabled={!track} onClick={props.onToggleExpanded}>
        <IconListDetails size={18} />
        Up next
      </button>
    </footer>
  );

  return (
    <>
      <section className={open ? "now-playing open" : "now-playing"}>
        <div className="np-main">
          <div className="stage">
            {track && (
              <video
                key={track.key}
                ref={video}
                className="screen"
                src={track.src}
                autoPlay
                onClick={toggle}
                onDoubleClick={() => video.current?.requestFullscreen()}
                onPlay={() => setPaused(false)}
                onPause={() => setPaused(true)}
                onTimeUpdate={(e) => {
                  setTime(e.currentTarget.currentTime);
                  if (e.currentTarget.currentTime >= PLAYED_SECONDS) countPlay();
                }}
                onLoadedMetadata={(e) => {
                  setDuration(e.currentTarget.duration);
                  setNoVideo(e.currentTarget.videoWidth === 0);
                }}
                onEnded={() => {
                  countPlay();
                  props.onEnded();
                }}
              />
            )}
            {showArt && <img className="artwork" src={track.artwork} alt="" />}
          </div>
          <div className="np-title">{track?.title}</div>
          <div className="np-artist">{track?.artist}</div>
        </div>
        {props.upNext.length > 0 && (
          <div className="up-next">
            <div className="label">Up next</div>
            {props.upNext.map((s) => (
              <button key={s.id} className="up-next-row" onClick={() => props.onPick(s)}>
                <img src={s.thumbnail} alt="" />
                <span className="meta">
                  <span className="title">{cleanTitle(s.title)}</span>
                  <span className="channel">{artistOf(s)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      {bar}
    </>
  );
}
