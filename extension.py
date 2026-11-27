"""Vis entrypoint. The tools themselves live in vis_music."""

import inspect
import os

import blockether.vis.extension as vis
from vis_lang_interface import presentation

from vis_music.engine import cache_dir
from vis_music.tools import MusicTools

VERSION = "0.1.0"
MAX_ROWS = 40


def _layer_rows(layers):
    def state(layer):
        marks = [
            m for m, on in (("playing", layer.is_playing), ("solo", layer.is_solo), ("muted", layer.is_muted)) if on
        ]
        return ", ".join(marks) or "-"

    return vis.ActivityTable(("Layer", "State"), tuple((layer.name, state(layer)) for layer in layers))


def _warnings(warnings):
    if not warnings:
        return ()
    shown = "\n".join(f"- {w}" for w in warnings[:MAX_ROWS])
    return (vis.ActivitySection("Warnings", f"{len(warnings)} warning(s)", (vis.ActivityMarkdown(shown),)),)


def _names(layers):
    return ", ".join(layer.name for layer in layers) or "no layers"


def _track(label, info):
    where = os.path.basename(info.source) if info.source != "code" else "inline code"
    summary = f"{where} · {len(info.layers)} layers · {info.cps:.3g} cps · {info.events_in_4_cycles} notes in 4 cycles"
    return vis.ActivityPresentation(
        label, summary, (_layer_rows(info.layers),), _warnings(info.warnings), outcome=_names(info.layers)
    )


def _playback(label, playback):
    if not playback.is_playing:
        return vis.ActivityPresentation(label, "silent", outcome="silent")
    playing = [layer for layer in playback.layers if layer.is_playing]
    summary = f"playing {_names(playing)} · {playback.cps:.3g} cps · cycle {playback.cycle:.1f}"
    if playback.is_changed:
        summary += " · replaced without a gap"
    return vis.ActivityPresentation(
        label,
        summary,
        (_layer_rows(playback.layers),),
        _warnings(playback.warnings),
        outcome=f"playing {_names(playing)}",
    )


def _events(label, result):
    rows = tuple(
        (e.layer or "", f"{e.cycle:g}", f"{e.time:.3f}", " ".join(f"{k}={v}" for k, v in e.value.items()))
        for e in result.events[:MAX_ROWS]
    )
    summary = f"{result.total} notes · layers {', '.join(result.layers) or 'none'}"
    return vis.ActivityPresentation(
        label, summary, (vis.ActivityTable(("Layer", "Cycle", "Second", "Value"), rows),), _warnings(result.warnings)
    )


def _size(count):
    return f"{count / 1_000_000:.1f} MB" if count >= 1_000_000 else f"{count / 1000:.0f} kB"


def _export(label, result):
    content = []
    for f in result.files:
        name = os.path.basename(f.path)
        if f.attachment_id:
            content.append(vis.ActivityAudio(f.attachment_id, name))
    content.append(
        vis.ActivityTable(
            ("File", "Layer", "Seconds", "Peak", "RMS", "Size"),
            tuple(
                (
                    os.path.basename(f.path),
                    f.layer or "mix",
                    f"{f.seconds:.1f}",
                    f"{f.peak:.2f}",
                    f"{f.rms:.3f}",
                    _size(f.size_bytes),
                )
                for f in result.files
            ),
            tuple(f.path for f in result.files),
        )
    )
    first = result.files[0]
    summary = f"{len(result.files)} file(s) · {first.seconds:.1f} s · {result.cycles:g} cycles"
    if any(f.peak >= 0.99 for f in result.files):
        summary += " · peak at 1.0: lower the gain"
    return vis.ActivityPresentation(
        label, summary, tuple(content), _warnings(result.warnings), outcome=os.path.basename(first.path)
    )


def _sounds(label, result):
    text = ", ".join(result.sounds[:200])
    sections = [
        vis.ActivitySection("Banks", f"{len(result.banks)} banks", (vis.ActivityText(", ".join(result.banks)),))
    ]
    return vis.ActivityPresentation(
        label,
        f"{result.total} sounds · {len(result.synths)} synths · {len(result.banks)} banks",
        (vis.ActivityText(text or "no match"),),
        tuple(sections) + _warnings(result.errors),
    )


def _bind(name, label, build, *, tag="observation", show_start=True, code=False):
    """Attach one Activity presentation to a method of MusicTools."""
    setattr(
        MusicTools,
        name,
        vis.method(
            tag=tag,
            activity=presentation.activity(
                label,
                lambda result: build(label, result),
                show_start=show_start,
                describe=presentation.code_argument("javascript") if code else None,
            ),
        )(getattr(MusicTools, name)),
    )


_bind("check", "Check track", _track, code=True)
_bind("save", "Save track", _track, tag="mutation")
_bind("play", "Play track", _playback, tag="mutation", code=True)
_bind("stop", "Stop music", _playback, tag="mutation", show_start=False)
_bind("status", "Music status", _playback, show_start=False)
_bind("events", "Track notes", _events, code=True)
_bind("export", "Export track", _export, tag="mutation")
_bind("sounds", "List sounds", _sounds, show_start=False)

VERBS = ("check", "save", "play", "stop", "status", "events", "export", "sounds")


def _signature(verb):
    shown = inspect.signature(getattr(MusicTools, verb))
    params = []
    for p in list(shown.parameters.values())[1:]:
        text = p.name if p.default is inspect.Parameter.empty else f"{p.name}={p.default!r}"
        if p.kind is inspect.Parameter.KEYWORD_ONLY and "*" not in params:
            params.append("*")
        params.append(text)
    returned = shown.return_annotation
    returned = returned if isinstance(returned, str) else getattr(returned, "__name__", "")
    return f"  music.{verb}({', '.join(params)}) -> {returned}"


PROMPT = "\n".join(
    [
        "music surface active — compose, play and export music. A track is Strudel code; each tool takes a track file path or the code:",
        *(_signature(verb) for verb in VERBS),
        'Write a track as named layers, one pattern each: `setcpm(120/4)`, then `drums: s("bd*4, [~ sd]*2, hh*8").bank("RolandTR909")`,'
        ' `bass: note("c2 [~ c2] eb2 g1").s("sawtooth").lpf(800)`. A label that starts or ends with `_` is muted; one that starts with `S` plays solo.',
        "Run `music.check` after each change; it names unknown sounds. `music.save` writes a `.strudel` file only when the track compiles.",
        "`music.play` returns at once and the sound goes on until `music.stop()`. Play again after a change: the new code takes over without a gap."
        " Pass `layers=[...]` to hear some layers alone.",
        '`music.export(track, "out/song.mp3")` renders offline to wav, mp3, flac, ogg, opus or m4a; `stems=True` writes one file for each layer.'
        " Vis shows a player for each exported file.",
        '`music.sounds("piano|bd")` lists sample names and drum machine banks; `sawtooth`, `square`, `triangle` and `sine` are synths that need no samples.',
    ]
)

_cache = cache_dir()
_cache.mkdir(parents=True, exist_ok=True)

vis.register_extension(
    vis.Extension(
        name="vis-music",
        description="Compose music as Strudel code, play it live layer by layer, and export WAV, MP3 or stems.",
        version=VERSION,
        alias="music",
        symbols=[vis.Symbol(MusicTools(workspace_root=vis.workspace_root, attach=vis.attach), name="music")],
        prompt=PROMPT,
        grants=[vis.Grant(_cache, reason="Keep downloaded samples and renders.")],
    )
)
