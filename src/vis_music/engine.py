"""The music engine: one Node process that plays and renders Strudel tracks.

The process is kept under one shell id. So a track keeps playing after the call
that started it, also across sandbox restarts, until `stop` or `shutdown`.
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import platform
import shutil
import sys
import threading
import uuid
from pathlib import Path

from vis_lang_interface import ToolMissing, run, runtime

from vis_music.errors import MusicError

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "engine" / "engine.mjs"
NATIVE = HERE / "native"
MIN_NODE = 18


def cache_dir():
    """Where downloaded samples, renders and a locally built doughbox live."""
    named = os.environ.get("VIS_MUSIC_CACHE")
    if named:
        return Path(named).expanduser()
    base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    return Path(base) / "vis-music"


def platform_tag():
    """This machine as a prebuild directory name, such as `macos-arm64`."""
    system = {"darwin": "macos", "win32": "windows"}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    return f"{system}-{arch}"


def _executable_copy(binary):
    """An executable copy of `binary` in the cache, named by its content.

    Vis can load an extension from a snapshot of its sources that drops the
    executable bit, so the prebuild cannot run where it lies.
    """
    data = binary.read_bytes()
    digest = hashlib.sha256(data).hexdigest()[:16]
    copy = cache_dir() / "bin" / platform_tag() / f"{binary.stem}-{digest}{binary.suffix}"
    if os.access(copy, os.X_OK):
        return copy
    copy.parent.mkdir(parents=True, exist_ok=True)
    partial = copy.with_name(f".{copy.name}.{os.getpid()}.partial")
    partial.write_bytes(data)
    partial.chmod(0o755)
    os.replace(partial, copy)
    return copy


def doughbox():
    """The doughbox binary: the prebuild for this platform, else one built here."""
    name = "doughbox.exe" if sys.platform == "win32" else "doughbox"
    prebuilt = NATIVE / platform_tag() / name
    if prebuilt.is_file():
        return prebuilt if os.access(prebuilt, os.X_OK) else _executable_copy(prebuilt)
    built = cache_dir() / "bin" / platform_tag() / name
    if built.is_file():
        return built
    compiler = shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if compiler is None:
        raise ToolMissing(f"no doughbox prebuild for {platform_tag()} and no C compiler to build one")
    built.parent.mkdir(parents=True, exist_ok=True)
    source = NATIVE / "src"
    libraries = ["-lm", "-lpthread", "-ldl"]
    if sys.platform == "darwin":
        libraries = [
            "-lm",
            "-lpthread",
            "-framework",
            "CoreAudio",
            "-framework",
            "AudioToolbox",
            "-framework",
            "CoreFoundation",
        ]
    temporary = built.with_suffix(".tmp")
    done = run(
        [
            compiler,
            "-std=gnu11",
            "-O2",
            "-w",
            f"-I{source}",
            f"-I{source / 'libs'}",
            str(source / "doughbox.c"),
            "-o",
            str(temporary),
            *libraries,
        ],
        timeout_s=600,
        read_write=[built.parent],
    )
    if not done.is_ok:
        raise MusicError(f"cannot build doughbox for {platform_tag()}: {(done.err or done.out)[-2000:]}")
    os.replace(temporary, built)
    return built


def node():
    """The Node.js binary: the bundled wheel, else `node` on PATH."""
    spec = importlib.util.find_spec("nodejs_wheel")
    if spec and spec.origin:
        home = Path(spec.origin).parent
        for candidate in (home / "bin" / "node", home / "node.exe"):
            if candidate.is_file():
                return candidate
    found = shutil.which("node")
    if found is None:
        raise ToolMissing(f"Node.js {MIN_NODE} or newer is needed: install nodejs-wheel-binaries or put node on PATH")
    return Path(found)


def _command():
    """The argv that starts the engine."""
    box = doughbox()
    command = [node(), BUNDLE, "--doughbox", box, "--cache", cache_dir() / "sounds", "--build", _build(box)]
    if os.environ.get("VIS_MUSIC_OFFLINE"):
        command.append("--offline")
    return [str(part) for part in command]


def _build(box):
    """A fingerprint of the engine files. A kept engine of an older build is
    replaced, because its command differs."""
    stats = [os.stat(path) for path in (BUNDLE, box)]
    return hashlib.sha256(repr([(s.st_size, s.st_mtime_ns) for s in stats]).encode()).hexdigest()[:12]


def _shell_id():
    """One kept engine for each cache directory."""
    return "vis-music-" + hashlib.sha256(str(cache_dir()).encode()).hexdigest()[:12]


class Engine:
    """The conversation with the engine process, started on the first request."""

    def __init__(self):
        self._live = None
        self._lock = threading.Lock()

    def _runtime(self):
        with self._lock:
            if self._live is not None and self._live.is_running:
                return self._live
            cache = cache_dir()
            cache.mkdir(parents=True, exist_ok=True)
            self._live = runtime.start(
                _command(),
                cwd=str(cache),
                read_write=[cache],
                name="vis-music",
                shell_id=_shell_id(),
            )
            return self._live

    def request(self, op, timeout_s=120.0, **fields):
        """Send `op` with `fields` and answer the engine's reply.

        Raises MusicError when the engine reports a failure.
        """
        key = uuid.uuid4().hex
        try:
            answer = self._runtime().request({"id": key, "op": op, **fields}, timeout_s, wants=key)
        except runtime.RuntimeGone as gone:
            with self._lock:
                self._live = None
            raise MusicError(f"the music engine stopped: {gone}") from gone
        if not answer.get("ok"):
            raise MusicError(str(answer.get("error") or "the music engine failed"))
        return answer

    def is_running(self):
        """Whether the engine process is alive, without starting it."""
        with self._lock:
            return self._live is not None and self._live.is_running

    def shutdown(self):
        """End the engine process, and with it any sound it plays."""
        with self._lock:
            live, self._live = self._live, None
            if live is None:
                # A kept engine that an earlier sandbox process started.
                live = runtime._attach(_shell_id(), _command(), str(cache_dir()))
        if live is not None:
            live.stop()
        return live is not None
