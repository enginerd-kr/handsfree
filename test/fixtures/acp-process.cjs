// A real process tree for lifecycle tests. No installed ACP adapter is used.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const [recordFile, mode] = process.argv.slice(2);
const record = (event) => fs.appendFileSync(recordFile, JSON.stringify({ event, pid: process.pid, mode }) + '\n');

if (mode === 'worker' || mode === 'stubborn-worker') {
  setInterval(() => {}, 1_000);
  process.on('SIGTERM', () => {
    record('term');
    if (mode === 'worker') setTimeout(() => { record('stopped'); process.exit(0); }, 100);
  });
  record('ready');
  process.send('ready');
} else {
  const child = spawn(process.execPath, [__filename, recordFile, mode === 'stubborn' ? 'stubborn-worker' : 'worker'], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', () => {
    record('ready');
    if (mode === 'early-exit') process.exit(0);
  });
  process.on('SIGTERM', () => { record('term'); process.exit(0); });
  const input = readline.createInterface({ input: process.stdin });
  input.on('close', () => { record('eof'); process.exit(0); });
  input.on('line', (line) => {
    const request = JSON.parse(line);
    record(request.method);
    if (mode === 'stall' || request.id === undefined) return;
    if (request.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: {
          type: 'text', text: JSON.stringify({ action: 'answer', message: 'Hello.' }),
        } },
      } }) + '\n');
    }
    const result = request.method === 'initialize'
      ? { protocolVersion: 1, agentInfo: { name: 'lifecycle-fixture', version: '1' }, agentCapabilities: {}, authMethods: [] }
      : request.method === 'session/new' ? { sessionId: 'fixture-session' } : { stopReason: 'end_turn' };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  });
}
