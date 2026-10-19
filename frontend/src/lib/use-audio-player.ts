import { useCallback, useEffect, useRef, useState } from "react";
import { getPlaybackUrl } from "./api";

export function useAudioPlayer(src: string, active = true) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [buffered, setBuffered] = useState<{ start: number; end: number }[]>([]);
  const [buffering, setBuffering] = useState(false);
  const [playbackError, setPlaybackError] = useState<string>();
  const resumeTime = useRef(0);
  const loadingAudio = useRef<Promise<void> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);

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
    return () => {
      controller.current?.abort();
      loadingAudio.current = undefined;
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, [loadAudio]);

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
    setBuffering(true);
    if (!audio.getAttribute("src") || audio.error) {
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
    if (audioRef.current) audioRef.current.volume = value;
    setVolume(value);
  }

  function updateMediaState(): void {
    const audio = audioRef.current;
    if (!audio) return;
    setTime(audio.currentTime);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    const ranges = audio.buffered;
    setBuffered(Array.from({ length: ranges.length }, (_, index) => ({
      start: ranges.start(index), end: ranges.end(index),
    })));
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
