import argparse
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import soundfile as sf

from audio import normalize_audio, read_audio


def separate(source: Path, output: Path) -> None:
    from mel_band_roformer.inference import proc_folder

    models = Path(__file__).parent / "models" / "stems"
    audio = read_audio(source)

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
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    separate(args.source, args.output)
