// The music engine of vis-music. It reads one JSON request per line on stdin
// and writes one JSON answer per line on stdout:
//   { "id": 1, "op": "play", ... } -> { "id": 1, "ok": true, ... } | { "id": 1, "ok": false, "error": "..." }
// Arguments: --doughbox <path> --cache <dir>
import './quiet.mjs';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sounds, SYNTHS } from './sounds.mjs';
import { Doughbox } from './doughbox.mjs';
import { compile, select, onsets, plan, message, durationOf } from './track.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const BINARY = arg('--doughbox', 'doughbox');
const sounds = new Sounds(arg('--cache', join(tmpdir(), 'vis-music-cache')), { offline: process.argv.includes('--offline') });

const TICK_S = 0.05; // how often the live scheduler runs
const AHEAD_S = 0.25; // how far ahead it hands events to dough
const START_DELAY_S = 0.2; // the first cycle starts this long after play
const PRELOAD_CYCLES = 8; // cycles whose samples load before the sound starts

function warnings() {
  const seen = new Map();
  const warn = (text) => seen.set(text, (seen.get(text) || 0) + 1);
  warn.list = () => [...seen].map(([text, count]) => (count > 1 ? `${text} (${count}x)` : text));
  return warn;
}

const describe = (track, playing) => ({
  cps: track.cps,
  layers: track.layers.map((l) => ({ name: l.name, muted: l.muted, solo: l.solo, playing: playing.includes(l.name) })),
});

// Loads the files of `rows` into `box`; answers the file index of each sample.
async function prepare(rows, box, warn) {
  const plans = rows.map((row) => plan(row.value, sounds, warn));
  const wanted = new Map();
  for (const p of plans) if (p?.file) wanted.set(p.file.url, p.file);
  await Promise.all(
    [...wanted.values()].map(async (file) => {
      try {
        const path = await sounds.file(file.url);
        file.index = await box.load(path, 440 * Math.pow(2, (file.midi - 69) / 12));
        if (file.index === null) warn(`cannot decode ${file.url}`);
      } catch (e) {
        warn(`cannot load ${file.url}: ${e.message || e}`);
        file.index = null;
      }
    }),
  );
  for (const p of plans) if (p?.file) p.file.index = wanted.get(p.file.url).index;
  return plans;
}

// ---- live sound --------------------------------------------------------
const live = {
  box: null,
  timer: null,
  pattern: null,
  track: null,
  layers: [],
  code: '',
  cps: 0.5,
  anchorCycle: 0,
  anchorTime: 0,
  queried: 0,
  loading: new Set(),
  warn: warnings(),
  sent: 0,
};

const nowS = () => Date.now() / 1000;
const cycleAt = (t) => live.anchorCycle + (t - live.anchorTime) * live.cps;
const timeAt = (c) => live.anchorTime + (c - live.anchorCycle) / live.cps;

function tick() {
  const end = cycleAt(nowS() + AHEAD_S);
  if (end <= live.queried) return;
  const begin = live.queried;
  live.queried = end;
  let rows;
  try {
    rows = onsets(live.pattern, begin, end, live.cps);
  } catch (e) {
    live.warn(`pattern error: ${e.message || e}`);
    return;
  }
  const now = nowS();
  for (const row of rows) {
    const time = timeAt(row.cycle);
    if (time < now - 0.005) continue; // too late to play
    const p = plan(row.value, sounds, live.warn);
    if (!p) continue;
    let index;
    if (p.file) {
      index = live.box.indexOf(sounds.localPath(p.file.url));
      if (index === undefined) {
        loadLater(p.file);
        continue;
      }
      if (index === null) continue; // the file does not decode; prepare warned
    }
    live.box.send(`ev ${message(p, time, durationOf(row, live.cps), index)}`);
    live.sent++;
  }
}

// A sample that the preload missed loads now and plays from its next onset.
function loadLater(file) {
  if (live.loading.has(file.url)) return;
  live.loading.add(file.url);
  sounds
    .file(file.url)
    .then((path) => live.box.load(path, 440 * Math.pow(2, (file.midi - 69) / 12)))
    .catch((e) => live.warn(`cannot load ${file.url}: ${e.message || e}`))
    .finally(() => live.loading.delete(file.url));
}

async function play({ code, layers = [], cps }) {
  await sounds.defaults();
  const track = await compile(code, sounds);
  const chosen = select(track, layers);
  const newCps = Number(cps) > 0 ? Number(cps) : track.cps;
  if (!live.box || live.box.exited) {
    const box = new Doughbox(BINARY);
    try {
      await box.start();
    } catch (error) {
      await box.quit();
      throw error;
    }
    live.box = box;
  }
  const running = !!live.timer;
  const now = nowS();
  const from = running ? cycleAt(now) : 0;
  const warn = warnings();
  // Samples of the next cycles load before the change, so the first hits sound.
  await prepare(onsets(chosen.pattern, from, from + PRELOAD_CYCLES, newCps), live.box, warn);
  if (running) {
    // Keep the beat: re-anchor at the cycle reached so far.
    const at = Math.max(live.queried, cycleAt(nowS()));
    live.anchorTime = timeAt(at);
    live.anchorCycle = at;
    live.queried = at;
  } else {
    live.anchorCycle = 0;
    live.anchorTime = nowS() + START_DELAY_S;
    live.queried = 0;
    live.sent = 0;
  }
  live.cps = newCps;
  live.pattern = chosen.pattern;
  live.track = track;
  live.layers = chosen.layers;
  live.code = code;
  live.warn = warn;
  if (!running) live.timer = setInterval(tick, TICK_S * 1000);
  tick();
  return { ...status(), changed: running };
}

