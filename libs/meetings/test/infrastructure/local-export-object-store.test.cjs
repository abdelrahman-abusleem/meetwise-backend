'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { LocalExportObjectStore } = require(
  process.env.MEETWISE_EXPORT_ADAPTER_BUILD
    ? path.join(
        process.env.MEETWISE_EXPORT_ADAPTER_BUILD,
        'infrastructure/export/local-export-object-store.js',
      )
    : '../../src/infrastructure/export/local-export-object-store.ts',
);

const scratchParent = fs.realpathSync(require('node:os').tmpdir());
const SCRATCH = fs.mkdtempSync(
  path.join(scratchParent, 'meetwise-export-store-'),
);
test.after(() => {
  const resolved = fs.realpathSync(SCRATCH);
  assert.equal(resolved, SCRATCH);
  assert.equal(path.dirname(resolved), scratchParent);
  assert.ok(path.basename(resolved).startsWith('meetwise-export-store-'));
  fs.rmSync(resolved, { recursive: true });
  assert.equal(fs.existsSync(resolved), false);
});

function newRoot(label) {
  return fs.mkdtempSync(path.join(SCRATCH, `glm-store-${label}-`));
}

function bytesOf(text) {
  return new TextEncoder().encode(text);
}

function storeCommand(overrides = {}) {
  return {
    exportId: 'exp-1',
    kind: 'meeting.summary.v1',
    format: 'CSV',
    content: bytesOf('a,b\r\n1,2\r\n'),
    ...overrides,
  };
}

async function rootList(root) {
  return (await fs.promises.readdir(root)).sort();
}

test('construction fails closed on a missing/blank integrator root', () => {
  for (const bad of [
    null,
    undefined,
    {},
    { rootDirectory: '' },
    { rootDirectory: '   ' },
  ]) {
    assert.throws(
      () => new LocalExportObjectStore(bad),
      /export-storage-root-required/,
    );
  }
});

test('STORED: bytes published verbatim under the export identity; manifest carries only non-content facts; ref is the identity (no path, no token)', async () => {
  const root = newRoot('happy');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const content = storeCommand().content;
  const result = await store.storeArtifact(storeCommand());
  assert.deepEqual(result, {
    outcome: 'STORED',
    storageRef: 'exp-1',
    byteLength: content.length,
  });
  const names = await rootList(root);
  assert.deepEqual(
    names,
    ['exp-1', 'exp-1.manifest.json'],
    'no temp fragments remain',
  );
  const durable = await fs.promises.readFile(path.join(root, 'exp-1'));
  assert.equal(
    Buffer.compare(Buffer.from(durable), Buffer.from(content)),
    0,
    'byte-verbatim artifact',
  );
  const manifest = JSON.parse(
    String(await fs.promises.readFile(path.join(root, 'exp-1.manifest.json'))),
  );
  assert.deepEqual(manifest, {
    exportId: 'exp-1',
    kind: 'meeting.summary.v1',
    format: 'CSV',
    byteLength: content.length,
  });
});

test('idempotent re-store of the SAME exportId with the SAME bytes: STORED again, artifact unchanged, manifest not duplicated', async () => {
  const root = newRoot('idem');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const cmd = storeCommand();
  await store.storeArtifact(cmd);
  const before = await fs.promises.readFile(path.join(root, 'exp-1'));
  const result = await store.storeArtifact(cmd);
  assert.equal(result.outcome, 'STORED');
  const after = await fs.promises.readFile(path.join(root, 'exp-1'));
  assert.equal(Buffer.compare(Buffer.from(before), Buffer.from(after)), 0);
  assert.deepEqual(await rootList(root), ['exp-1', 'exp-1.manifest.json']);
});

test('re-store with DIFFERENT bytes for a durably bound exportId THROWS and overwrites NOTHING', async () => {
  const root = newRoot('collision');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const original = storeCommand();
  await store.storeArtifact(original);
  const beforeBytes = await fs.promises.readFile(path.join(root, 'exp-1'));
  await assert.rejects(
    store.storeArtifact(storeCommand({ content: bytesOf('different') })),
    /export-storage-collision/,
  );
  const afterBytes = await fs.promises.readFile(path.join(root, 'exp-1'));
  assert.equal(
    Buffer.compare(Buffer.from(beforeBytes), Buffer.from(afterBytes)),
    0,
    'original intact',
  );
});

