import argparse
from pathlib import Path
from tempfile import TemporaryDirectory

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


def separate(source: Path, output: Path) -> None:
    import librosa
    from mel_band_roformer.inference import proc_folder

    models = Path(__file__).parent / "models"
    audio, rate = sf.read(source, dtype="float32", always_2d=True)
    if not np.isfinite(audio).all():
        raise ValueError("audio contains invalid samples.")
    if rate != 44100:
        audio = librosa.resample(audio, orig_sr=rate, target_sr=44100, axis=0)
    audio = normalize_audio(audio)

    with TemporaryDirectory(prefix="musical-stems-") as work:
        sf.write(Path(work) / "source.wav", audio, 44100, subtype="FLOAT")
        proc_folder([
            "--config_path", str(models / "vocals_mel_band_roformer.yaml"),
            "--model_path", str(models / "vocals_mel_band_roformer.ckpt"),
            "--input_folder", work,
            "--store_dir", str(output),
        ])
    for stem in ("vocals", "instrumental"):
        samples, sample_rate = sf.read(output / f"source_{stem}.wav", always_2d=True)
        if sample_rate != 44100 or samples.shape != audio.shape or not np.isfinite(samples).all():
            raise ValueError("separator returned invalid audio stems.")
        sf.write(output / f"source_{stem}.wav", normalize_audio(samples), sample_rate, subtype="FLOAT")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    validate_audio(args.source)
    if not args.validate_only:
        if args.output is None:
            parser.error("output directory is required for separation")
        separate(args.source, args.output)
