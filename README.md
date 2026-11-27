# vis-music

Compose music in [Vis](https://vis.blockether.com) as Strudel code. Play it live,
layer by layer, and export WAV, MP3, FLAC, Ogg, Opus or AAC, as a mix or as one
stem for each layer.

```python
song = """setcpm(124/4)
drums: s("bd*4, [~ cp]*2, hh*8").bank("RolandTR909")
bass: note("<c2 c2 eb2 g1>*4").s("sawtooth").lpf(sine.range(400, 1600).slow(4)).gain(.5)
keys: n("<0 2 4 6>").scale("C:minor").s("piano").room(.4)
"""
music.save("songs/acid", song)                         # songs/acid.strudel, only when it compiles
music.play("songs/acid.strudel")                       # live, returns at once
music.play("songs/acid.strudel", layers=["bass"])      # the bass alone, without a gap
music.stop()
music.export("songs/acid.strudel", "out/acid.mp3", cycles=16)
music.export("songs/acid.strudel", "out/acid.wav", stems=True)  # acid.drums.wav, ...
```

## Tools

| Tool | Does |
| --- | --- |
| `music.check(track)` | Compiles the track; lists layers, tempo and unknown sounds. |
| `music.save(path, code)` | Checks, then writes a `.strudel` file. |
| `music.play(track, layers=(), cps=0)` | Plays live until `music.stop()`; a new play replaces the old one on time. |
| `music.stop(shutdown=False)` / `music.status()` | Stops the sound / tells what plays. |
| `music.events(track, begin, end)` | The notes of a span, to read a pattern without listening. |
| `music.export(track, out, cycles, seconds, stems)` | Renders offline, faster than real time. Vis shows a player. |
| `music.sounds(filter)` | Sample names, drum machine banks and synths. |

A track is a file path or the code itself. Layers are Strudel labels: `drums:`
or `$:`. A label that starts or ends with `_` is muted; one that starts with `S`
plays solo.

## How it works

- `src/vis_music/engine/engine.mjs` is one Node process (bundled from `js/`). It
  compiles Strudel code, schedules the notes and loads samples into a disk cache
  (`~/.cache/vis-music`, or `$VIS_MUSIC_CACHE`).
- `doughbox` is a small C program over dough, the synthesizer of Strudel, and
  miniaudio. It plays to the speakers and renders WAV files offline. Prebuilt
  binaries for macOS (arm64, x64), Linux (x64, arm64) and Windows (x64) are in
  `src/vis_music/native/`; on another platform it builds once with `cc`.
- The engine is a kept runtime: the sound goes on across sandbox restarts.

## Development

```bash
uv sync
uv run pytest                     # offline: synths and a generated sample
python scripts/build.py engine    # after a change in js/
python scripts/build.py native    # macOS cc; Zig for Linux and Windows
vis-agent extension install . --trust --global --save
```

Set `VIS_MUSIC_NO_AUDIO=1` to skip the live playback test on a machine without
an audio device.

## License

AGPL-3.0-or-later. See `LICENSE` and `NOTICE.md`.
