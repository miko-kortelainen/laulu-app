from pathlib import Path

import numpy as np
import soundfile as sf


def normalize_audio(audio: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(audio)))
    return audio * (min(0.9, max(0.7, peak)) / peak) if peak else audio


def validate_audio(source: Path) -> None:
    info = sf.info(source)
    if info.format not in {"WAV", "WAVEX", "RF64", "FLAC", "OGG", "MP3"}:
        raise ValueError("choose an MP3, WAV, FLAC, or OGG file.")
    if not info.frames or info.channels not in (1, 2) or not 0 < info.duration <= 600:
        raise ValueError("audio must be mono or stereo and between 0 and 10 minutes long.")


def read_audio(source: Path) -> np.ndarray:
    import librosa

    validate_audio(source)
    audio, rate = sf.read(source, dtype="float32", always_2d=True)
    if not np.isfinite(audio).all():
        raise ValueError("audio contains invalid samples.")
    if rate != 44100:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=44100, axis=0)
    return normalize_audio(audio)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    validate_audio(parser.parse_args().source)