test('colliding bytes are also refused across adapter instances (durable identity is the store, not the object)', async () => {
  const root = newRoot('crossinstance');
  const first = new LocalExportObjectStore({ rootDirectory: root });
  const second = new LocalExportObjectStore({ rootDirectory: root });
  await first.storeArtifact(storeCommand({ content: bytesOf('v1') }));
  await assert.rejects(
    second.storeArtifact(storeCommand({ content: bytesOf('v2') })),
    /export-storage-collision/,
  );
});

test('crash recovery: a temp fragment left by a dead process is never mistaken for the artifact; a full re-store publishes it and cleans NOTHING', async () => {
  const root = newRoot('fragments');
  const store = new LocalExportObjectStore({ rootDirectory: root });

  await fs.promises.writeFile(
    path.join(root, 'exp-1.tmp-deadbeef'),
    bytesOf('orphan'),
  );
  const result = await store.storeArtifact(storeCommand());
  assert.equal(result.outcome, 'STORED');
  const names = await rootList(root);
  assert.deepEqual(names, [
    'exp-1',
    'exp-1.manifest.json',
    'exp-1.tmp-deadbeef',
  ]);
  const durable = await fs.promises.readFile(path.join(root, 'exp-1'));
  assert.equal(
    Buffer.compare(Buffer.from(durable), Buffer.from(storeCommand().content)),
    0,
    'the published bytes are the produced bytes, not the fragment',
  );
});

test('crash between artifact publication and manifest publication: re-store completes the manifest and reports STORED', async () => {
  const root = newRoot('manifestcrash');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  await fs.promises.writeFile(path.join(root, 'exp-1'), storeCommand().content);

  const result = await store.storeArtifact(storeCommand());
  assert.deepEqual(result, {
    outcome: 'STORED',
    storageRef: 'exp-1',
    byteLength: 10,
  });
  const manifest = JSON.parse(
    String(await fs.promises.readFile(path.join(root, 'exp-1.manifest.json'))),
  );
  assert.equal(manifest.exportId, 'exp-1');
  assert.equal(manifest.byteLength, 10);
});

test('an INCONSISTENT existing manifest is a loud defect, not a silent repair', async () => {
  const root = newRoot('manifestconflict');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  await store.storeArtifact(storeCommand());
  await fs.promises.writeFile(
    path.join(root, 'exp-1.manifest.json'),
    JSON.stringify({
      exportId: 'exp-1',
      kind: 'OTHER',
      format: 'CSV',
      byteLength: 9,
    }),
  );
  await assert.rejects(
    store.storeArtifact(storeCommand()),
    /export-storage-manifest-conflict/,
  );
});

test('DECLINED: zero-byte content is refused before any filesystem effect', async () => {
  const root = newRoot('empty');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const result = await store.storeArtifact(
    storeCommand({ content: new Uint8Array() }),
  );
  assert.deepEqual(result, {
    outcome: 'DECLINED',
    declineReason: 'export-storage-empty-artifact',
  });
  assert.deepEqual(await rootList(root), [], 'nothing landed');
});

test('DECLINED: a missing store root is a definite local refusal (config duty not met)', async () => {
  const root = path.join(newRoot('rootmissing'), 'gone');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const result = await store.storeArtifact(storeCommand());
  assert.deepEqual(result, {
    outcome: 'DECLINED',
    declineReason: 'export-storage-root-missing',
  });
  assert.ok(!fs.existsSync(root), 'the adapter never creates the root');
});

