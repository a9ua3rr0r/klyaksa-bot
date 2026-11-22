const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startServer } = require('../server.js');

test('public endpoints limit requests and request bodies', async t => {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const previousPort = process.env.PORT;
  process.env.PORT = String(port);
  const server = startServer();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body = '{}') => fetch(`${base}${path}`, { method: 'POST', body });

  for (const [path, limit] of [['/api/activate', 10], ['/api/verify', 60], ['/api/support-ticket', 5]]) {
    for (let i = 0; i < limit; i++) {
      const response = await post(path);
      assert.equal(response.status, 400);
    }
    const limited = await post(path);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await limited.json()).success, false);
  }
  assert.equal((await fetch(`${base}/api/status`)).status, 200);
});

test('oversized bodies return 413 even with chunked transfer', async t => {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const previousPort = process.env.PORT;
  process.env.PORT = String(port);
  const server = startServer();
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/verify', method: 'POST' }, res => {
      res.resume();
      res.on('end', () => resolve(res));
    });
    req.on('error', reject);
    req.write('x'.repeat(65536));
    req.end('x');
  });
  assert.equal(response.statusCode, 413);
});
