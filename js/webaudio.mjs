// Web Audio for Node: node-web-audio-api from the directory that --webaudio
// names, plus the few browser globals that Strudel touches. Import this module
// before Strudel: superdough reads the Web Audio globals when it loads.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const at = process.argv.indexOf('--webaudio');
if (at < 0) throw new Error('--webaudio <directory of node-web-audio-api> is missing');
let loaded;
try {
  loaded = await import(pathToFileURL(join(process.argv[at + 1], 'index.js')).href);
} catch (error) {
  const linux = process.platform === 'linux' ? ' On Linux, install libasound2, libdbus-1-3 and libpipewire-0.3-0.' : '';
  process.stderr.write(`node-web-audio-api does not load: ${error.message.split('\n')[0]}.${linux}\n`);
  process.exit(1);
}
const api = loaded.default ?? loaded;

const noop = () => {};
for (const [name, value] of Object.entries(api)) if (name !== 'mediaDevices') globalThis[name] = value;
globalThis.window ??= globalThis;
for (const name of ['addEventListener', 'removeEventListener', 'postMessage', 'dispatchEvent']) globalThis[name] ??= noop;
// Strudel sends its log as events on document; the engine listens to them.
const listeners = new Map();
globalThis.document ??= {
  addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener]),
  removeEventListener: (type, listener) => listeners.set(type, (listeners.get(type) || []).filter((l) => l !== listener)),
  dispatchEvent: (event) => (listeners.get(event.type) || []).forEach((listener) => listener(event)),
  querySelector: () => null,
  createElement: () => ({ getContext: () => null, style: {}, appendChild: noop }),
  body: { appendChild: noop, removeChild: noop },
};
