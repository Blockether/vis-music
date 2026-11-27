// Sound names: the sample maps of strudel.cc, extra maps that code adds with
// samples(...), and a disk cache for the sample files.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteToMidi } from '@strudel/core';

const CDN = 'https://strudel.b-cdn.net';

// The default maps of strudel.cc (website/src/repl/prebake.mjs).
export const DEFAULT_MAPS = [
  { url: `${CDN}/tidal-drum-machines.json`, base: `${CDN}/tidal-drum-machines/machines/` },
  { url: `${CDN}/uzu-drumkit.json`, base: `${CDN}/uzu-drumkit/` },
  { url: `${CDN}/piano.json`, base: `${CDN}/piano/` },
  { url: `${CDN}/vcsl.json`, base: `${CDN}/VCSL/` },
  { url: `${CDN}/mridangam.json`, base: `${CDN}/mrid/` },
];
export const DEFAULT_ALIASES = `${CDN}/tidal-drum-machines-alias.json`;

const numbered = (name, files) => files.map((f) => `${name}/${f}.wav`);
const range = (n, pad = 3, names = []) => [...Array(n)].map((_, i) => `${String(i).padStart(pad, '0')}${names[i] ? '_' + names[i] : ''}`);
export const DIRT_SUBSET = {
  casio: numbered('casio', ['high', 'low', 'noise']),
  crow: numbered('crow', ['000_crow', '001_crow2', '002_crow3', '003_crow4']),
  insect: numbered('insect', ['000_everglades_conehead', '001_robust_shieldback', '002_seashore_meadow_katydid']),
  wind: numbered('wind', ['000_wind1', '001_wind10', '002_wind2', '003_wind3', '004_wind4', '005_wind5', '006_wind6', '007_wind7', '008_wind8', '009_wind9']),
  jazz: numbered('jazz', ['000_BD', '001_CB', '002_FX', '003_HH', '004_OH', '005_P1', '006_P2', '007_SN']),
  metal: numbered('metal', range(10, 3, ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'])),
  east: numbered('east', ['000_nipon_wood_block', '001_ohkawa_mute', '002_ohkawa_open', '003_shime_hi', '004_shime_hi_2', '005_shime_mute', '006_taiko_1', '007_taiko_2', '008_taiko_3']),
  space: numbered('space', range(18, 3, ['0', '1', '11', '12', '13', '14', '15', '16', '17', '18', '2', '3', '4', '5', '6', '7', '8', '9'])),
  numbers: numbered('numbers', ['0', '1', '2', '3', '4', '5', '6', '7', '8']),
  num: numbered('num', range(21, 2)),
};
export const DIRT_BASE = `${CDN}/Dirt-Samples/`;

// Oscillators that dough plays itself, with the Strudel names that map to them.
export const SYNTHS = {
  sine: 'sine', sawtooth: 'saw', saw: 'saw', square: 'square', pulse: 'pulse', triangle: 'triangle', tri: 'triangle',
  white: 'white', pink: 'pink', brown: 'brown', zawtooth: 'zaw', zaw: 'zaw', supersaw: 'saw',
};

const midiOf = (key) => {
  const m = String(key).match(/^([a-gA-G])(s|#|b|f)?(-?\d+)$/);
  if (!m) return NaN;
  const acc = m[2] === 's' ? '#' : m[2] === 'f' ? 'b' : m[2] || '';
  return noteToMidi(`${m[1].toLowerCase()}${acc}${m[3]}`);
};

const joinUrl = (base, path) => (/^[a-z]+:\/\//i.test(path) || path.startsWith('/') ? path : base + path);

function githubUrl(spec) {
  // github:owner/repo[/branch[/path]] -> its strudel.json
  const [owner, repo, branch = 'main', ...rest] = spec.slice('github:'.length).split('/');
  const dir = [owner, repo, branch, ...rest].filter(Boolean).join('/');
  return `https://raw.githubusercontent.com/${dir}/strudel.json`;
}

export class Sounds {
  constructor(cacheDir, { offline = false } = {}) {
    this.cacheDir = cacheDir;
    this.offline = offline; // no remote default maps, for tests
    this.index = new Map(); // lower-case name -> { files: [url] } | { pitched: [{ midi, url }] }
    this.banks = new Set();
    this.loadedMaps = new Set();
    this.ready = null;
    mkdirSync(join(cacheDir, 'files'), { recursive: true });
    mkdirSync(join(cacheDir, 'maps'), { recursive: true });
  }

  // Loads the default maps once. A map that fails to load is reported, not fatal.
  defaults(refresh = false) {
    if (!this.ready || refresh) {
      this.ready = (async () => {
        const errors = [];
        if (this.offline) return errors;
        const aliases = await this.fetchJson(DEFAULT_ALIASES, refresh).catch((e) => (errors.push(String(e.message || e)), {}));
        for (const map of DEFAULT_MAPS) {
          try {
            this.addMap(await this.fetchJson(map.url, refresh), map.base, aliases);
          } catch (e) {
            errors.push(`${map.url}: ${e.message || e}`);
          }
        }
        this.addMap(DIRT_SUBSET, DIRT_BASE);
        return errors;
      })();
    }
    return this.ready;
  }

  // Adds the map that code names with samples(map | url, base).
  async addFromCode(spec, base) {
    if (typeof spec === 'string') {
      const url = spec.startsWith('github:') ? githubUrl(spec) : spec;
      if (this.loadedMaps.has(url)) return;
      const json = await this.fetchJson(url, false);
      const root = base || json._base || url.slice(0, url.lastIndexOf('/') + 1);
      this.addMap(json, root);
      this.loadedMaps.add(url);
    } else if (spec && typeof spec === 'object') {
      this.addMap(spec, base || spec._base || '');
    }
  }

  addMap(map, base, aliases = {}) {
    const root = map._base || base || '';
    for (const [name, value] of Object.entries(map)) {
      if (name.startsWith('_')) continue;
      let entry;
      if (typeof value === 'string') entry = { files: [joinUrl(root, value)] };
      else if (Array.isArray(value)) entry = { files: value.map((v) => joinUrl(root, v)) };
      else if (value && typeof value === 'object') {
        const pitched = Object.entries(value)
          .map(([k, v]) => ({ midi: midiOf(k), url: joinUrl(root, Array.isArray(v) ? v[0] : v) }))
          .filter((p) => !Number.isNaN(p.midi))
          .sort((a, b) => a.midi - b.midi);
        if (!pitched.length) continue;
        entry = { pitched };
      } else continue;
      const lower = name.toLowerCase();
      this.index.set(lower, entry);
      const cut = name.indexOf('_');
      if (cut > 0) {
        const bank = name.slice(0, cut);
        const alias = aliases[bank];
        this.banks.add(bank.toLowerCase());
        if (alias) {
          this.banks.add(alias.toLowerCase());
          this.index.set(`${alias}_${name.slice(cut + 1)}`.toLowerCase(), entry);
        }
      }
    }
  }

  // The file for one event, or null for an unknown name. `freq` is the pitch at
  // which the file plays unchanged: its own note, or C2 like superdough.
  resolve(s, bank, n, note) {
    const key = (bank ? `${bank}_${s}` : String(s)).toLowerCase();
    const entry = this.index.get(key);
    if (!entry) return null;
    if (entry.files) {
      const i = ((Math.floor(Number(n) || 0) % entry.files.length) + entry.files.length) % entry.files.length;
      return { url: entry.files[i], midi: 36 };
    }
    const target = typeof note === 'number' ? note : 60;
    let best = entry.pitched[0];
    for (const p of entry.pitched) if (Math.abs(p.midi - target) < Math.abs(best.midi - target)) best = p;
    return { url: best.url, midi: best.midi };
  }

  names(filter = '') {
    const re = filter ? new RegExp(filter, 'i') : null;
    const rows = [];
    for (const [name, entry] of this.index) {
      if (re && !re.test(name)) continue;
      rows.push({ name, files: entry.files ? entry.files.length : entry.pitched.length, pitched: !!entry.pitched });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  cachePath(url) {
    const ext = (extname(new URL(url, 'file:///').pathname) || '.wav').slice(0, 8);
    return join(this.cacheDir, 'files', createHash('sha256').update(url).digest('hex').slice(0, 32) + ext);
  }

  // The local path of a sample file, downloaded once. The write is atomic, so an
  // interrupted download leaves no partial file.
  async file(url) {
    if (url.startsWith('file://') || url.startsWith('/')) {
      const path = url.startsWith('file://') ? fileURLToPath(url) : url;
      if (!existsSync(path)) throw new Error(`missing sample file ${path}`);
      return path;
    }
    const path = this.cachePath(url);
    if (existsSync(path)) return path;
    const res = await fetch(encodeURI(decodeURI(url)));
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const tmp = `${path}.${process.pid}.part`;
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
    renameSync(tmp, path);
    return path;
  }

  async fetchJson(url, refresh) {
    if (url.startsWith('file://') || url.startsWith('/')) {
      return JSON.parse(readFileSync(url.startsWith('file://') ? fileURLToPath(url) : url, 'utf8'));
    }
    const path = join(this.cacheDir, 'maps', createHash('sha256').update(url).digest('hex').slice(0, 32) + '.json');
    if (!refresh && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      const text = await res.text();
      const json = JSON.parse(text);
      const tmp = `${path}.${process.pid}.part`;
      writeFileSync(tmp, text);
      renameSync(tmp, path);
      return json;
    } catch (e) {
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
      throw e;
    }
  }
}
