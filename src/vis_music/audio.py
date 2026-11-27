"""Turn a rendered WAV into the file the person asked for."""

from __future__ import annotations

import os
import shutil
import wave
from pathlib import Path

from vis_lang_interface import ToolMissing, run

from vis_music.errors import MusicError

FFMPEG_FORMATS = (".flac", ".ogg", ".opus", ".m4a", ".aac")
FORMATS = (".wav", ".mp3", *FFMPEG_FORMATS)


def check_format(out):
    """Raise MusicError unless `out` names a format vis-music writes."""
    if Path(out).suffix.lower() not in FORMATS:
        raise MusicError(
            f"cannot write {Path(out).suffix or 'a file without a suffix'}: use one of {', '.join(FORMATS)}"
        )


def _mp3_lame(wav, out, bitrate):
    import lameenc

    with wave.open(str(wav), "rb") as source:
        rate, channels, frames = source.getframerate(), source.getnchannels(), source.readframes(source.getnframes())
    encoder = lameenc.Encoder()
    encoder.set_bit_rate(int(bitrate))
    encoder.set_in_sample_rate(rate)
    encoder.set_channels(channels)
    encoder.set_quality(2)
    out.write_bytes(encoder.encode(frames) + encoder.flush())


def _ffmpeg(wav, out, bitrate):
    if shutil.which("ffmpeg") is None:
        raise ToolMissing(f"writing {out.suffix} needs ffmpeg on PATH")
    done = run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav), "-b:a", f"{int(bitrate)}k", str(out)],
        timeout_s=600,
        read_write=[out.parent, wav.parent],
    )
    if not done.is_ok:
        raise MusicError(f"ffmpeg cannot write {out.name}: {(done.err or done.out).strip()[-1000:]}")


def encode(wav, out, bitrate=192):
    """Write `wav` to `out` in the format of its suffix, atomically, and answer `out`.

    MP3 uses lameenc when it is installed, else ffmpeg. FLAC, Ogg, Opus and AAC
    use ffmpeg.
    """
    wav, out = Path(wav), Path(out)
    check_format(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    suffix = out.suffix.lower()
    partial = out.with_name(f".{out.stem}.partial{suffix}")
    try:
        if suffix == ".wav":
            shutil.copyfile(wav, partial)
        elif suffix == ".mp3":
            try:
                _mp3_lame(wav, partial, bitrate)
            except ImportError:
                _ffmpeg(wav, partial, bitrate)
        else:
            _ffmpeg(wav, partial, bitrate)
        os.replace(partial, out)
    finally:
        partial.unlink(missing_ok=True)
    return out
