// A track is Strudel code. Its layers are the labelled blocks: `$:` blocks
// and named blocks such as `drums:`. Strudel rules apply: a label that starts
// or ends with `_` is muted, a label that starts with `S` is solo.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';
import * as superdough from 'superdough';
import * as soundfonts from '@strudel/soundfonts';

const { evalScope, evaluate, Pattern, stack, silence } = core;

let context = null; // the compile that runs now

Pattern.prototype.p = function (id) {
  if (!context) return this;
  let name = String(id);
  if (name.includes('$')) name = `${name}${context.anonymous++}`;
  context.layers.set(name, this);
  return this;
};
Pattern.prototype.q = function () {
  return silence;
};
for (let i = 1; i < 10; i++) {
  for (const prefix of ['d', 'p']) {
    Object.defineProperty(Pattern.prototype, `${prefix}${i}`, {
      get() {
        return this.p(String(i));
      },
      configurable: true,
    });
  }
}

const pure = (v) => (v && v._Pattern ? v.__pure : v);
let scopeReady = null;

function scope() {
  // The functions of strudel.cc: Strudel, superdough and the soundfonts. A load
  // that code starts finishes before the compile answers.
  const later = (load) => (...args) => (context.pending.push(Promise.resolve(load(...args))), silence);
  return evalScope(core, mini, tonal, superdough, soundfonts, {
    setcps: (v) => ((context.cps = Number(pure(v))), silence),
    setCps: (v) => ((context.cps = Number(pure(v))), silence),
    setcpm: (v) => ((context.cps = Number(pure(v)) / 60), silence),
    setCpm: (v) => ((context.cps = Number(pure(v)) / 60), silence),
    hush: () => (context.layers.clear(), silence),
    all: (f) => (context.all.push(f), silence),
    each: (f) => ((context.each = f), silence),
    samples: later(superdough.samples),
    aliasBank: later(superdough.aliasBank),
    loadSoundfont: later(soundfonts.loadSoundfont),
  });
}

export const isMuted = (name) => name.startsWith('_') || name.endsWith('_');
export const isSolo = (name) => name.length > 1 && name.startsWith('S');

// Compiles code into its layers. Throws with Strudel's own message on an error.
// The transpiler reads every double-quoted string as mini-notation, so
// samples("github:owner/repo") fails on its "/". A sample source is a plain
// string: give samples(...) its first argument in single quotes.
const plainSampleSources = (code) =>
  code.replace(/\bsamples\(\s*"([^"\\\n]*)"/g, (_, source) => `samples('${source.replace(/'/g, "\\'")}'`);

// Strudel methods that draw in the browser. Here they draw nothing, so a track
// copied from strudel.cc still plays. They replace the ones of @strudel/draw.
const VISUALS = ['pianoroll', 'punchcard', 'spiral', 'scope', 'tscope', 'fscope', 'spectrum', 'pitchwheel', 'wordfall', 'markcss', 'draw'];
for (const name of VISUALS) {
  for (const key of [name, `_${name}`]) {
    Pattern.prototype[key] = function () {
      return this;
    };
  }
}

export async function compile(code) {
  if (!scopeReady) scopeReady = scope();
  await scopeReady;
  context = { layers: new Map(), anonymous: 0, cps: null, all: [], each: null, pending: [] };
  const mine = context;
  try {
    const { pattern } = await evaluate(plainSampleSources(code), transpiler);
    await Promise.all(mine.pending);
    if (!mine.layers.size && pattern && pattern._Pattern) mine.layers.set('main', pattern);
    return {
      layers: [...mine.layers].map(([name, pattern]) => ({ name, pattern, muted: isMuted(name), solo: isSolo(name) })),
      cps: mine.cps ?? 0.5,
      all: mine.all,
      each: mine.each,
    };
  } finally {
    context = null;
  }
}

// The pattern to play: the named layers, or else the layers Strudel plays.
export function select(track, names = []) {
  let chosen;
  if (names.length) {
    const known = new Set(track.layers.map((l) => l.name));
    const missing = names.filter((n) => !known.has(n));
    if (missing.length) throw new Error(`unknown layer: ${missing.join(', ')}; layers: ${[...known].join(', ') || 'none'}`);
    chosen = track.layers.filter((l) => names.includes(l.name));
  } else {
    const live = track.layers.filter((l) => !l.muted);
    const solos = live.filter((l) => l.solo);
    chosen = solos.length ? solos : live;
  }
  let patterns = chosen.map((l) => l.pattern.withValue((v) => (v && typeof v === 'object' ? { ...v, _layer: l.name } : v)));
  if (track.each) patterns = patterns.map((p) => track.each(p));
  let pattern = patterns.length ? stack(...patterns) : silence;
  for (const f of track.all) pattern = f(pattern);
  return { pattern, layers: chosen.map((l) => l.name) };
}

// The onsets in [begin, end) cycles, as plain rows.
export function onsets(pattern, begin, end, cps) {
  return pattern
    .queryArc(begin, end, { _cps: cps })
    .filter((hap) => hap.hasOnset())
    .map((hap) => ({
      cycle: hap.whole.begin.valueOf(),
      cycles: hap.duration.valueOf(),
      value: hap.value,
    }))
    .sort((a, b) => a.cycle - b.cycle);
}

// What a listener would miss in one event: no sound at all, or a sound that
// is not registered.
export function problem(value, sounds) {
  if (!value || typeof value !== 'object') return `a value without controls: ${JSON.stringify(value)}`;
  if (value.s === undefined) {
    return value.note !== undefined || value.freq !== undefined || value.n !== undefined ? null : 'an event without a sound: add s("...") or note("...")';
  }
  if (typeof value.s === 'string' && ['-', '~', '_'].includes(value.s)) return null;
  if (!sounds.soundOf(value)) return `unknown sound "${value.bank ? value.bank + '_' : ''}${value.s}"`;
  return null;
}

export function durationOf(row, cps) {
  const v = row.value || {};
  const clip = Number(v.clip ?? v.legato ?? 1) || 1;
  return (row.cycles / cps) * clip;
}
