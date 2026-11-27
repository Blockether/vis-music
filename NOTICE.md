# Third-party software

vis-music is free software under the GNU Affero General Public License, version 3
or later (see `LICENSE`). It contains or bundles:

| Component | Where | License |
| --- | --- | --- |
| Strudel (`@strudel/core`, `mini`, `transpiler`, `tonal` 1.2.6; `@strudel/webaudio`, `@strudel/soundfonts`, `superdough` 1.3.0), https://codeberg.org/uzu/strudel | bundled in `src/vis_music/engine/engine.mjs` | AGPL-3.0-or-later |
| kabelsalat (`@kabelsalat/web` 0.4.1) | bundled in `src/vis_music/engine/engine.mjs` | AGPL-3.0-or-later |
| node-web-audio-api 2.3.0, https://github.com/ircam-ismm/node-web-audio-api | downloaded on first use into the cache | BSD-3-Clause |
| Node.js (`nodejs-wheel-binaries`) | Python dependency | MIT |
| LAME (`lameenc`) | Python dependency | LGPL-2.0-or-later |

The sample files are not part of vis-music. The engine downloads them on first
use from the sample maps of strudel.cc, and from maps that a track names with
`samples(...)`. Each sample pack has its own license.

The source of every bundled component is in this repository: `js/` holds the
engine source and its pinned `package-lock.json`, and `scripts/build.py` builds
the bundle again.
