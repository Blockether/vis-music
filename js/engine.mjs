// The music engine of vis-music. It reads one JSON request per line on stdin
// and writes one JSON answer per line on stdout:
//   { "id": 1, "op": "play", ... } -> { "id": 1, "ok": true, ... } | { "id": 1, "ok": false, "error": "..." }
// Arguments: --webaudio <dir> --cache <dir> [--offline]. With --render-job, the
// process renders the one request on stdin and exits.
import './quiet.mjs';
import './webaudio.mjs';
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { initAudio, resetGlobalEffects, setAudioContext, setSuperdoughAudioController, superdough } from 'superdough';
import { logger } from '@strudel/core';
import { Sounds } from './sounds.mjs';
import { compile, durationOf, onsets, problem, select } from './track.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const sounds = new Sounds(arg('--cache', join(tmpdir(), 'vis-music-cache')), { offline: process.argv.includes('--offline') });

const TICK_S = 0.05; // how often the live scheduler runs
const AHEAD_S = 0.25; // how far ahead it hands events to superdough
const START_DELAY_S = 0.2; // the first cycle starts this long after play
const PRELOAD_CYCLES = 8; // cycles whose sounds load before the sound starts
const SLICE_S = AHEAD_S; // a render schedules ahead like live play
const SAMPLE_RATE = 44100;
const MAX_POLYPHONY = 128; // the default of strudel.cc

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

const message = (e) => String(e?.message || e);

// Strudel reports some problems only in its log, such as an unknown chord.
// They go to the warnings of the request that runs, else of the live sound.
let sink = null;
document.addEventListener(logger.key, (event) => {
  const { message: text = '', type } = event.detail || {};
  if (type === 'error' || type === 'warning' || /unknown|error|not found/i.test(text)) (sink ?? live.warn)(String(text));
});

// Runs `work` with Strudel's log going to `warn`. The logger drops a message
// that repeats within a second, so a new request starts it afresh.
async function reporting(warn, work) {
  sink = warn;
  try {
    return await work();
  } finally {
    sink = null;
    logger('', 'reset');
  }
}

// Loads the sounds of `rows` before they play; reports each sound that fails once.
async function preload(rows, ac, warn) {
  const seen = new Set();
  const loads = [];
  for (const { value } of rows) {
    const why = problem(value, sounds);
    if (why) {
      warn(why);
      continue;
    }
    const key = JSON.stringify([value.s, value.bank, value.n, value.note, value.freq]);
    if (seen.has(key)) continue;
    seen.add(key);
    loads.push(sounds.preload(value, ac).catch((e) => warn(`cannot load sound "${value.s}": ${message(e)}`)));
  }
  await Promise.all(loads);
}

// One superdough audio context at a time: the live one, or a render's.
async function useContext(ac) {
  setAudioContext(ac);
  setSuperdoughAudioController(null);
  await initAudio({ maxPolyphony: MAX_POLYPHONY });
  return ac;
}

// ---- live sound --------------------------------------------------------
const live = {
  ac: null,
  timer: null,
  pattern: null,
  track: null,
  layers: [],
  cps: 0.5,
  anchorCycle: 0,
  anchorTime: 0,
  queried: 0,
  warn: warnings(),
  sent: 0,
};

const NO_DEVICE = 'no audio output device on this machine: music.play needs speakers; music.export still works';

async function liveContext() {
  if (live.ac) return live.ac;
  if (process.env.VIS_MUSIC_NO_AUDIO) throw new Error(NO_DEVICE);
  let ac;
  try {
    ac = new AudioContext({ latencyHint: 'playback' });
  } catch (e) {
    throw new Error(`${NO_DEVICE} (${message(e)})`);
  }
  live.ac = await useContext(ac);
  return ac;
}

const nowS = () => live.ac.currentTime;
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
    live.warn(`pattern error: ${message(e)}`);
    return;
  }
  const now = nowS();
  const warn = live.warn;
  for (const row of rows) {
    const time = timeAt(row.cycle);
    if (time < now - 0.005) continue; // too late to play
    const why = problem(row.value, sounds);
    if (why) {
      warn(why);
      continue;
    }
    superdough(row.value, time, row.cycles / live.cps, live.cps, time).catch((e) => warn(message(e)));
    live.sent++;
  }
}

