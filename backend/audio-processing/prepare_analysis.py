import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

from audio import validate_audio


def prepare_analysis(source: Path, output: Path) -> None:
    validate_audio(source)
    audio, rate = sf.read(source, dtype="float32", always_2d=True)
    if not np.isfinite(audio).all():
        raise ValueError("audio contains invalid samples.")
    if rate != 44100:
        import librosa

        audio = librosa.resample(audio, orig_sr=rate, target_sr=44100, axis=0)
    sf.write(output, audio, 44100, bitrate_mode="CONSTANT", compression_level=0.8)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    prepare_analysis(args.source, args.output)
