"""The tools of the `music` alias.

A track is Strudel code: `$:` or `name:` blocks of patterns, with `setcps` or
`setcpm` for the tempo. Every tool takes a track as a file path or as the code
itself.
"""

from __future__ import annotations

import shutil
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Annotated

from vis_lang_interface import string_list

from vis_music import audio
from vis_music.engine import Engine, cache_dir
from vis_music.errors import MusicError
from vis_music.results import (
    AudioFile,
    Event,
    Events,
    Export,
    Layer,
    Playback,
    SoundList,
    TrackInfo,
)

TRACK_SUFFIXES = (".strudel", ".str", ".js", ".mjs", ".txt")
DEFAULT_SUFFIX = ".strudel"
MAX_PATH = 1024
Track = Annotated[str, "Track file path, or the Strudel code itself."]
LayerNames = Annotated[Sequence[str], "Layers to use, by label; empty uses the layers Strudel plays (solo, not muted)."]


def _layers(rows):
    return tuple(
        Layer(row["name"], bool(row.get("muted")), bool(row.get("solo")), bool(row.get("playing")))
        for row in rows or ()
    )


def _playback(answer, source=""):
    return Playback(
        is_playing=bool(answer.get("playing")),
        cycle=answer.get("cycle"),
        cps=answer.get("cps"),
        layers=_layers(answer.get("layers")),
        events_sent=int(answer.get("events_sent") or 0),
        output=str(answer.get("output") or ""),
        warnings=tuple(answer.get("warnings") or ()),
        source=source,
        is_changed=bool(answer.get("changed")),
    )


def _attachment_id(stored):
    if isinstance(stored, dict):
        return str(stored.get("id") or "")
    return str(getattr(stored, "id", "") or "")


