const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { createRequire } = require('node:module');

const adapterRequire = createRequire(
  require.resolve('@nestjs/platform-express'),
);
const express = adapterRequire('express');
const multer = adapterRequire('multer');
const scenario = process.argv[2];
const directory = fs.realpathSync(process.argv[3]);
const fixtureRoot = fs.realpathSync(
  path.resolve(__dirname, '../../../.tmp/parser-tests'),
);
assert.equal(path.dirname(directory), fixtureRoot);
assert.match(path.basename(directory), /^case-[a-zA-Z0-9]+$/);

async function until(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Bounded fixture condition did not complete');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withServer(middleware, action) {
  const app = express();
  app.get('/live', (request, response) => response.json({ ok: true }));
  app.post('/', middleware, (request, response) =>
    response.json({ body: request.body, size: request.file?.size ?? null }),
  );
  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    return response
      .status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ code: error.code || 'UPLOAD_ERROR' });
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const port = server.address().port;
  try {
    await action(`http://127.0.0.1:${port}/`, port);
    assert.equal(
      (
        await fetch(`http://127.0.0.1:${port}/live`, {
          signal: AbortSignal.timeout(1000),
        })
      ).status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function requestForm(url, form) {
  const response = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(2500),
  });
  return { status: response.status, body: await response.json() };
}

async function abortDisk(delayed) {
  let filenameStarted = false,
    releaseFilename,
    aborted = false,
    storageSettled = false;
  const writes = [];
  const originalCreate = fs.createWriteStream;
  fs.createWriteStream = function (file, ...args) {
    const stream = originalCreate.call(fs, file, ...args);
    if (path.dirname(path.resolve(file)) === directory) writes.push(stream);
    return stream;
  };
  const storage = multer.diskStorage({
    destination: directory,
    filename(request, file, callback) {
      filenameStarted = true;
      if (delayed)
        releaseFilename = () => callback(null, 'synthetic-upload.txt');
      else callback(null, 'synthetic-upload.txt');
    },
  });
  const handle = storage._handleFile;
  storage._handleFile = function (request, file, callback) {
    return handle.call(this, request, file, (...args) => {
      storageSettled = true;
      callback(...args);
    });
  };
  const upload = multer({ storage }).single('upload');
  try {
    await withServer(
      (request, response, next) => {
        request.once('aborted', () => {
          aborted = true;
        });
        upload(request, response, next);
      },
      async (url, port) => {
        const boundary = 'meetwiseSyntheticBoundary';
        const head = `--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="synthetic.txt"\r\nContent-Type: text/plain\r\n\r\n`;
        const request = http.request({
          host: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': Buffer.byteLength(head) + 4096,
          },
        });
        request.on('error', () => {});
        request.write(head);
        request.write(Buffer.alloc(512, 'x'));
        await until(() =>
          delayed ? filenameStarted : writes.some((stream) => !stream.pending),
        );
        request.destroy();
        await until(() => aborted);
        releaseFilename?.();
        await until(
          () =>
            storageSettled &&
            writes.every((stream) => stream.closed) &&
            fs.readdirSync(directory).length === 0,
        );
      },
    );
  } finally {
    fs.createWriteStream = originalCreate;
  }
}

async function nestUnexpectedFile() {
  require('reflect-metadata');
  const {
    Controller,
    Post,
    UseInterceptors,
    Module: NestModule,
  } = require('@nestjs/common');
  const { NestFactory } = require('@nestjs/core');
  const { FileInterceptor } = require('@nestjs/platform-express');
  class UploadController {
    upload() {
      return { ok: true };
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    UploadController.prototype,
    'upload',
  );
  Controller('upload')(UploadController);
  Post()(UploadController.prototype, 'upload', descriptor);
  UseInterceptors(FileInterceptor('upload'))(
    UploadController.prototype,
    'upload',
    descriptor,
  );
  class UploadModule {}
  NestModule({ controllers: [UploadController] })(UploadModule);
  const app = await NestFactory.create(UploadModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const form = new FormData();
    form.set('other', new Blob(['synthetic']), 'synthetic.txt');
    const response = await requestForm(
      'http://127.0.0.1:' + port + '/upload',
      form,
    );
    assert.equal(response.status, 400);
    assert.equal(response.body.statusCode, 400);
  } finally {
    await app.close();
  }
}

async function main() {
  if (scenario === 'nest-unexpected-file') return nestUnexpectedFile();
  if (scenario === 'abort-disk' || scenario === 'abort-delayed-disk')
    return abortDisk(scenario === 'abort-delayed-disk');
  if (scenario === 'urlencoded') {
    return withServer(express.urlencoded({ extended: true }), async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'name=%3Cguest%3E&values[]=one&values[]=two',
        signal: AbortSignal.timeout(2500),
      });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).body, {
        name: '<guest>',
        values: ['one', 'two'],
      });
    });
  }
  const config = { limits: { fileSize: 16, fieldArrayIndexLimit: 8 } };
  if (scenario === 'async-limit')
    config.fileFilter = (request, file, callback) =>
      setTimeout(() => callback(null, true), 30);
  return withServer(multer(config).single('upload'), async (url) => {
    if (scenario === 'truncated') {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'multipart/form-data; boundary=broken' },
        body: '--broken\r\nContent-Disposition: form-data; name="label"\r\n\r\nunfinished',
        signal: AbortSignal.timeout(2500),
      });
      assert.equal(response.status, 400);
      return;
    }
    const form = new FormData();
    if (scenario === 'fields') form.set('label', 'hello');
    else if (scenario === 'arrays') {
      form.set('items[0]', 'a');
      form.set('items[1]', 'b');
    } else if (scenario === 'oversized-index' || scenario === 'crafted-index') {
      form.set('items[4294967294]', 'a');
      form.set(scenario === 'oversized-index' ? 'items[name]' : 'items[]', 'b');
    } else if (['file', 'unexpected-file', 'async-limit'].includes(scenario)) {
      form.set(
        scenario === 'unexpected-file' ? 'other' : 'upload',
        new Blob([Buffer.alloc(scenario === 'async-limit' ? 64 : 4, 'x')]),
        'synthetic.txt',
      );
    } else throw new Error('Unknown parser fixture scenario');
    const response = await requestForm(url, form);
    if (scenario === 'async-limit') {
      assert.equal(response.status, 413);
      assert.equal(response.body.code, 'LIMIT_FILE_SIZE');
    } else if (scenario === 'unexpected-file') {
      assert.equal(response.status, 400);
      assert.equal(response.body.code, 'LIMIT_UNEXPECTED_FILE');
    } else if (scenario === 'oversized-index' || scenario === 'crafted-index')
      assert.equal(response.status, 400);
    else {
      assert.equal(response.status, 200);
      if (scenario === 'fields')
        assert.deepEqual(response.body.body, { label: 'hello' });
      if (scenario === 'arrays')
        assert.deepEqual(response.body.body, { items: ['a', 'b'] });
      if (scenario === 'file') assert.equal(response.body.size, 4);
    }
  });
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Parser fixture failed',
  );
  process.exitCode = 1;
});
