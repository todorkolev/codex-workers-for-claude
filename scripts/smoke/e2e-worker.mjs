#!/usr/bin/env node
// End-to-end acceptance test for the Codex Workers bridge.
// Starts a real read-only Codex worker via the MCP tools, waits for completion,
// reads messages, collects result, and verifies artifacts on disk.
//
// Usage: node scripts/smoke/e2e-worker.mjs
// Exits 0 on PASS, 1 on FAIL. Requires: built dist/bridge.js, codex logged in.
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BRIDGE = join(HERE, '..', '..', 'plugins', 'codex-workers', 'dist', 'bridge.js');
const PROJ = mkdtempSync(join(tmpdir(), 'cw-e2e-'));

const cp = spawn('node', [BRIDGE], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_WORKERS_PROJECT_DIR: PROJ, CODEX_WORKERS_LOG_LEVEL: 'info' },
});
let stderr = '';
cp.stderr.on('data', d => { stderr += d.toString(); });
const rl = createInterface({ input: cp.stdout });
const pending = new Map();
rl.on('line', line => {
  line = line.trim(); if (!line) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const rpc = (id, method, params, t = 30000) => new Promise((res, rej) => {
  pending.set(id, res);
  cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, t);
});
const call = (id, name, args, t) => rpc(id, 'tools/call', { name, arguments: args }, t);
const un = r => { if (r.error) return { __error: r.error }; const s = r.result?.structuredContent; if (s) return s; const x = r.result?.content?.find(c => c.type === 'text')?.text; try { return JSON.parse(x); } catch { return { __text: x }; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

let id = 10, ok = true;
const fail = (msg) => { ok = false; log('FAIL:', msg); };
try {
  await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  log('>> codex_worker_start (read-only, waitFor=started)');
  const start = un(await call(id++, 'codex_worker_start', {
    workerId: 'e2e', task: 'What is 2+2? Reply with only the number and nothing else.',
    sandboxPolicy: 'read-only', approvalPolicy: 'never', waitFor: 'started', timeoutMs: 90000,
  }, 40000));
  if (start.__error) fail('start returned error: ' + JSON.stringify(start.__error));
  log('   started state=' + start.state + ' thread=' + String(start.threadId || '').slice(0, 12));

  // Poll up to 90s for completion.
  let last;
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    last = un(await call(id++, 'codex_worker_status', { workerId: 'e2e' }));
    log(`   poll ${i}: state=${last.state} msgs=${last.messageCount} raw=${last.rawEventCount}`);
    if (['completed', 'idle', 'failed', 'interrupted'].includes(last.state)) break;
  }
  if (!['completed', 'idle'].includes(last.state)) fail('worker never reached completed/idle (final: ' + last.state + ')');

  const msgs = un(await call(id++, 'codex_worker_read_messages', { workerId: 'e2e', maxChars: 4000 }));
  const msgList = msgs.messages || [];
  log('   messages: ' + msgList.length);
  for (const mm of msgList) log('     - ' + mm.type + ': ' + String(mm.text || '').slice(0, 80).replace(/\n/g, ' '));
  if (msgList.length === 0) fail('no messages forwarded (Bug B)');
  const sawAnswer = JSON.stringify(msgs).includes('4');
  if (!sawAnswer) fail('agent answer "4" not present in messages');

  const cr = un(await call(id++, 'codex_worker_collect_result', { workerId: 'e2e', includeMessages: true, includeCommandSummary: true }));
  log('   final: ' + String(cr.finalMessage || '').slice(0, 80).replace(/\n/g, ' '));
  if (!cr.artifactPaths || Object.keys(cr.artifactPaths).length === 0) fail('collect_result missing artifactPaths');

  // Artifacts on disk
  const runs = join(PROJ, '.codex-workers', 'runs');
  let files = [];
  if (existsSync(runs)) for (const r of readdirSync(runs)) { const w = join(runs, r, 'workers', 'e2e'); if (existsSync(w)) files = readdirSync(w); }
  log('   artifacts on disk: ' + JSON.stringify(files));
  for (const need of ['events.ndjson', 'messages.md', 'result.json']) {
    if (!files.includes(need)) fail('missing artifact on disk: ' + need + ' (Bug C)');
  }
} catch (e) {
  fail('exception: ' + e.message);
} finally {
  if (!ok && stderr.trim()) log('STDERR_TAIL:\n' + stderr.split('\n').filter(Boolean).slice(-15).join('\n'));
  log(ok ? 'E2E_RESULT: PASS' : 'E2E_RESULT: FAIL');
  cp.kill('SIGKILL');
  process.exit(ok ? 0 : 1);
}
