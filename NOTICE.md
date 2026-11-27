# Third-party software

vis-music is free software under the GNU Affero General Public License, version 3
or later (see `LICENSE`). It contains or bundles:

| Component | Where | License |
| --- | --- | --- |
| Strudel (`@strudel/core`, `mini`, `transpiler`, `tonal` 1.2.6), https://codeberg.org/uzu/strudel | bundled in `src/vis_music/engine/engine.mjs` | AGPL-3.0-or-later |
| dough (`dough-synth` 0.4.3), the synthesizer of Strudel | `src/vis_music/native/src/dough.h`, built into `doughbox` | AGPL-3.0-or-later (`LICENSE.dough`) |
| miniaudio, https://miniaud.io | `src/vis_music/native/src/libs/miniaudio.h`, built into `doughbox` | Public domain or MIT No Attribution |
| Node.js (`nodejs-wheel-binaries`) | Python dependency | MIT |
| LAME (`lameenc`) | Python dependency | LGPL-2.0-or-later |

The sample files are not part of vis-music. The engine downloads them on first
use from the sample maps of strudel.cc, and from maps that a track names with
`samples(...)`. Each sample pack has its own license.

The source of every bundled component is in this repository: `js/` holds the
engine source and its pinned `package-lock.json`, and `scripts/build.py` builds
the bundle and the native binaries again.
