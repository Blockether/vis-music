// Strudel logs to the console when it loads. stdout carries the protocol, so
// every console message goes to stderr. Import this module first.
for (const name of ['log', 'info', 'warn', 'debug']) {
  console[name] = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
}