test('contract defects: unsafe export identity / missing kinds / non-Uint8Array fail closed BEFORE any effect', async () => {
  for (const badId of [
    '../escape',
    'sub/dir',
    'back\\slash',
    'dot..dot',
    'ctrl\u0007id',
    '',
    '   ',
    null,
    42,
  ]) {
    const root = newRoot('unsafe');
    const store = new LocalExportObjectStore({ rootDirectory: root });
    try {
      await store.storeArtifact(storeCommand({ exportId: badId }));
      assert.ok(false, `expected rejection for ${String(badId)}`);
    } catch (error) {
      assert.match(
        String(error.message),
        /export-storage-export-id-(required|unsafe-identity)/,
      );
    }
    assert.deepEqual(await rootList(root), [], 'zero filesystem effects');
  }
  for (const cmd of [
    { exportId: 'x', content: bytesOf('a') },
    storeCommand({ kind: '  ' }),
    storeCommand({ format: '' }),
  ]) {
    const root = newRoot('defect');
    const store = new LocalExportObjectStore({ rootDirectory: root });
    try {
      await store.storeArtifact(cmd);
      assert.ok(false, 'expected rejection');
    } catch (error) {
      assert.match(
        String(error.message),
        /export-storage-(kind|format)-required/,
      );
    }
    assert.deepEqual(await rootList(root), [], 'no partial facts');
  }
});

test('a planted DIRECTORY at the artifact path is a loud not-regular defect (never an incidental raw fs fault, never fabricated, zero effects)', async () => {
  const root = newRoot('iofault');

  await fs.promises.mkdir(path.join(root, 'exp-1'));
  const store = new LocalExportObjectStore({ rootDirectory: root });
  await assert.rejects(
    store.storeArtifact(storeCommand()),
    /export-storage-artifact-path-not-regular/,
  );

  assert.deepEqual(await rootList(root), ['exp-1']);
});

test('a planted DIRECTORY at the MANIFEST path is a loud not-regular defect on the verification path (artifact bytes untouched)', async () => {
  const root = newRoot('manifestdir');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  await store.storeArtifact(storeCommand());

  await fs.promises.rm(path.join(root, 'exp-1.manifest.json'));
  await fs.promises.mkdir(path.join(root, 'exp-1.manifest.json'));
  await assert.rejects(
    store.storeArtifact(storeCommand()),
    /export-storage-manifest-path-not-regular/,
  );
  const durable = await fs.promises.readFile(path.join(root, 'exp-1'));
  assert.equal(
    Buffer.compare(Buffer.from(durable), Buffer.from(storeCommand().content)),
    0,
    'artifact bytes untouched',
  );
});

test('concurrent same-id SAME-bytes stores converge to one published artifact', async () => {
  const root = newRoot('concurrent');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const results = await Promise.all(
    [0, 1, 2, 3].map(() => store.storeArtifact(storeCommand())),
  );
  for (const r of results) {
    assert.equal(r.outcome, 'STORED');
    assert.equal(r.byteLength, 10);
  }

  const names = await rootList(root);
  assert.ok(names.includes('exp-1') && names.includes('exp-1.manifest.json'));
  for (const name of names) {
    if (name !== 'exp-1' && name !== 'exp-1.manifest.json') {
      assert.match(
        name,
        /^exp-1(\.manifest\.json)?\.tmp-[0-9a-f-]{36}$/,
        'every other directory entry is a temp fragment of a converged attempt',
      );
    }
  }
  const durable = await fs.promises.readFile(path.join(root, 'exp-1'));
  assert.equal(
    Buffer.compare(Buffer.from(durable), Buffer.from(storeCommand().content)),
    0,
  );
});

test('concurrent same-id DIVERGENT-bytes stores stay mechanically safe: ONE whole variant owns the final name, no torn or composite artifact, honest verdicts only', async () => {
  const root = newRoot('concdivergent');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  const outcomes = await Promise.allSettled([
    store.storeArtifact(storeCommand({ content: bytesOf('AAAA') })),
    store.storeArtifact(storeCommand({ content: bytesOf('BBBB') })),
  ]);

  for (const settle of outcomes) {
    if (settle.status === 'rejected') {
      assert.match(
        String(settle.reason),
        /export-storage-collision/,
        'a fault stays labeled, never a silent success',
      );
    } else {
      const value = settle.value;
      assert.ok(
        value.outcome === 'STORED',
        `honest outcome expected, got ${value.outcome}`,
      );

      assert.equal(value.byteLength, 4);
    }
  }

  const durable = Buffer.from(
    await fs.promises.readFile(path.join(root, 'exp-1')),
  );
  const finalText = durable.toString('latin1');
  assert.ok(
    finalText === 'AAAA' || finalText === 'BBBB',
    `atomic whole-variant publication expected, got ${JSON.stringify(finalText)}`,
  );

  const manifest = JSON.parse(
    String(await fs.promises.readFile(path.join(root, 'exp-1.manifest.json'))),
  );
  assert.equal(manifest.byteLength, 4);
  assert.ok(manifest.exportId === 'exp-1', 'identity pinned');
});

