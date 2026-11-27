"""The music engine: one Node process that plays and renders Strudel tracks.

The process is kept under one shell id. So a track keeps playing after the call
that started it, also across sandbox restarts, until `stop` or `shutdown`.
"""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import os
import platform
import shutil
import sys
import tarfile
import threading
import urllib.request
import uuid
from pathlib import Path

from vis_lang_interface import ToolMissing, runtime

from vis_music.errors import MusicError

HERE = Path(__file__).resolve().parent
BUNDLE = HERE / "engine" / "engine.mjs"
MIN_NODE = 20

# node-web-audio-api: the Web Audio API for Node, on which superdough plays.
# One npm tarball holds the binaries of every platform; a checked copy of it,
# with only this platform's binary and its two JavaScript dependencies, lives in
# the cache. The versions and checksums are those of js/package-lock.json.
WEBAUDIO_VERSION = "2.3.0"
WEBAUDIO_PACKAGES = {
    "node-web-audio-api": (
        WEBAUDIO_VERSION,
        "pMt4Lozrg2jSiAdWpttAIFey2SH0W+dFr2o8yWWF2FjUbpc1NLyyax2W815re6vL/rfbDc9J1Y4XiLEr7144LQ==",
    ),
    "caller": ("1.1.0", "n+21IZC3j06YpCWaxmUy5AnVqhmCIM2bQtqQyy00HJlmStRt6kwDX5F9Z97pqwAB+G/tgSz6q/kUBbNyQzIubw=="),
    "webidl-conversions": (
        "8.0.1",
        "BMhLD/Sw+GbJC21C/UgyaZX41nPt8bUTg+jWyDeg7e7YN4xOM05YPSIXceACnXVtqyEw/LMClUQMtMZ+PGGpqQ==",
    ),
}


def cache_dir():
    """Where downloaded samples, renders and node-web-audio-api live."""
    named = os.environ.get("VIS_MUSIC_CACHE")
    if named:
        return Path(named).expanduser()
    base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    return Path(base) / "vis-music"


def _binary_tag():
    """This machine in the binary names of node-web-audio-api, such as `darwin-arm64`."""
    machine = platform.machine().lower()
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64"}.get(machine, machine)
    return f"{sys.platform}-{arch}"


def webaudio():
    """The node-web-audio-api directory: `$VIS_MUSIC_WEBAUDIO`, else the cached copy."""
    named = os.environ.get("VIS_MUSIC_WEBAUDIO")
    if named:
        return Path(named).expanduser()
    home = cache_dir() / "webaudio" / WEBAUDIO_VERSION
    if _installed(home):
        return home
    return _install_webaudio(home)


def _package_dir(home, name):
    """Where package `name` lives in the node-web-audio-api directory `home`."""
    return home if name == "node-web-audio-api" else home / "node_modules" / name


def _installed(home):
    """True when `home` has every package of WEBAUDIO_PACKAGES."""
    return all((_package_dir(home, name) / "package.json").is_file() for name in WEBAUDIO_PACKAGES)


def _download(name, version, sha512):
    """The checked npm tarball of one package, as bytes."""
    url = f"https://registry.npmjs.org/{name}/-/{name}-{version}.tgz"
    try:
        with urllib.request.urlopen(url, timeout=120) as response:
            data = response.read()
    except OSError as error:
        raise ToolMissing(f"cannot download {name} {version}: {error}") from error
    if base64.b64encode(hashlib.sha512(data).digest()).decode() != sha512:
        raise MusicError(f"the {name} {version} download does not match its checksum")
    return data


def _install_webaudio(home):
    """Download the pinned tarballs, check them, and unpack them to `home` in one rename."""
    tag = f".{_binary_tag()}"
    partial = home.with_name(f".{home.name}.{os.getpid()}.partial")
    shutil.rmtree(partial, ignore_errors=True)
    try:
        for name, (version, sha512) in WEBAUDIO_PACKAGES.items():
            data = _download(name, version, sha512)
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
                members = [
                    m
                    for m in archive.getmembers()
                    if m.name.startswith("package/") and (not m.name.endswith(".node") or tag in m.name)
                ]
                if name == "node-web-audio-api" and not any(m.name.endswith(".node") for m in members):
                    raise ToolMissing(f"node-web-audio-api has no binary for {_binary_tag()}")
                archive.extractall(partial / name, members=members, filter="data")
            target = _package_dir(partial / "home", name)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(partial / name / "package", target)
        if home.exists() and not _installed(home):
            os.replace(home, partial / "old")  # an incomplete copy of an older vis-music
        try:
            os.replace(partial / "home", home)
        except OSError:
            if not _installed(home):
                raise
    finally:
        shutil.rmtree(partial, ignore_errors=True)
    return home


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
    audio = webaudio()
    command = [node(), BUNDLE, "--webaudio", audio, "--cache", cache_dir() / "sounds", "--build", _build(audio)]
    if os.environ.get("VIS_MUSIC_OFFLINE"):
        command.append("--offline")
    return [str(part) for part in command]


def _build(audio):
    """A fingerprint of the engine files. A kept engine of an older build is
    replaced, because its command differs."""
    stats = [os.stat(path) for path in (BUNDLE, audio / "package.json")]
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
