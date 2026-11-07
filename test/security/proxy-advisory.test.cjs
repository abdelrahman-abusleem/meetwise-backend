const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const adapterRequire = createRequire(
  require.resolve('@nestjs/platform-express'),
);
const expressPath = adapterRequire.resolve('express');
const express = adapterRequire('express');
const expressRequire = createRequire(expressPath);
const proxyaddr = expressRequire('proxy-addr');

for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
  test(`does not trust unrelated IPv4 peers through short IPv6 subnet ${subnet}`, () => {
    const trust = proxyaddr.compile(subnet);
    for (const address of ['198.51.100.7', '127.0.0.1', '10.2.3.4'])
      assert.equal(
        trust(address),
        false,
        `${subnet} unexpectedly trusts ${address}`,
      );
  });
  test(`ignores spoofed forwarded IP from an untrusted peer under ${subnet}`, () => {
    const peer = '198.51.100.7';
    const request = {
      socket: { remoteAddress: peer },
      headers: { 'x-forwarded-for': '203.0.113.42' },
    };
    assert.equal(proxyaddr(request, proxyaddr.compile(subnet)), peer);
  });
}

for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
  test(`preserves genuine IPv4/mapped subnet matching for ${subnet}`, () => {
    const trust = proxyaddr.compile(subnet);
    assert.equal(trust('10.2.3.4'), true);
    assert.equal(trust('::ffff:10.2.3.4'), true);
    assert.equal(trust('198.51.100.7'), false);
    assert.equal(trust('::ffff:198.51.100.7'), false);
  });
}

test('preserves native IPv6 subnet matching', () => {
  const trust = proxyaddr.compile('2001:db8::/32');
  assert.equal(trust('2001:db8::7'), true);
  assert.equal(trust('2001:db9::7'), false);
  assert.equal(trust('198.51.100.7'), false);
});

async function reportedClientIp(trustProxy) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/', (request, response) => response.json({ ip: request.ip }));
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, {
      headers: { 'x-forwarded-for': '203.0.113.42', connection: 'close' },
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    return (await response.json()).ip;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

for (const trustProxy of [false, '::ffff:10.0.0.0/8', '::/1']) {
  test(`Express denies spoofed forwarded header when trust proxy is ${trustProxy}`, async () => {
    assert.equal(await reportedClientIp(trustProxy), '127.0.0.1');
  });
}

test('Express honors a correctly configured trusted loopback proxy', async () => {
  assert.equal(await reportedClientIp('127.0.0.0/8'), '203.0.113.42');
});