const { spawn } = require('node:child_process');

function runRacer(scratch, adapterPath, root, exportId, variantText, gatePath) {
  const racerPath = path.join(scratch, `glm-racer-${variantText}.cjs`);
  fs.writeFileSync(
    racerPath,
    [
      "'use strict';",
      "const fs = require('node:fs');",
      `const { LocalExportObjectStore } = require(${JSON.stringify(adapterPath)});`,
      `const [root, exportId, text, gate] = ${JSON.stringify([
        root,
        exportId,
        variantText,
        gatePath,
      ])};`,
      'const deadline = Date.now() + 30000;',
      'while (!fs.existsSync(gate)) { if (Date.now() > deadline) process.exit(2); }',
      `const store = new LocalExportObjectStore({ rootDirectory: root });`,
      "store.storeArtifact({ exportId, kind: 'meeting.summary.v1', format: 'CSV', content: Buffer.from(text, 'latin1') })",
      "  .then((outcome) => { process.stdout.write('OK ' + text + ' ' + JSON.stringify(outcome)); process.exit(0); })",
      "  .catch((error) => { process.stderr.write('ERR ' + String((error && error.message) || error)); process.exit(1); });",
      '',
    ].join('\n'),
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [racerPath], { timeout: 45000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('close', (code) => {
      resolve({ code, out, err });
    });
  });
}

test(
  'review regression, TRUE cross-process divergent race: the no-clobber link primitive lets exactly ONE variant win, the loser exits with the collision defect, and NOTHING is ever replaced',
  { timeout: 90000 },
  async () => {
    const root = newRoot('crossprocess');
    const gate = path.join(SCRATCH, `glm-race-gate-${Date.now()}.tmp`);
    const adapterAbs = process.env.MEETWISE_EXPORT_ADAPTER_BUILD
      ? path.join(
          process.env.MEETWISE_EXPORT_ADAPTER_BUILD,
          'infrastructure/export/local-export-object-store.js',
        )
      : path.resolve(
          __dirname,
          '../../src/infrastructure/export/local-export-object-store.ts',
        );
    const racers = [
      runRacer(SCRATCH, adapterAbs, root, 'exp-race', 'AAAA', gate),
      runRacer(SCRATCH, adapterAbs, root, 'exp-race', 'BBBB', gate),
    ];

    await new Promise((r) => setTimeout(r, 700));
    fs.writeFileSync(gate, 'go');
    try {
      const results = await Promise.all(racers);
      const winners = results.filter((r) => r.code === 0);
      const losers = results.filter((r) => r.code !== 0);
      assert.equal(winners.length, 1, 'exactly one store wins');
      assert.equal(losers.length, 1, 'exactly one store loses');
      const winnerText = winners[0].out.startsWith('OK ')
        ? winners[0].out.slice(3, 7)
        : '';
      assert.match(
        winners[0].out,
        /"outcome":"STORED"/,
        `winner output: ${winners[0].out}`,
      );
      assert.equal(winners[0].out.includes('"byteLength":4'), true);
      assert.match(losers[0].err, /ERR export-storage-collision/);

      assert.equal(
        winners[0].out,
        `OK ${winnerText} {"outcome":"STORED","storageRef":"exp-race","byteLength":4}`,
        'winner report exact',
      );
      const durable = Buffer.from(
        await fs.promises.readFile(path.join(root, 'exp-race')),
      ).toString('latin1');
      assert.equal(
        durable,
        winnerText,
        'the winner variant owns the final name exclusively',
      );
      const manifest = JSON.parse(
        String(
          await fs.promises.readFile(path.join(root, 'exp-race.manifest.json')),
        ),
      );
      assert.equal(manifest.byteLength, durable.length);

      const names = await rootList(root);
      assert.deepEqual(names, ['exp-race', 'exp-race.manifest.json']);
    } finally {
      for (const name of ['AAAA', 'BBBB']) {
        fs.rmSync(path.join(SCRATCH, `glm-racer-${name}.cjs`), {
          force: true,
        });
      }
      fs.rmSync(gate, { force: true });
    }
  },
);

