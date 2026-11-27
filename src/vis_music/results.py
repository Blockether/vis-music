"""The frozen results every vis-music tool returns."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Annotated

SHOWN_WARNINGS = 5
"""Warnings that a printed result shows."""

SHOWN_EVENTS = 40
"""Notes that a printed `Events` shows."""

SHOWN_NAMES = 60
"""Sound or bank names that a printed `SoundList` shows."""


def _capped(rows, limit, field):
    """The first `limit` rows, then one row that names the field with all of them."""
    rows = list(rows)
    if len(rows) <= limit:
        return rows
    return rows[:limit] + [f"+{len(rows) - limit} more (read .{field})"]


def _warning_rows(warnings, field="warnings", label="Warning"):
    return _capped((f"{label}: {text}" for text in warnings), SHOWN_WARNINGS, field)


def _names(label, names, field):
    return f"{label}: {', '.join(_capped(names, SHOWN_NAMES, field))}"


def size_text(count):
    """A file size for a person: kB below one megabyte, else MB."""
    return f"{count / 1_000_000:.1f} MB" if count >= 1_000_000 else f"{count / 1000:.0f} kB"


@dataclass(frozen=True)
class Layer:
    """One named part of a track, such as `drums:` or `$:`."""

    name: Annotated[str, "Label of the layer; `$0`, `$1` for unnamed `$:` blocks."]
    is_muted: Annotated[bool, "The label starts or ends with `_`."] = False
    is_solo: Annotated[bool, "The label starts with `S`."] = False
    is_playing: Annotated[bool, "The engine plays this layer now."] = False

    def __str__(self):
        marks = [mark for mark, on in (("muted", self.is_muted), ("solo", self.is_solo)) if on]
        return f"{self.name} ({', '.join(marks)})" if marks else self.name


@dataclass(frozen=True)
class TrackInfo:
    """What a track contains, after it compiled."""

    source: Annotated[str, "Track file, or `code` for code given inline."]
    cps: Annotated[float, "Cycles per second."]
    layers: Annotated[tuple[Layer, ...], "Layers in the order of the code."]
    events_in_4_cycles: Annotated[int, "Notes that the first four cycles play."]
    warnings: Annotated[tuple[str, ...], "Sounds that are unknown or cannot play."] = ()
    is_saved: Annotated[bool, "The call wrote the track file."] = False

    def __str__(self):
        where = "inline code" if self.source == "code" else self.source
        saved = ", saved" if self.is_saved else ""
        rows = [
            f"Track {where}: {self.cps:.3g} cps, {self.events_in_4_cycles} notes in 4 cycles{saved}",
            f"Layers: {', '.join(str(layer) for layer in self.layers) or 'none'}",
        ]
        return "\n".join(rows + _warning_rows(self.warnings))


@dataclass(frozen=True)
class Playback:
    """What the engine plays."""

    is_playing: bool
    cycle: Annotated[float | None, "Current cycle, or None when silent."]
    cps: Annotated[float | None, "Cycles per second of the playing track."]
    layers: tuple[Layer, ...]
    events_sent: Annotated[int, "Notes sent to the synthesizer since play."] = 0
    output: Annotated[str, "Audio backend that plays, such as Core Audio; empty when silent."] = ""
    warnings: tuple[str, ...] = ()
    source: Annotated[str, "Track file or `code`; empty when unknown."] = ""
    is_changed: Annotated[bool, "The call replaced a playing track without a gap."] = False

    def __str__(self):
        if not self.is_playing:
            return "\n".join(["Silent"] + _warning_rows(self.warnings))
        playing = ", ".join(layer.name for layer in self.layers if layer.is_playing) or "no layers"
        head = f"Playing {playing}: {self.cps:.3g} cps, cycle {self.cycle:.1f}"
        if self.output:
            head += f", on {self.output}"
        if self.is_changed:
            head += ", replaced without a gap"
        return "\n".join([head] + _warning_rows(self.warnings))


@dataclass(frozen=True)
class Event:
    """One note of a track."""

    layer: str | None
    cycle: float
    time: Annotated[float, "Seconds from the start."]
    duration: Annotated[float, "Seconds the note sounds."]
    value: Annotated[dict, "Controls of the note, such as s, note, gain."] = field(default_factory=dict)

    def __str__(self):
        controls = " ".join(f"{name}={value}" for name, value in self.value.items())
        return f"{self.cycle:g} {self.layer or '-'} {controls}".rstrip()


@dataclass(frozen=True)
class Events:
    """The notes of a time span of a track."""

    cps: float
    layers: tuple[str, ...]
    total: Annotated[int, "Notes in the span; `events` holds at most `limit`."]
    events: tuple[Event, ...]
    warnings: tuple[str, ...] = ()

    def __str__(self):
        held = "" if self.total == len(self.events) else f", {len(self.events)} in .events"
        rows = [
            f"{self.total} notes{held} at {self.cps:.3g} cps, layers: {', '.join(self.layers) or 'none'}",
            "cycle layer controls",
        ]
        rows += _capped((str(event) for event in self.events), SHOWN_EVENTS, "events")
        return "\n".join(rows + _warning_rows(self.warnings))


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

    def __str__(self):
        clip = ", can clip: lower the gain" if self.peak >= 0.99 else ""
        return (
            f"{self.path}: {self.layer or 'mix'}, {self.seconds:.1f} s, {self.events} notes,"
            f" peak {self.peak:.2f}{clip}, {size_text(self.size_bytes)}"
        )


@dataclass(frozen=True)
class Export:
    """The audio files of one export."""

    source: str
    cps: float
    cycles: float
    files: tuple[AudioFile, ...]
    warnings: tuple[str, ...] = ()

    def __str__(self):
        where = "inline code" if self.source == "code" else self.source
        files = "1 file" if len(self.files) == 1 else f"{len(self.files)} files"
        rows = [f"Exported {files} from {where}: {self.cycles:g} cycles at {self.cps:.3g} cps"]
        rows += [str(file) for file in self.files]
        return "\n".join(rows + _warning_rows(self.warnings))


@dataclass(frozen=True)
class SoundList:
    """Sounds that tracks can name with `s`."""

    total: int
    sounds: tuple[str, ...]
    banks: tuple[str, ...]
    synths: Annotated[tuple[str, ...], "Built-in oscillators, which need no samples."] = ()
    errors: tuple[str, ...] = ()

    def __str__(self):
        rows = [f"{self.total} sounds, {len(self.banks)} banks, {len(self.synths)} synths"]
        rows += [
            _names(label, names, field)
            for label, names, field in (
                ("Sounds", self.sounds, "sounds"),
                ("Banks", self.banks, "banks"),
                ("Synths", self.synths, "synths"),
            )
            if names
        ]
        return "\n".join(rows + _warning_rows(self.errors, "errors", "Error"))