function stop() {
  if (live.timer) clearInterval(live.timer);
  live.timer = null;
  if (live.box && !live.box.exited) {
    live.box.send('ev /dough/reset_schedule');
    live.box.send('ev /dough/hush');
  }
  return status();
}

function status() {
  const playing = !!live.timer;
  return {
    playing,
    cycle: playing ? Math.max(0, cycleAt(nowS())) : null,
    cps: live.cps,
    layers: live.track ? describe(live.track, playing ? live.layers : []).layers : [],
    events_sent: live.sent,
    output: live.box && !live.box.exited ? live.box.backend : null,
    warnings: live.warn.list(),
  };
}

// ---- offline -----------------------------------------------------------
async function check({ code }) {
  await sounds.defaults();
  const track = await compile(code, sounds);
  const chosen = select(track, []);
  const warn = warnings();
  const rows = onsets(chosen.pattern, 0, 4, track.cps);
  for (const row of rows) plan(row.value, sounds, warn);
  return { ...describe(track, chosen.layers), warnings: warn.list(), events_in_4_cycles: rows.length };
}

async function events({ code, layers = [], begin = 0, end = 1, limit = 200 }) {
  await sounds.defaults();
  const track = await compile(code, sounds);
  const chosen = select(track, layers);
  const rows = onsets(chosen.pattern, Number(begin), Number(end), track.cps);
  const warn = warnings();
  const out = rows.slice(0, limit).map((row) => {
    const { _layer, ...value } = row.value || {};
    plan(row.value, sounds, warn);
    return {
      layer: _layer ?? null,
      cycle: Math.round(row.cycle * 1e6) / 1e6,
      time: Math.round((row.cycle / track.cps) * 1e6) / 1e6,
      duration: Math.round(durationOf(row, track.cps) * 1e6) / 1e6,
      value,
    };
  });
  return { cps: track.cps, layers: chosen.layers, total: rows.length, events: out, warnings: warn.list() };
}

async function renderOne(pattern, cps, cycles, tail, path, warn) {
  const box = new Doughbox(BINARY);
  try {
    const rows = onsets(pattern, 0, cycles, cps);
    const plans = await prepare(rows, box, warn);
    let count = 0;
    rows.forEach((row, i) => {
      const p = plans[i];
      if (!p || (p.file && (p.file.index === null || p.file.index === undefined))) return;
      box.send(`queue ${message(p, row.cycle / cps, durationOf(row, cps), p.file?.index)}`);
      count++;
    });
    const seconds = cycles / cps + tail;
    const stats = await box.render(seconds, path);
    return { path, seconds, events: count, ...stats };
  } finally {
    await box.quit();
  }
}

async function render({ code, out, layers = [], cycles = 0, seconds = 0, tail = 2, stems = false }) {
  await sounds.defaults();
  const track = await compile(code, sounds);
  const cps = track.cps;
  const n = Number(cycles) > 0 ? Number(cycles) : Number(seconds) > 0 ? Number(seconds) * cps : 8;
  const warn = warnings();
  const files = [];
  if (stems) {
    const names = layers.length ? layers : select(track, []).layers;
    for (const name of names) {
      const chosen = select(track, [name]);
      const safe = name.replace(/[^\w.-]+/g, '_');
      files.push({ layer: name, ...(await renderOne(chosen.pattern, cps, n, tail, out.replace(/\.wav$/i, `.${safe}.wav`), warn)) });
    }
  } else {
    const chosen = select(track, layers);
    files.push({ layer: null, layers: chosen.layers, ...(await renderOne(chosen.pattern, cps, n, tail, out, warn)) });
  }
  return { cps, cycles: n, files, warnings: warn.list() };
}

async function soundList({ filter = '', refresh = false, limit = 300 }) {
  const errors = await sounds.defaults(refresh);
  const rows = sounds.names(filter);
  return { total: rows.length, sounds: rows.slice(0, limit), synths: Object.keys(SYNTHS), banks: [...sounds.banks].sort(), errors };
}

const OPS = {
  ping: async () => ({ pong: true }),
  play,
  stop: async () => stop(),
  status: async () => status(),
  check,
  events,
  render,
  sounds: soundList,
};

let chain = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  // One request at a time, in order: a play never races a render.
  chain = chain.then(async () => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, error: 'the request is not JSON' }) + '\n');
      return;
    }
    const op = OPS[req.op];
    let answer;
    try {
      if (!op) throw new Error(`unknown op ${req.op}`);
      answer = { id: req.id, ok: true, ...(await op(req)) };
    } catch (e) {
      if (process.env.VIS_MUSIC_DEBUG) console.error(e?.stack || e);
      answer = { id: req.id, ok: false, error: String(e?.message || e) };
    }
    process.stdout.write(JSON.stringify(answer) + '\n');
  });
});

process.stdin.on('end', async () => {
  await chain;
  stop();
  await live.box?.quit();
  process.exit(0);
});