test('review regression: a junction planted at the artifact name is a loud storage defect — no content is ever trusted THROUGH it, zero adapter writes', async () => {
  const root = newRoot('junction');

  fs.symlinkSync(root, path.join(root, 'exp-1'), 'junction');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  try {
    await store.storeArtifact(storeCommand());
    assert.ok(false, 'expected the not-regular storage defect');
  } catch (error) {
    assert.match(
      String(error.message),
      /export-storage-artifact-path-not-regular/,
    );
  }
  assert.deepEqual(
    await rootList(root),
    ['exp-1'],
    'the adapter created nothing (no temp, no artifact, no manifest)',
  );
  fs.rmSync(path.join(root, 'exp-1'), { force: true });
});

test('review regression: a junction planted at the manifest name is loud too; artifact bytes stay untouched and STORED is never fabricated', async () => {
  const root = newRoot('junctionmanifest');
  const store = new LocalExportObjectStore({ rootDirectory: root });
  await store.storeArtifact(storeCommand());
  const artifactBefore = await fs.promises.readFile(path.join(root, 'exp-1'));

  fs.rmSync(path.join(root, 'exp-1.manifest.json'), { force: true });
  fs.symlinkSync(root, path.join(root, 'exp-1.manifest.json'), 'junction');
  try {
    await assert.rejects(
      store.storeArtifact(storeCommand()),
      /export-storage-manifest-path-not-regular/,
    );
    const artifactAfter = await fs.promises.readFile(path.join(root, 'exp-1'));
    assert.equal(
      Buffer.compare(Buffer.from(artifactBefore), Buffer.from(artifactAfter)),
      0,
      'artifact untouched',
    );
    const names = await rootList(root);
    assert.deepEqual(
      names,
      ['exp-1', 'exp-1.manifest.json'],
      'no temp fragments (own temps are best-effort cleaned)',
    );
  } finally {
    fs.rmSync(path.join(root, 'exp-1.manifest.json'), {
      force: true,
    });
  }
});

test('review regression: Win32-reserved device names, trailing dot/space aliases, the bare dot, NTFS colon streams and adapter-temp-namespace shadows are rejected as unsafe (any of these would alias distinct identities onto one file or collide with the temp namespace)', async () => {
  for (const unsafeId of [
    'CON',
    'nul',
    'com1',
    'COM9',
    'lpt4',
    'CON.txt',
    'nul.json',
    'exp-1.',
    'exp-1 ',
    '.',

    'fnv1a64:0a1b',
    'a:b',

    'exp-1.tmp-0a1b',
    '.tmp-orphan',

    'exp-1.manifest.json',

    'clock$',
    'CLOCK$',
  ]) {
    const root = newRoot('reserved');
    const store = new LocalExportObjectStore({ rootDirectory: root });
    try {
      await store.storeArtifact(storeCommand({ exportId: unsafeId }));
      assert.ok(false, `expected rejection for ${JSON.stringify(unsafeId)}`);
    } catch (error) {
      assert.match(
        String(error.message),
        /export-storage-export-id-unsafe-identity/,
      );
    }
    assert.deepEqual(await rootList(root), [], 'zero effects');
  }
});

test('review regression: a root path that is a FILE is a definite DECLINED refusal, and the file is never damaged', async () => {
  const holder = newRoot('rootfile');
  const fileRoot = path.join(holder, 'not-a-dir');
  await fs.promises.writeFile(fileRoot, 'keep');
  const store = new LocalExportObjectStore({ rootDirectory: fileRoot });
  const result = await store.storeArtifact(storeCommand());
  assert.deepEqual(result, {
    outcome: 'DECLINED',
    declineReason: 'export-storage-root-missing',
  });
  assert.equal(
    (await fs.promises.readFile(fileRoot)).toString(),
    'keep',
    'the file occupying the root path was never replaced',
  );
});
