// One doughbox process: the native dough synth that plays and renders sound.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class Doughbox {
  constructor(binary) {
    this.proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.waiting = [];
    this.files = new Map(); // local path -> file index
    this.failed = new Set();
    this.exited = false;
    this.proc.on('exit', () => {
      this.exited = true;
      for (const w of this.waiting.splice(0)) w.reject(new Error('doughbox stopped'));
    });
    this.proc.on('error', (e) => {
      this.exited = true;
      for (const w of this.waiting.splice(0)) w.reject(e);
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      if (!line.startsWith('@')) return;
      this.waiting.shift()?.resolve(line.slice(1).split(' '));
    });
  }

  send(line) {
    if (this.exited) throw new Error('doughbox stopped');
    this.proc.stdin.write(line + '\n');
  }

  // Sends a command that has one answer line, and waits for it.
  ask(line) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      try {
        this.send(line);
      } catch (e) {
        this.waiting.pop();
        reject(e);
      }
    });
  }

  // The file index of a local sample file, decoded once in this process.
  async load(path, freq) {
    if (this.files.has(path)) return this.files.get(path);
    if (this.failed.has(path)) return null;
    const index = this.files.size + this.failed.size;
    const answer = await this.ask(`load ${index} ${freq} ${path}`);
    if (answer[2] !== 'ok') {
      this.failed.add(path);
      return null;
    }
    this.files.set(path, index);
    return index;
  }

  async start() {
    const answer = await this.ask('start');
    if (answer[1] === 'ok') {
      this.backend = answer.slice(2).join(' ');
      return;
    }
    throw new Error(
      answer[2] === 'no-audio-device'
        ? 'no audio output device on this machine: music.play needs speakers; music.export still works'
        : 'cannot open the audio output device',
    );
  }

  async render(seconds, path) {
    const answer = await this.ask(`render ${seconds} ${path}`);
    if (answer[1] !== 'ok') throw new Error(`render failed: ${answer.slice(2).join(' ')}`);
    return { frames: Number(answer[2]), peak: Number(answer[3]), rms: Number(answer[4]) };
  }

  async quit() {
    if (this.exited) return;
    const done = new Promise((resolve) => this.proc.once('exit', resolve));
    try {
      this.send('quit');
    } catch {
      return;
    }
    await done;
  }
}
