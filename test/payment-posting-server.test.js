import { it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

it('boots the real proxy without credentials and gates payment exceptions to staff', { timeout: 15000 }, async () => {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  // Deliberately do not inherit any financial/service credentials or launch jobs.
  const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  Object.assign(env, { PORT: String(port), CRM_UPSTREAM: 'http://127.0.0.1:9', NODE_ENV: 'test' });
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const root = `http://127.0.0.1:${port}`;
  const request = (path, options = {}) => fetch(root + path, { ...options, signal: AbortSignal.timeout(1000) });
  try {
    let health;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, `proxy exited before health: ${output}`);
      try { health = await request('/__nesher_pay/health'); break; } catch { await delay(50); }
    }
    assert.ok(health?.ok, `proxy did not become ready: ${output}`);
    const data = await health.json();
    assert.equal(data.build, '2026-09-24-pay-address');
    assert.equal(data.hasDb, false);
    assert.equal(data.hasMercury, false);
    assert.equal(data.hasNmi, false);
    assert.equal(data.paymentPosting, null);
    const unsigned = await request('/__nesher_pay/posting-exceptions');
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.json()).items, undefined);
    const wrongMethod = await request('/__nesher_pay/posting-exceptions', { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  }
});
