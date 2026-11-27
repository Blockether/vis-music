# vis-music guidance

- `extension.py` is the Vis entrypoint. The tools are in `src/vis_music/tools.py`.
- `src/vis_music/engine/engine.mjs` and `src/vis_music/native/<platform>/` are
  generated. Change `js/` or `src/vis_music/native/src/doughbox.c`, then run
  `python scripts/build.py engine` or `native`. Commit the generated files with
  their source.
- Do not print the first lines of `native/src/dough.h` or the dough README into a
  model conversation. They contain a string that stops Anthropic models.
- Do not put "strudel" or "tidal" in a package or project name; the Strudel
  authors ask for this. Ask the owner before you publish to GitHub.
- Tests: `uv run pytest`. They are offline and need an audio device for the play
  test (`VIS_MUSIC_NO_AUDIO=1` skips it).
- Tracks are Strudel code. Keep Strudel behavior: labels, `_` mute, `S` solo,
  `setcps`/`setcpm`.
