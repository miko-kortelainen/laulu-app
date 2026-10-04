import { useEffect, useRef, useState } from "react";

async function loadWaveform(src: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(src, { signal });
  if (!response.ok) throw new Error("could not load waveform.");
  // A low sample rate keeps waveform decoding small; playback uses the original file.
  const context = new OfflineAudioContext(1, 1, 8000);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
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

  useEffect(() => {
    const controller = new AbortController();
    const audio = audioRef.current;
    void loadWaveform(src, controller.signal).then((path) => {
      if (!controller.signal.aborted) setWaveform(path);
    }).catch(() => {
      if (!controller.signal.aborted) setWaveformError(true);
    });
    return () => {
      controller.abort();
      audio?.pause();
    };
  }, [src]);

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
    if (audio.error) audio.load();
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
    src,
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
