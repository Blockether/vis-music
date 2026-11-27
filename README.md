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

## Examples

`examples/` has six tracks. Play one with `music.play("examples/house.strudel")`.

| Track | Style | Layers |
| --- | --- | --- |
| `acid.strudel` | Acid techno, 128 BPM | TR-909 drums, sawtooth bass under a moving filter, square stabs |
| `house.strudel` | Classic house, 124 BPM | TR-909 drums, organ chords, sawtooth bass |
| `lofi.strudel` | Lo-fi hip hop, 78 BPM | TR-808 drums, piano chords, triangle bass, vibraphone |
| `jazz.strudel` | Jazz waltz | rim and hi-hat, walking bass, piano comping, saxophone |
| `ambient.strudel` | Ambient, 60 BPM | sine pads, kalimba arpeggio, triangle shimmer |
| `chiptune.strudel` | 8-bit, 150 BPM | square lead, pulse bass, noise hats, triangle kick |
| `techno.strudel` | Minimal techno, 130 BPM | Euclidean 909 rhythms, `jux(rev)` hats, FM bells with delay, sine sub |
| `breakbeat.strudel` | Breakbeat, 170 BPM | amen break slices from Dirt-Samples, detuned reese bass, pads |
| `synthwave.strudel` | Synthwave, 100 BPM | LinnDrum, octave bass, gated chords with chorus, lead with `off` echoes |
| `song.strudel` | A song in sections, 122 BPM | `arrange()` of intro, verse, drop and outro over 16 bars |

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

## Limitations

- **Sound engine.** dough, the synthesizer of Strudel, plays the sound, not the
  Web Audio engine of strudel.cc. A track sounds close to strudel.cc, not the
  same. dough does not play `vowel`, `shape`, `cut`, `squiz`, `size`/`dry`,
  `detune`, `compressor`, `duckorbit` or `unit` (so `loopAt` and `fit` do not
  fit the sample to the cycle). `supersaw` plays as `sawtooth`. `music.check`
  warns about each control that does not play.
- **Sounds.** The sample maps of strudel.cc load: drum machines, piano, VCSL
  instruments and the Dirt subset, plus any map that `samples(...)` names. The
  General MIDI soundfonts (`gm_*`) are not available.
- **Visuals and outputs.** `pianoroll`, `punchcard`, `scope` and the other
  visual methods draw nothing. `.midi()`, OSC and the microphone are not
  available.
- **Live playback.** It needs an audio output device. A changed track takes over
  on time; the engine sends notes 0.25 s ahead, so a change is heard after about
  that delay. One track plays at a time.
- **First use.** Samples download on first use, so the first play or export of
  a new sound takes longer. After that they come from the cache, also offline.
- **Size.** An export streams to its file, so its length has no limit; it renders
  about 6 times faster than real time (6 minutes in about 1 minute). One render
  or live session holds at most 4096 different sample files, about 200 MB of
  decoded samples, and 128 notes that sound at the same time.

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

On a machine without an audio device, `music.play` fails with a clear error and
`music.export` still works. Set `VIS_MUSIC_NO_AUDIO=1` there: the tests then
check that error instead of live playback.

## License

AGPL-3.0-or-later. See `LICENSE` and `NOTICE.md`.
