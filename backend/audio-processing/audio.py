from pathlib import Path

import soundfile as sf


def validate_audio(source: Path) -> None:
    info = sf.info(source)
    if info.format not in {"WAV", "WAVEX", "RF64", "FLAC", "OGG", "MP3"}:
        raise ValueError("choose an MP3, WAV, FLAC, or OGG file.")
    if not info.frames or info.channels not in (1, 2) or not 0 < info.duration <= 600:
        raise ValueError("audio must be mono or stereo and between 0 and 10 minutes long.")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    validate_audio(parser.parse_args().source)
