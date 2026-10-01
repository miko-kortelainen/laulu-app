import argparse
import logging
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import soundfile as sf

from audio import normalize_audio, read_audio


def remove_echo(source: Path, output: Path) -> None:
    import torch
    from audio_separator.separator.architectures.vr_separator import VRSeparator

    audio = read_audio(source)
    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    model = Path(__file__).parent / "models" / "dereverb" / "UVR-DeEcho-DeReverb.pth"
    if not model.is_file():
        raise ValueError(f"missing local model: {model}")

    # UVR metadata for checkpoint hash 0fb9249ffe4ffc38d7b16243f394c0ff.
    # Use the VR loader directly: local weights and soundfile need no model registry or ffmpeg.
    separator = VRSeparator({
        "logger": logging.getLogger("dereverb"),
        "log_level": logging.WARNING,
        "torch_device": torch.device(device),
        "torch_device_cpu": torch.device("cpu"),
        "torch_device_mps": torch.device("mps") if device == "mps" else None,
        "model_name": model.stem,
        "model_path": str(model),
        "model_data": {"vr_model_param": "4band_v3", "primary_stem": "No Reverb"},
        "output_dir": str(output),
        "output_format": "WAV",
        "output_single_stem": "No Reverb",
        "normalization_threshold": 0.9,
        "amplification_threshold": 0.7,
        "sample_rate": 44100,
        "use_soundfile": True,
    }, {"batch_size": 1, "window_size": 512})
    separator.input_subtype = "FLOAT"
    with TemporaryDirectory(prefix="musical-dereverb-") as work:
        filename = Path(work) / "source.wav"
        # Preserve the last partial STFT frame; the highest band uses a 960-sample FFT.
        padded = np.pad(audio, ((0, 960), (0, 0)))
        sf.write(filename, padded, 44100, subtype="FLOAT")
        separator.separate(str(filename), {"No Reverb": "source_cleaned"})

    filename = output / "source_cleaned.wav"
    samples, rate = sf.read(filename, dtype="float32", always_2d=True)
    if rate != 44100 or samples.shape[1] != 2 or not np.isfinite(samples).all():
        raise ValueError("echo removal returned invalid audio.")
    if not len(audio) <= len(samples) <= len(audio) + 960:
        raise ValueError("echo removal returned an unexpected audio duration.")
    samples = samples[:len(audio)]
    if audio.shape[1] == 1:
        samples = samples.mean(axis=1, keepdims=True)
    sf.write(filename, normalize_audio(samples), rate, subtype="FLOAT")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    remove_echo(args.source, args.output)
