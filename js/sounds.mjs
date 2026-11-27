// Sound sources: the synths, ZZFX sounds, General MIDI soundfonts and sample
// maps of strudel.cc, played by superdough. Every fetch goes through a disk
// cache, so a sound that loaded once also loads offline.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSoundIndex } from '@strudel/core';
import { aliasBank, getSampleInfo, getSound, loadBuffer, registerSynthSounds, registerZZFXSounds, samples, soundMap } from 'superdough';
import { getFontBufferSource, registerSoundfonts } from '@strudel/soundfonts';

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

// A URL that fetch accepts. Escapes that the map already has, such as %23
// for '#', stay as they are; raw spaces and other raw characters get escaped.
export const encodeUrl = (url) => encodeURI(url).replace(/%25([0-9a-fA-F]{2})/g, '%$1');

const isLocal = (url) => url.startsWith('file://') || url.startsWith('/');
// superdough escapes '#' as %23 in every sample URL; a path keeps its '#'.
const localPath = (url) => (url.startsWith('file://') ? fileURLToPath(url) : url.replace(/%23/g, '#'));
const isMap = (url) => /\.json(\?|$)/i.test(url);

export class Sounds {
  constructor(cacheDir, { offline = false } = {}) {
    this.cacheDir = cacheDir;
    this.offline = offline; // no default maps from strudel.cc, for tests
    this.refreshing = false; // maps come from the network first, while sounds(refresh) runs
    this.ready = null;
    mkdirSync(join(cacheDir, 'files'), { recursive: true });
    mkdirSync(join(cacheDir, 'maps'), { recursive: true });
    const network = globalThis.fetch;
    globalThis.fetch = (input, init) => this.fetch(String(input?.url ?? input), init, network);
  }

  cachePath(url) {
    const hash = createHash('sha256').update(url).digest('hex').slice(0, 32);
    if (isMap(url)) return join(this.cacheDir, 'maps', `${hash}.json`);
    const ext = (extname(new URL(url, 'file:///').pathname) || '.wav').slice(0, 8);
    return join(this.cacheDir, 'files', hash + ext);
  }

  // fetch for superdough: local files, then the cache, then the network. A
  // download is written atomically, so an interrupted one leaves no file.
  async fetch(url, init, network) {
    if (isLocal(url)) {
      const path = localPath(url);
      if (!existsSync(path)) throw new Error(`missing file ${path}`);
      return new Response(readFileSync(path));
    }
    const path = this.cachePath(url);
    const cached = existsSync(path);
    if (cached && !(this.refreshing && isMap(url))) return new Response(readFileSync(path));
    try {
      const res = await network(encodeUrl(url), init);
      if (!res.ok) throw new Error(`${res.status} for ${url}`);
      const body = Buffer.from(await res.arrayBuffer());
      const tmp = `${path}.${process.pid}.part`;
      writeFileSync(tmp, body);
      renameSync(tmp, path);
      return new Response(body);
    } catch (e) {
      if (cached) return new Response(readFileSync(path));
      throw e;
    }
  }

  // Registers the sounds of strudel.cc once. A map that fails to load is
  // reported, not fatal.
  defaults(refresh = false) {
    if (!this.ready || refresh) {
      this.ready = (async () => {
        registerSynthSounds();
        registerZZFXSounds();
        registerSoundfonts();
        const errors = [];
        if (this.offline) return errors;
        this.refreshing = refresh;
        try {
          const loads = DEFAULT_MAPS.map((map) => samples(map.url, map.base, { prebake: true }).catch((e) => errors.push(`${map.url}: ${e.message || e}`)));
          await Promise.all(loads);
          await samples(DIRT_SUBSET, DIRT_BASE, { prebake: true });
          await aliasBank(DEFAULT_ALIASES).catch((e) => errors.push(`${DEFAULT_ALIASES}: ${e.message || e}`));
        } finally {
          this.refreshing = false;
        }
        return errors;
      })();
    }
    return this.ready;
  }

  // The registered sound of one event value, or undefined.
  soundOf(value) {
    const { s, bank } = value || {};
    if (typeof s !== 'string') return undefined;
    return getSound(bank ? `${bank}_${s}` : s);
  }

  // Loads the sample file or soundfont of one event, so that its first onset
  // sounds. Strudel loads on the first onset and skips an onset that is late.
  async preload(value, ac) {
    const sound = this.soundOf(value);
    const data = sound?.data;
    if (!data) return;
    const key = value.bank ? `${value.bank}_${value.s}` : value.s;
    if (data.type === 'sample') {
      const { url, label } = getSampleInfo({ ...value, s: key }, data.samples);
      await loadBuffer(url, ac, label);
    } else if (data.type === 'soundfont') {
      await getFontBufferSource(data.fonts[getSoundIndex(value.n, data.fonts.length)], value, ac);
    }
  }

  names(filter = '') {
    const re = filter ? new RegExp(filter, 'i') : null;
    const rows = [];
    for (const [name, { data = {} }] of Object.entries(soundMap.get())) {
      if (re && !re.test(name)) continue;
      const files = Array.isArray(data.samples) ? data.samples.length : data.samples ? Object.keys(data.samples).length : data.fonts?.length ?? 0;
      rows.push({ name, type: data.type ?? 'other', files, pitched: !!data.samples && !Array.isArray(data.samples) });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  synths() {
    return Object.entries(soundMap.get())
      .filter(([, { data = {} }]) => data.type === 'synth')
      .map(([name]) => name)
      .sort();
  }

  banks() {
    const banks = new Set();
    for (const [name, { data = {} }] of Object.entries(soundMap.get())) {
      const cut = name.indexOf('_');
      if (data.type === 'sample' && cut > 0) banks.add(name.slice(0, cut));
    }
    return [...banks].sort();
  }
}
