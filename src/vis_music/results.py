"""The frozen results every vis-music tool returns."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Annotated


@dataclass(frozen=True)
class Layer:
    """One named part of a track, such as `drums:` or `$:`."""

    name: Annotated[str, "Label of the layer; `$0`, `$1` for unnamed `$:` blocks."]
    is_muted: Annotated[bool, "The label starts or ends with `_`."] = False
    is_solo: Annotated[bool, "The label starts with `S`."] = False
    is_playing: Annotated[bool, "The engine plays this layer now."] = False


@dataclass(frozen=True)
class TrackInfo:
    """What a track contains, after it compiled."""

    source: Annotated[str, "Track file, or `code` for code given inline."]
    cps: Annotated[float, "Cycles per second."]
    layers: Annotated[tuple[Layer, ...], "Layers in the order of the code."]
    events_in_4_cycles: Annotated[int, "Notes that the first four cycles play."]
    warnings: Annotated[tuple[str, ...], "Sounds that are unknown or cannot play."] = ()
    is_saved: Annotated[bool, "The call wrote the track file."] = False


@dataclass(frozen=True)
class Playback:
    """What the engine plays."""

    is_playing: bool
    cycle: Annotated[float | None, "Current cycle, or None when silent."]
    cps: Annotated[float | None, "Cycles per second of the playing track."]
    layers: tuple[Layer, ...]
    events_sent: Annotated[int, "Notes sent to the synthesizer since play."] = 0
    warnings: tuple[str, ...] = ()
    source: Annotated[str, "Track file or `code`; empty when unknown."] = ""
    is_changed: Annotated[bool, "The call replaced a playing track without a gap."] = False


@dataclass(frozen=True)
class Event:
    """One note of a track."""

    layer: str | None
    cycle: float
    time: Annotated[float, "Seconds from the start."]
    duration: Annotated[float, "Seconds the note sounds."]
    value: Annotated[dict, "Controls of the note, such as s, note, gain."] = field(default_factory=dict)


@dataclass(frozen=True)
class Events:
    """The notes of a time span of a track."""

    cps: float
    layers: tuple[str, ...]
    total: Annotated[int, "Notes in the span; `events` holds at most `limit`."]
    events: tuple[Event, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class AudioFile:
    """One written audio file."""

    path: str
    layer: Annotated[str | None, "The stem's layer, or None for the mix."]
    seconds: float
    events: Annotated[int, "Notes rendered."]
    peak: Annotated[float, "Highest sample, 0 to 1; near 1 can clip."]
    rms: Annotated[float, "Average loudness, 0 to 1."]
    size_bytes: int
    attachment_id: Annotated[str, "Vis attachment that plays the file; empty outside Vis."] = ""


@dataclass(frozen=True)
class Export:
    """The audio files of one export."""

    source: str
    cps: float
    cycles: float
    files: tuple[AudioFile, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class SoundList:
    """Sounds that tracks can name with `s`."""

    total: int
    sounds: tuple[str, ...]
    banks: tuple[str, ...]
    synths: Annotated[tuple[str, ...], "Built-in oscillators, which need no samples."] = ()
    errors: tuple[str, ...] = ()
