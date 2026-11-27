// A track is Strudel code. Its layers are the labelled blocks: `$:` blocks
// and named blocks such as `drums:`. Strudel rules apply: a label that starts
// or ends with `_` is muted, a label that starts with `S` is solo.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';
import { SYNTHS } from './sounds.mjs';

const { evalScope, evaluate, Pattern, stack, silence, noteToMidi } = core;

// Strudel controls that dough plays. Keys are Strudel names, values dough names.
const DOUGH_KEYS = new Map(
  (
    'gain postgain velocity pan speed glide pw freq ' +
    'cutoff resonance lpattack lpdecay lpsustain lprelease lpenv ' +
    'hcutoff hresonance hpattack hpdecay hpsustain hprelease hpenv ' +
    'bandf bandq bpattack bpdecay bpsustain bprelease bpenv ftype ' +
    'attack decay sustain release penv pattack pdecay psustain prelease ' +
    'vib vibmod fm fmh fmenv fmattack fmdecay fmsustain fmrelease am amdepth rm rmdepth ' +
    'phaser phaserrate phaserdepth phasersweep phasercenter flanger flangerrate flangerdepth flangerfeedback ' +
    'chorus chorusrate chorusdepth chorusdelay begin end coarse crush distort distortvol ' +
    'delay delaytime delayfeedback room roomdecay roomdamp roompredelay roomdiff orbit group voices'
  )
    .split(' ')
    .map((k) => [k, k]),
);
DOUGH_KEYS.set('fmi', 'fmi');
DOUGH_KEYS.set('vibrato', 'vib');
// Controls that only choose the sound or the time, handled here.
const HANDLED = new Set(['s', 'n', 'note', 'bank', 'clip', 'legato', 'cps', 'duration', 'dough']);

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

function scope(sounds) {
  return evalScope(core, mini, tonal, {
    setcps: (v) => ((context.cps = Number(pure(v))), silence),
    setCps: (v) => ((context.cps = Number(pure(v))), silence),
    setcpm: (v) => ((context.cps = Number(pure(v)) / 60), silence),
    setCpm: (v) => ((context.cps = Number(pure(v)) / 60), silence),
    hush: () => (context.layers.clear(), silence),
    all: (f) => (context.all.push(f), silence),
    each: (f) => ((context.each = f), silence),
    samples: (spec, base) => {
      context.pending.push(sounds.addFromCode(spec, base));
      return silence;
    },
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

// Strudel methods that only draw in the browser. Here they draw nothing, so a
// track copied from strudel.cc still plays.
const VISUALS = ['pianoroll', 'punchcard', 'spiral', 'scope', 'tscope', 'fscope', 'spectrum', 'pitchwheel', 'wordfall', 'markcss', 'draw'];
for (const name of VISUALS) {
  for (const key of [name, `_${name}`]) {
    if (!Pattern.prototype[key]) Pattern.prototype[key] = function () { return this; };
  }
}

export async function compile(code, sounds) {
  if (!scopeReady) scopeReady = scope(sounds);
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

const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));

// What dough needs for one event: a synth name or a sample file, and the
// controls it plays. `warn` collects controls and sounds it cannot play.
export function plan(value, sounds, warn) {
  if (!value || typeof value !== 'object') {
    warn(`a value without controls: ${JSON.stringify(value)}`);
    return null;
  }
  let note = value.note;
  if (typeof note === 'string') note = noteToMidi(note);
  const name = value.s ?? (note !== undefined || value.freq !== undefined ? 'triangle' : undefined);
  if (name === undefined) {
    warn('an event without a sound: add s("...") or note("...")');
    return null;
  }
  const controls = [];
  for (const [key, v] of Object.entries(value)) {
    if (HANDLED.has(key) || key.startsWith('_')) continue;
    const doughKey = DOUGH_KEYS.get(key);
    if (!doughKey) {
      warn(`control "${key}" is not played by dough`);
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) controls.push([doughKey, v]);
    else if (key === 'ftype' && typeof v === 'string' && /^\w+$/.test(v)) controls.push([doughKey, v]);
  }
  const synth = SYNTHS[String(name).toLowerCase()];
  if (synth) {
    if (name === 'supersaw') warn('sound "supersaw" plays as "sawtooth"');
    return { synth, note: note ?? (value.freq === undefined ? 36 : undefined), controls };
  }
  const file = sounds.resolve(name, value.bank, value.n, note);
  if (!file) {
    warn(`unknown sound "${value.bank ? value.bank + '_' : ''}${name}"`);
    return null;
  }
  return { file, note, controls };
}

// The dough message for a planned event at `time` seconds.
export function message(planned, time, duration, fileIndex) {
  const parts = ['dough', 'play', 'time', fmt(time), 'duration', fmt(duration)];
  if (planned.synth) parts.push('s', planned.synth);
  else parts.push('file', String(fileIndex));
  if (planned.note !== undefined && Number.isFinite(planned.note)) parts.push('note', fmt(planned.note));
  for (const [k, v] of planned.controls) parts.push(k, typeof v === 'number' ? fmt(v) : v);
  return '/' + parts.join('/');
}

export function durationOf(row, cps) {
  const v = row.value || {};
  const clip = Number(v.clip ?? v.legato ?? 1) || 1;
  return (row.cycles / cps) * clip;
}