class MusicTools:
    """Compose Strudel tracks, play them live, layer by layer, and export audio."""

    def __init__(self, workspace_root=Path.cwd, attach=None, engine=None):
        self._workspace_root = workspace_root
        self._attach = attach
        self._engine = engine or Engine()
        self._playing = ""

    def _path(self, path):
        named = Path(path).expanduser()
        return named if named.is_absolute() else Path(self._workspace_root()) / named

    def _source(self, track):
        """The code of `track` and how to name it: its path, or `code`."""
        track = str(track or "")
        if not track.strip():
            raise MusicError("give a track: a file path or Strudel code")
        if "\n" not in track and len(track) < MAX_PATH:
            path = self._path(track)
            if path.is_file():
                return path.read_text(encoding="utf-8"), str(path)
            if path.suffix.lower() in TRACK_SUFFIXES and " " not in track:
                raise FileNotFoundError(f"no track file {path}")
        return track, "code"

    def check(self, track: Track) -> TrackInfo:
        """Compile a track and list its layers, tempo and unknown sounds.

        Raises MusicError with the compiler's message when the code is wrong.
        """
        code, source = self._source(track)
        answer = self._engine.request("check", code=code)
        return TrackInfo(
            source=source,
            cps=answer["cps"],
            layers=_layers({**row, "playing": False} for row in answer.get("layers") or ()),
            events_in_4_cycles=int(answer.get("events_in_4_cycles") or 0),
            warnings=tuple(answer.get("warnings") or ()),
        )

    def save(
        self,
        path: Annotated[str, f"Track file to write; `{DEFAULT_SUFFIX}` is added when it has no suffix."],
        code: Annotated[str, "Strudel code of the track."],
        *,
        overwrite: Annotated[bool, "Replace a file that exists."] = True,
    ) -> TrackInfo:
        """Check a track, then write it to a file. A track that does not compile
        is not written: MusicError says why."""
        target = self._path(path)
        if not target.suffix:
            target = target.with_suffix(DEFAULT_SUFFIX)
        if target.exists() and not overwrite:
            raise FileExistsError(f"{target} exists; pass overwrite=True to replace it")
        info = self.check(code)
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(f".{target.name}.partial")
        partial.write_text(code if code.endswith("\n") else code + "\n", encoding="utf-8")
        partial.replace(target)
        return TrackInfo(str(target), info.cps, info.layers, info.events_in_4_cycles, info.warnings, is_saved=True)

    def play(
        self,
        track: Track,
        *,
        layers: LayerNames = (),
        cps: Annotated[float, "Tempo in cycles per second; 0 keeps the track's own."] = 0,
    ) -> Playback:
        """Play a track live on the speakers, and return at once.

        The sound goes on until `music.stop()`. A second play replaces the
        playing track on the next beat without a gap, so call it again after each
        change, or with other `layers` to hear one part alone. Visual methods
        draw nothing; `.midi()`, OSC and the microphone do not play.
        """
        code, source = self._source(track)
        answer = self._engine.request("play", timeout_s=300, code=code, layers=string_list(layers), cps=float(cps or 0))
        self._playing = source
        return _playback(answer, source)

    def stop(
        self,
        *,
        shutdown: Annotated[bool, "Also end the engine process; the next call starts it again."] = False,
    ) -> Playback:
        """Stop the sound."""
        answer = self._engine.request("stop")
        self._playing = ""
        if shutdown:
            self._engine.shutdown()
        return _playback(answer)

    def status(self) -> Playback:
        """What plays now: the layers, the cycle and the warnings."""
        answer = self._engine.request("status")
        return _playback(answer, self._playing if answer.get("playing") else "")

    def events(
        self,
        track: Track,
        *,
        layers: LayerNames = (),
        begin: Annotated[float, "First cycle."] = 0,
        end: Annotated[float, "Cycle after the last one."] = 1,
        limit: Annotated[int, "Most notes to return."] = 200,
    ) -> Events:
        """The notes that a track plays from cycle `begin` to `end`, to read a
        pattern without listening."""
        code, _ = self._source(track)
        answer = self._engine.request(
            "events", code=code, layers=string_list(layers), begin=begin, end=end, limit=int(limit)
        )
        return Events(
            cps=answer["cps"],
            layers=tuple(answer.get("layers") or ()),
            total=int(answer.get("total") or 0),
            events=tuple(
                Event(row.get("layer"), row["cycle"], row["time"], row["duration"], dict(row.get("value") or {}))
                for row in answer.get("events") or ()
            ),
            warnings=tuple(answer.get("warnings") or ()),
        )

    def export(
        self,
        track: Track,
        out: Annotated[str, f"Audio file to write: {', '.join(audio.FORMATS)}."],
        *,
        layers: LayerNames = (),
        cycles: Annotated[float, "Cycles to render; 0 uses seconds, else 8 cycles."] = 0,
        seconds: Annotated[float, "Seconds to render, when cycles is 0."] = 0,
        tail: Annotated[float, "Seconds after the last cycle, for releases and reverb."] = 2,
        stems: Annotated[bool, "Write one file for each layer, named `<out>.<layer>.<ext>`."] = False,
        bitrate: Annotated[int, "Kilobits per second for MP3, Ogg, Opus and AAC."] = 192,
    ) -> Export:
        """Render a track offline, faster than real time, to an audio file.

        Samples download once into the cache. MP3 needs lameenc or ffmpeg; FLAC,
        Ogg, Opus and AAC need ffmpeg.
        """
        code, source = self._source(track)
        target = self._path(out)
        audio.check_format(target)
        work = cache_dir() / "renders" / uuid.uuid4().hex
        work.mkdir(parents=True, exist_ok=True)
        try:
            answer = self._engine.request(
                "render",
                timeout_s=1800,
                code=code,
                out=str(work / "track.wav"),
                layers=string_list(layers),
                cycles=float(cycles or 0),
                seconds=float(seconds or 0),
                tail=float(tail),
                stems=bool(stems),
            )
            written = []
            for row in answer["files"]:
                name = (
                    target
                    if row.get("layer") is None
                    else target.with_name(f"{target.stem}.{Path(row['path']).stem.split('.', 1)[1]}{target.suffix}")
                )
                audio.encode(row["path"], name, bitrate)
                written.append(
                    AudioFile(
                        path=str(name),
                        layer=row.get("layer"),
                        seconds=round(float(row["seconds"]), 3),
                        events=int(row.get("events") or 0),
                        peak=round(float(row.get("peak") or 0), 4),
                        rms=round(float(row.get("rms") or 0), 4),
                        size_bytes=name.stat().st_size,
                        attachment_id=self._attached(name),
                    )
                )
        finally:
            shutil.rmtree(work, ignore_errors=True)
        return Export(source, answer["cps"], answer["cycles"], tuple(written), tuple(answer.get("warnings") or ()))

    def _attached(self, path):
        """Attach `path` for the person to play in Vis; empty when that fails."""
        if self._attach is None:
            return ""
        try:
            return _attachment_id(self._attach(str(path), audience="user"))
        except Exception:  # noqa: BLE001 - a missing player never fails an export
            return ""

    def sounds(
        self,
        filter: Annotated[str, "Regular expression on the sound name, such as `bd|sd` or `piano`."] = "",
        *,
        refresh: Annotated[bool, "Download the sample maps again."] = False,
        limit: Annotated[int, "Most names to return."] = 300,
    ) -> SoundList:
        """Sounds a track can name with `s`, as `name:files`, and the drum
        machine banks for `.bank(...)`.

        superdough, the engine of strudel.cc, plays every synth, effect,
        soundfont (`gm_*`) and ZZFX sound.
        """
        answer = self._engine.request("sounds", timeout_s=300, filter=filter, refresh=bool(refresh), limit=int(limit))
        return SoundList(
            total=int(answer.get("total") or 0),
            sounds=tuple(
                f"{row['name']}:{'pitched' if row.get('pitched') else row.get('files')}"
                for row in answer.get("sounds") or ()
            ),
            banks=tuple(answer.get("banks") or ()),
            synths=tuple(answer.get("synths") or ()),
            errors=tuple(str(e) for e in answer.get("errors") or ()),
        )
