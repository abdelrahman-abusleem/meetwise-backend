const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const adapter = createRequire(require.resolve('@nestjs/platform-express'));
const scenario = process.argv[2];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function compressedJson(late, invalidCharset = false, lateFault = false) {
  const express = adapter('express');
  const app = express();
  let client;
  let parsed = false;
  if (lateFault)
    app.use((req, res, next) => {
      const pipe = req.pipe;
      req.pipe = function (destination, ...options) {
        req.fixtureDecoder = destination;
        return pipe.call(this, destination, ...options);
      };
      next();
    });
  if (invalidCharset)
    app.use(
      express.text({
        defaultCharset: 'synthetic-unsupported-charset',
        verify() {},
      }),
    );
  else app.use(express.json());
  app.post('/', (req, res) => {
    parsed = true;
    if (late) client.end(Buffer.alloc(256, 0x7f));
    if (lateFault) {
      assert.ok(req.fixtureDecoder, 'Real decompression stream was observed');
      setImmediate(() =>
        req.fixtureDecoder.emit(
          'error',
          new Error('Synthetic late decoder failure'),
        ),
      );
    }
    res.json(req.body);
  });
  app.get('/alive', (req, res) => res.sendStatus(204));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const data = invalidCharset
      ? Buffer.from('synthetic invalid compressed bytes')
      : zlib.deflateSync(Buffer.from('{"probe":"synthetic"}'));
    const first = late ? Buffer.concat([data, Buffer.from([0])]) : data;
    const response = await new Promise((resolve, reject) => {
      client = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/',
          method: 'POST',
          agent: false,
          headers: {
            'Content-Type': invalidCharset ? 'text/plain' : 'application/json',
            'Content-Encoding': 'deflate',
            'Content-Length': first.length + (late ? 256 : 0),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, text }));
          res.on('error', reject);
        },
      );
      client.on('error', reject);
      client.setTimeout(2000, () =>
        client.destroy(new Error('Fixture request timeout')),
      );
      if (late) client.write(first);
      else client.end(first);
    });
    assert.equal(parsed, !invalidCharset);
    assert.equal(response.status, invalidCharset ? 415 : 200);
    if (!invalidCharset)
      assert.deepEqual(JSON.parse(response.text), { probe: 'synthetic' });
    await pause(50);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${server.address().port}/alive`, {
          signal: AbortSignal.timeout(1000),
        })
      ).status,
      204,
    );
  } finally {
    client?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function uploadTeardown() {
  const multer = adapter('multer');
  const input = new PassThrough();
  const boundary = 'MeetWiseSecurityFixture';
  const body = [
    '--' + boundary,
    'Content-Disposition: form-data; name="pending"; filename="pending.txt"',
    'Content-Type: text/plain',
    '',
    'pending payload',
    '--' + boundary,
    'Content-Disposition: form-data; name="denied"; filename="denied.txt"',
    'Content-Type: text/plain',
    '',
    'denied payload',
  ].join('\r\n');
  input.headers = {
    'content-type': 'multipart/form-data; boundary=' + boundary,
    'content-length': Buffer.byteLength(body),
  };
  let resume;
  let completions = 0;
  const rejection = new Error('Synthetic upload denied');
  const upload = multer({
    fileHwm: 1,
    fileFilter(req, file, done) {
      if (file.fieldname === 'pending') resume = done;
      else req.once('end', () => setImmediate(() => done(rejection)));
    },
  }).any();
  await new Promise((resolve, reject) => {
    upload(input, {}, (error) => {
      try {
        completions++;
        assert.equal(error, rejection);
        assert.equal(typeof resume, 'function');
        setImmediate(() => {
          resume(null, false);
          resolve();
        });
      } catch (failure) {
        reject(failure);
      }
    });
    input.end(body);
  });
  await pause(50);
  assert.equal(completions, 1);
  assert.deepEqual(input.files, []);
  input.destroy();
}

(async () => {
  if (scenario === 'deflate-late') await compressedJson(true);
  else if (scenario === 'deflate-control') await compressedJson(false);
  else if (scenario === 'unsupported-charset')
    await compressedJson(false, true);
  else if (scenario === 'decoder-late-error')
    await compressedJson(false, false, true);
  else if (scenario === 'upload-late-filter') await uploadTeardown();
  else throw new Error('Unknown bounded fixture');
  console.log('PARSER_TEARDOWN_FIXTURE_OK ' + scenario);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
