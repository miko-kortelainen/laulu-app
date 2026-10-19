import { useCallback, useEffect, useRef, useState } from "react";
import { getPlaybackUrl } from "./api";

function readSavedVolume(): number {
  try {
    const stored = localStorage.getItem("laulu:volume");
    const value = stored === null ? 1 : Number(stored);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch {
    return 1;
  }
}

let savedVolume = readSavedVolume();

export function useAudioPlayer(src: string, active = true) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(() => savedVolume);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [buffering, setBufferingVisible] = useState(false);
  const [playbackError, setPlaybackError] = useState<string>();
  const resumeTime = useRef(0);
  const loadingAudio = useRef<Promise<void> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const bufferingTimer = useRef<number | undefined>(undefined);

  const setBuffering = useCallback((waiting: boolean): void => {
    window.clearTimeout(bufferingTimer.current);
    if (!waiting) {
      setBufferingVisible(false);
      return;
    }
    bufferingTimer.current = window.setTimeout(() => setBufferingVisible(true), 250);
  }, []);

  const updateMediaState = useCallback((): void => {
    const audio = audioRef.current;
    if (!audio) return;
    setTime(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const ranges = audio.buffered;
    const next = Array.from({ length: ranges.length }, (_, index) => ({
      start: ranges.start(index), end: ranges.end(index),
    }));
    setBuffered((current) => current.length === next.length && current.every((range, index) =>
      range.start === next[index].start && range.end === next[index].end,
    ) ? current : next);
  }, []);

  const loadAudio = useCallback((): Promise<void> => {
    if (loadingAudio.current) return loadingAudio.current;
    const signal = controller.current!.signal;
    const request = getPlaybackUrl(src, signal).then((url) => {
      signal.throwIfAborted();
      const audio = audioRef.current;
      if (!audio) return;
      resumeTime.current = audio.currentTime;
      setBuffered([]);
      audio.src = url;
      audio.load();
    }).finally(() => { if (loadingAudio.current === request) loadingAudio.current = undefined; });
    loadingAudio.current = request;
    return request;
  }, [src]);

  // Fetch the signed URL and media only on play: a metadata preload makes
  // Firefox download the whole MP3 before the user asks for audio.
  useEffect(() => {
    controller.current = new AbortController();
    const audio = audioRef.current;
    if (audio) audio.volume = savedVolume;
    // Buffer ranges can change after the last media event while paused.
    const timer = window.setInterval(() => {
      if (audio?.paused && audio.getAttribute("src") && !audio.error) updateMediaState();
    }, 500);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(bufferingTimer.current);
      controller.current?.abort();
      loadingAudio.current = undefined;
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, [loadAudio, updateMediaState]);

  useEffect(() => {
    if (!active) audioRef.current?.pause();
  }, [active]);

  useEffect(() => {
    if (!playing) return;
    let frame: number;
    function updateTime() {
      setTime(audioRef.current?.currentTime ?? 0);
      frame = requestAnimationFrame(updateTime);
    }
    frame = requestAnimationFrame(updateTime);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  async function togglePlayback(): Promise<void> {
    const audio = audioRef.current;
    if (!audio) return;
    setPlaybackError(undefined);
    // A failed element can still report paused === false in Firefox; an error always means reload, never pause.
    if (!audio.paused && !audio.error) {
      audio.pause();
      return;
    }
    if (!audio.getAttribute("src") || audio.error) {
      setBuffering(true);
      const failure = await loadAudio().catch(() => new Error("could not load audio. try play again."));
      if (failure) {
        setBuffering(false);
        setPlaybackError(failure.message);
        return;
      }
    }
    await audio.play().catch((error: unknown) => {
      setBuffering(false);
      if (error instanceof DOMException && error.name === "AbortError") return;
      setPlaybackError("could not play audio. try again.");
    });
  }

  function seek(value: number): void {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = Math.max(0, Math.min(value, duration));
    setTime(audio.currentTime);
  }

  function stop(): void {
    audioRef.current?.pause();
    seek(0);
  }

  function changeVolume(value: number): void {
    savedVolume = value;
    for (const audio of document.querySelectorAll("audio")) audio.volume = value;
    setVolume(value);
    try { localStorage.setItem("laulu:volume", String(value)); }
    catch { /* Keep the shared volume for this session when storage is unavailable. */ }
  }

  const audioProps = {
    ref: audioRef,
    onPlay: () => {
      const currentAudio = audioRef.current;
      if (!currentAudio || currentAudio.paused) return;
      if (!active) {
        currentAudio.pause();
        return;
      }

      for (const audio of document.querySelectorAll("audio")) {
        if (audio !== currentAudio) audio.pause();
      }
      setPlaying(true);
    },
    onPause: () => { setPlaying(false); setBuffering(false); updateMediaState(); },
    onVolumeChange: () => setVolume(audioRef.current?.volume ?? savedVolume),
    onEnded: () => { setPlaying(false); setBuffering(false); updateMediaState(); },
    onWaiting: () => setBuffering(!audioRef.current?.paused),
    onPlaying: () => { setBuffering(false); setPlaybackError(undefined); updateMediaState(); },
    onLoadedMetadata: () => {
      if (resumeTime.current > 0 && audioRef.current) audioRef.current.currentTime = resumeTime.current;
      resumeTime.current = 0;
      updateMediaState();
    },
    onProgress: updateMediaState,
    onTimeUpdate: updateMediaState,
    onDurationChange: updateMediaState,
    onLoadedData: updateMediaState,
    onCanPlay: updateMediaState,
    onSeeked: updateMediaState,
    onSuspend: updateMediaState,
    onError: () => {
      // Firefox can deliver a stale error from the previous load after a retry has already recovered.
      const current = audioRef.current;
      if (current && (!current.error || (!current.paused && current.readyState >= 2 && current.currentTime > 0))) return;
      setPlaying(false);
      setBuffering(false);
      setPlaybackError("could not load audio. try play again.");
    },
  };

  return { audioProps, playing, time, duration, volume, buffered, buffering, playbackError, togglePlayback, seek, stop, changeVolume };
}