async function play({ code, layers = [], cps }) {
  await sounds.defaults();
  const warn = warnings();
  const { track, chosen, newCps } = await reporting(warn, async () => {
    const track = await compile(code);
    const chosen = select(track, layers);
    const newCps = Number(cps) > 0 ? Number(cps) : track.cps;
    const ac = await liveContext();
    const from = live.timer ? cycleAt(nowS()) : 0;
    // Sounds of the next cycles load before the change, so the first hits sound.
    await preload(onsets(chosen.pattern, from, from + PRELOAD_CYCLES, newCps), ac, warn);
    return { track, chosen, newCps };
  });
  const running = !!live.timer;
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
  live.warn = warn;
  if (!running) live.timer = setInterval(tick, TICK_S * 1000);
  tick();
  return { ...status(), changed: running };
}

function stop() {
  if (live.timer) clearInterval(live.timer);
  live.timer = null;
  // Disconnects the orbits, so the events already scheduled are silent too.
  if (live.ac) resetGlobalEffects();
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
    output: live.ac ? `system default output, ${live.ac.sampleRate} Hz` : null,
    warnings: live.warn.list(),
  };
}

// ---- offline -----------------------------------------------------------
async function check({ code }) {
  await sounds.defaults();
  const warn = warnings();
  return reporting(warn, async () => {
    const track = await compile(code);
    const chosen = select(track, []);
    const rows = onsets(chosen.pattern, 0, 4, track.cps);
    for (const row of rows) {
      const why = problem(row.value, sounds);
      if (why) warn(why);
    }
    return { ...describe(track, chosen.layers), warnings: warn.list(), events_in_4_cycles: rows.length };
  });
}

async function events({ code, layers = [], begin = 0, end = 1, limit = 200 }) {
  await sounds.defaults();
  const warn = warnings();
  return reporting(warn, () => eventRows(code, layers, begin, end, limit, warn));
}

async function eventRows(code, layers, begin, end, limit, warn) {
  const track = await compile(code);
  const chosen = select(track, layers);
  const rows = onsets(chosen.pattern, Number(begin), Number(end), track.cps);
  const out = rows.slice(0, limit).map((row) => {
    const { _layer, ...value } = row.value || {};
    const why = problem(row.value, sounds);
    if (why) warn(why);
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

// 16-bit stereo WAV, written in parts so a long render needs no second copy.
async function writeWav(path, buffer) {
  const frames = buffer.length;
  const channels = [buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)];
  let peak = 0;
  let sum = 0;
  mkdirSync(dirname(path), { recursive: true });
  const out = createWriteStream(path);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + frames * 4, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(2, 22);
  head.writeUInt32LE(buffer.sampleRate, 24);
  head.writeUInt32LE(buffer.sampleRate * 4, 28);
  head.writeUInt16LE(4, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(frames * 4, 40);
  out.write(head);
  const PART = 65536;
  for (let start = 0; start < frames; start += PART) {
    const n = Math.min(PART, frames - start);
    const part = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const x = channels[c][start + i];
        const a = Math.abs(x);
        if (a > peak) peak = a;
        sum += x * x;
        part.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x)) * 32767), i * 4 + c * 2);
      }
    }
    if (!out.write(part)) await new Promise((resolve) => out.once('drain', resolve));
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  return { frames, peak, rms: Math.sqrt(sum / Math.max(1, frames * 2)) };
}

// Renders one pattern like strudel.cc: superdough on an OfflineAudioContext.
// Events go in one slice at a time while the render waits, so voices that end
// free their place as they do in live play, and the polyphony limit cuts only
// what it cuts there.
async function renderPattern(pattern, cps, cycles, tail, path, warn) {
  const seconds = cycles / cps + tail;
  const ac = await useContext(new OfflineAudioContext(2, Math.max(1, Math.round(seconds * SAMPLE_RATE)), SAMPLE_RATE));
  const rows = onsets(pattern, 0, cycles, cps);
  await preload(rows, ac, warn);
  const lastOnset = rows.length ? rows[rows.length - 1].cycle / cps : 0;
  let next = 0;
  let count = 0;
  const scheduleUntil = async (limit) => {
    // In onset order, one at a time: controls such as `cut` read the audio graph.
    for (; next < rows.length && rows[next].cycle / cps < limit; next++) {
      const row = rows[next];
      if (problem(row.value, sounds)) continue;
      const time = row.cycle / cps;
      try {
        await superdough(row.value, time, row.cycles / cps, cps, time);
        count++;
      } catch (e) {
        warn(message(e));
      }
    }
  };
  // node-web-audio-api accepts a suspend only before the render starts, so
  // every slice is asked for here. Rarely one fails in the library; the render
  // then fails as retryable and runs again in a new process.
  let failure = null;
  for (let at = SLICE_S; at + SLICE_S < seconds && at < lastOnset + SLICE_S; at += SLICE_S) {
    ac.suspend(at).then(
      async () => {
        try {
          // The voices that ended in the last slice free their place first.
          await new Promise((resolve) => setImmediate(resolve));
          await scheduleUntil(at + 2 * SLICE_S);
        } catch (e) {
          failure ??= e;
        }
        await ac.resume().catch((e) => (failure ??= e));
      },
      (e) => (failure ??= e),
    );
  }
  await scheduleUntil(2 * SLICE_S);
  const buffer = await ac.startRendering();
  if (failure) throw Object.assign(new Error(`the render lost events at a slice: ${message(failure)}`), { retry: true });
  return { path, seconds, events: count, ...(await writeWav(path, buffer)) };
}

