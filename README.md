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

- **Sound engine.** superdough, the Web Audio engine of strudel.cc, plays the
  sound on [node-web-audio-api](https://github.com/ircam-ismm/node-web-audio-api).
  All its synths, effects, samples, soundfonts (`gm_*`), ZZFX and `loopAt`/`fit`
  play as on strudel.cc. A sound or chord that Strudel does not know gives a
  warning in `music.check`.
- **Not yet available.** The visual methods (`pianoroll`, `punchcard`, `scope`
  and others) draw nothing. `.midi()`, OSC and the microphone do not play.
- **Live playback.** It needs an audio output device. A changed track takes over
  on time; the engine sends notes 0.25 s ahead, so a change is heard after about
  that delay. One track plays at a time.
- **First use.** The first use downloads the node-web-audio-api binary for this
  platform (checked against its SHA-512) and the samples of each new sound. After
  that they come from the cache, also offline.
- **Linux.** The node-web-audio-api binary needs `libasound2`, `libdbus-1-3` and
  `libpipewire-0.3-0`, also for export. Without them the engine says which
  library is missing.
- **Size.** An export renders about 5 times faster than real time. The render
  stays in memory until it is written: about 21 MB for each minute of audio. One
  render or live session plays at most 128 notes at the same time.

## How it works

- `src/vis_music/engine/engine.mjs` is one Node process (bundled from `js/`). It
  compiles Strudel code, schedules the notes on superdough and loads samples into
  a disk cache (`~/.cache/vis-music`, or `$VIS_MUSIC_CACHE`).
- Live playback uses one `AudioContext` on the default output device. Each export
  renders in a new Node process on an `OfflineAudioContext`; stems render in
  parallel.
- The engine is a kept runtime: the sound goes on across sandbox restarts.

## Development

```bash
uv sync
uv run pytest                     # offline: synths and a generated sample
python scripts/build.py           # after a change in js/
vis-agent extension install . --trust --global --save
```

On a machine without an audio device, `music.play` fails with a clear error and
`music.export` still works. Set `VIS_MUSIC_NO_AUDIO=1` there: the tests then
check that error instead of live playback.

## License

AGPL-3.0-or-later. See `LICENSE` and `NOTICE.md`.
