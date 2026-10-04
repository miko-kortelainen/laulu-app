import { useCallback, useEffect, useRef, useState } from "react";
import { authenticatedFetch } from "./api";

async function loadWaveform(blob: Blob, signal: AbortSignal): Promise<string> {
  // A low sample rate keeps waveform decoding small; playback uses the original file.
  const context = new OfflineAudioContext(1, 1, 8000);
  const buffer = await context.decodeAudioData(await blob.arrayBuffer());
  signal.throwIfAborted();
  const peaks = new Float32Array(80);

  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let bar = 0; bar < peaks.length; bar++) {
      const start = Math.floor(bar * samples.length / peaks.length);
      const end = Math.floor((bar + 1) * samples.length / peaks.length);
      for (let sample = start; sample < end; sample++) {
        peaks[bar] = Math.max(peaks[bar], Math.abs(samples[sample]));
      }
    }
  }

  const maximum = Math.max(...peaks) || 1;
  return Array.from(peaks, (peak, index) => {
    const height = Math.max(1, peak / maximum * 20);
    return `M${index * 3 + 1.5} ${24 - height}v${height * 2}`;
  }).join(" ");
}

export function useAudioPlayer(src: string) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [waveform, setWaveform] = useState<string>();
  const [waveformError, setWaveformError] = useState(false);
  const [playbackError, setPlaybackError] = useState<string>();
  const blobUrl = useRef<string | undefined>(undefined);
  const loadingAudio = useRef<Promise<void> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);

  const loadAudio = useCallback((): Promise<void> => {
    if (loadingAudio.current) return loadingAudio.current;
    const signal = controller.current!.signal;
    const request = authenticatedFetch(src, { signal }).then(async (response) => {
      if (!response.ok) throw new Error("could not load audio.");
      const blob = await response.blob();
      signal.throwIfAborted();
      const audio = audioRef.current;
      if (!audio) return;
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
      blobUrl.current = URL.createObjectURL(blob);
      audio.src = blobUrl.current;
      audio.load();
      const waveform = await loadWaveform(blob, signal).catch(() => undefined);
      if (signal.aborted) return;
      setWaveform(waveform);
      setWaveformError(!waveform);
    }).finally(() => { if (loadingAudio.current === request) loadingAudio.current = undefined; });
    loadingAudio.current = request;
    return request;
  }, [src]);

  useEffect(() => {
    controller.current = new AbortController();
    const signal = controller.current.signal;
    const audio = audioRef.current;
    void loadAudio().catch(() => {
      if (signal.aborted) return;
      setWaveformError(true);
      setPlaybackError("could not load audio. try play again.");
    });
    return () => {
      controller.current?.abort();
      loadingAudio.current = undefined;
      audio?.pause();
      audio?.removeAttribute("src");
      if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
    };
  }, [loadAudio]);

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
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (!audio.getAttribute("src") || audio.error) {
      const failure = await loadAudio().catch(() => new Error("could not load audio. try play again."));
      if (failure) {
        setPlaybackError(failure.message);
        return;
      }
    }
    await audio.play().catch((error: unknown) => {
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

  const audioProps = {
    ref: audioRef,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: () => setTime(audioRef.current?.currentTime ?? 0),
    onDurationChange: () => {
      const value = audioRef.current?.duration;
      setDuration(value && Number.isFinite(value) ? value : 0);
    },
    onError: () => {
      setPlaying(false);
      setPlaybackError("could not load audio. try play again.");
    },
  };

  return { audioProps, playing, time, duration, volume, waveform, waveformError, playbackError, togglePlayback, seek, stop, changeVolume };
}
