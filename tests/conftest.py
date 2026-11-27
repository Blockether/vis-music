"""One engine for the test session, on its own cache and without the network."""

import math
import os
import struct
import wave
from pathlib import Path

import pytest


def write_click(path, seconds=0.1, rate=44100):
    """A short decaying sine, as a 16-bit mono WAV sample."""
    frames = b"".join(
        struct.pack("<h", int(20000 * math.exp(-30 * i / rate) * math.sin(2 * math.pi * 880 * i / rate)))
        for i in range(int(seconds * rate))
    )
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(frames)


@pytest.fixture(scope="session")
def samples(tmp_path_factory):
    """A directory with one sample, `click.wav`, as a file:// base URL."""
    root = tmp_path_factory.mktemp("samples")
    write_click(root / "click.wav")
    return root.as_uri() + "/"


@pytest.fixture(scope="session")
def music(tmp_path_factory):
    """The tools on a private cache, with the remote sample maps turned off."""
    os.environ["VIS_MUSIC_CACHE"] = str(tmp_path_factory.mktemp("cache"))
    os.environ["VIS_MUSIC_OFFLINE"] = "1"
    local = Path(__file__).resolve().parents[1] / "js" / "node_modules" / "node-web-audio-api"
    if local.is_dir():
        os.environ.setdefault("VIS_MUSIC_WEBAUDIO", str(local))
    from vis_music.tools import MusicTools

    workspace = tmp_path_factory.mktemp("workspace")
    tools = MusicTools(workspace_root=lambda: workspace)
    yield tools
    tools.stop(shutdown=True)