async function renderJob({ code, layers = [], cycles, tail, path }) {
  await sounds.defaults();
  const warn = warnings();
  const track = await reporting(warn, () => compile(code));
  const chosen = select(track, layers);
  const file = await reporting(warn, () => renderPattern(chosen.pattern, track.cps, cycles, tail, path, warn));
  return { layers: chosen.layers, file, warnings: warn.list() };
}

// Each render runs in its own process: superdough keeps global node pools
// that must not mix the nodes of two audio contexts.
async function renderInChild(job, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await renderProcess(job);
    } catch (e) {
      if (!e.retry || attempt >= attempts) throw e;
    }
  }
}

function renderProcess(job) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.argv.slice(1), '--render-job'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      const line = out.trim().split('\n').pop() || '';
      let answer;
      try {
        answer = JSON.parse(line);
      } catch {
        reject(new Error(`the render stopped (exit ${code})`));
        return;
      }
      if (answer.ok) resolve(answer);
      else reject(Object.assign(new Error(answer.error), { retry: !!answer.retry }));
    });
    child.stdin.end(JSON.stringify(job));
  });
}

async function render({ code, out, layers = [], cycles = 0, seconds = 0, tail = 2, stems = false }) {
  await sounds.defaults();
  // Only for the tempo and the layers; the render process reports the warnings.
  const track = await reporting(warnings(), () => compile(code));
  const cps = track.cps;
  const n = Number(cycles) > 0 ? Number(cycles) : Number(seconds) > 0 ? Number(seconds) * cps : 8;
  const jobs = [];
  if (stems) {
    const names = layers.length ? layers : select(track, []).layers;
    for (const name of names) {
      select(track, [name]); // an unknown layer fails before any render
      const safe = name.replace(/[^\w.-]+/g, '_');
      jobs.push({ layer: name, code, layers: [name], cycles: n, tail: Number(tail), path: out.replace(/\.wav$/i, `.${safe}.wav`) });
    }
  } else {
    jobs.push({ layer: null, code, layers, cycles: n, tail: Number(tail), path: out });
  }
  const results = new Array(jobs.length);
  const width = Math.max(1, Math.min(jobs.length, Math.floor(availableParallelism() / 2)));
  let taken = 0;
  await Promise.all(
    [...Array(width)].map(async () => {
      while (taken < jobs.length) {
        const i = taken++;
        results[i] = await renderInChild(jobs[i]);
      }
    }),
  );
  const warn = warnings();
  for (const r of results) for (const w of r.warnings) warn(w);
  const files = results.map((r, i) => ({ layer: jobs[i].layer, ...(jobs[i].layer === null ? { layers: r.layers } : {}), ...r.file }));
  return { cps, cycles: n, files, warnings: warn.list() };
}

async function soundList({ filter = '', refresh = false, limit = 300 }) {
  const errors = await sounds.defaults(refresh);
  const rows = sounds.names(filter);
  return { total: rows.length, sounds: rows.slice(0, limit), synths: sounds.synths(), banks: sounds.banks(), errors };
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

const answer = (id, run) =>
  run().then(
    (fields) => ({ id, ok: true, ...fields }),
    (e) => {
      if (process.env.VIS_MUSIC_DEBUG) console.error(e?.stack || e);
      return { id, ok: false, error: message(e), ...(e?.retry ? { retry: true } : {}) };
    },
  );

if (process.argv.includes('--render-job')) {
  let text = '';
  process.stdin.on('data', (chunk) => (text += chunk));
  process.stdin.on('end', async () => {
    const reply = await answer(undefined, () => renderJob(JSON.parse(text)));
    process.stdout.write(JSON.stringify(reply) + '\n', () => process.exit(0));
  });
} else {
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
      const reply = await answer(req.id, () => (op ? op(req) : Promise.reject(new Error(`unknown op ${req.op}`))));
      process.stdout.write(JSON.stringify(reply) + '\n');
    });
  });
  process.stdin.on('end', async () => {
    await chain;
    stop();
    await live.ac?.close().catch(() => {});
    process.exit(0);
  });
}
