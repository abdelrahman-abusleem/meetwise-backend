const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { composeExportArtifactAdapters } = require(
  process.env.MEETWISE_EXPORT_ADAPTER_BUILD
    ? path.join(
        process.env.MEETWISE_EXPORT_ADAPTER_BUILD,
        'infrastructure/export/export-artifact-adapters.js',
      )
    : '../../libs/meetings/src/infrastructure/export/export-artifact-adapters.ts',
);

async function withOwnedRoot(work) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(
    path.join(parent, 'meetwise-export-composition-'),
  );
  try {
    return await work(root);
  } finally {
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), parent);
    assert.equal(resolved, root);
    assert.ok(path.basename(root).startsWith('meetwise-export-composition-'));
    await fs.rm(resolved, { recursive: true });
    await assert.rejects(fs.stat(resolved), { code: 'ENOENT' });
  }
}

for (const format of ['JSON', 'CSV']) {
  test(`composed ${format} renderer/store publishes exact bytes and concurrent replay converges`, async () => {
    await withOwnedRoot(async (root) => {
      const adapters = composeExportArtifactAdapters(root);
      assert.equal(Object.isFrozen(adapters), true);
      const command = {
        exportId: 'composed-artifact',
        kind: 'SUMMARY',
        format,
        sourceRows: [{ title: 'synthetic, authorized', count: 2 }],
      };
      const { bytes } = await adapters.generator.renderArtifact(command);
      const storeCommand = { ...command, content: bytes };
      const outcomes = await Promise.all([
        adapters.objectStore.storeArtifact(storeCommand),
        adapters.objectStore.storeArtifact(storeCommand),
      ]);
      for (const outcome of outcomes)
        assert.deepEqual(outcome, {
          outcome: 'STORED',
          storageRef: command.exportId,
          byteLength: bytes.length,
        });
      assert.deepEqual(
        await fs.readFile(path.join(root, command.exportId)),
        Buffer.from(bytes),
      );
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(root, command.exportId + '.manifest.json'),
          'utf8',
        ),
      );
      assert.deepEqual(manifest, {
        exportId: command.exportId,
        kind: command.kind,
        format,
        byteLength: bytes.length,
      });
      await assert.rejects(
        adapters.objectStore.storeArtifact({
          ...storeCommand,
          content: Buffer.from('different'),
        }),
        /export-storage-collision/,
      );
      assert.deepEqual(
        await fs.readFile(path.join(root, command.exportId)),
        Buffer.from(bytes),
      );
      assert.equal((await fs.readdir(root)).length, 2);
    });
  });
}

test('explicit root configuration does not provision a missing directory', async () => {
  await withOwnedRoot(async (root) => {
    const absent = path.join(root, 'not-provisioned');
    const adapters = composeExportArtifactAdapters(absent);
    const result = await adapters.objectStore.storeArtifact({
      exportId: 'missing-root',
      kind: 'SUMMARY',
      format: 'JSON',
      content: Buffer.from('[]'),
    });
    assert.deepEqual(result, {
      outcome: 'DECLINED',
      declineReason: 'export-storage-root-missing',
    });
    await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  });
  assert.throws(
    () => composeExportArtifactAdapters(''),
    /export-storage-root-required/,
  );
});

test('render refusal propagates and owned fixture cleanup also runs on failure', async () => {
  let owned;
  await assert.rejects(
    withOwnedRoot(async (root) => {
      owned = root;
      const { generator } = composeExportArtifactAdapters(root);
      await generator.renderArtifact({
        exportId: 'unsupported',
        kind: 'SUMMARY',
        format: 'PDF',
        sourceRows: [],
      });
    }),
    /export-render-format-unsupported/,
  );
  await assert.rejects(fs.stat(owned), { code: 'ENOENT' });
});

test('explicit factory can be resolved through a Nest11 provider without registering an API/worker lane', async () => {
  await withOwnedRoot(async (root) => {
    const { Test } = require('@nestjs/testing');
    const token = Symbol('export-artifact-adapters');
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: token,
          useFactory: () => composeExportArtifactAdapters(root),
        },
      ],
    }).compile();
    try {
      const adapters = module.get(token);
      const { bytes } = await adapters.generator.renderArtifact({
        exportId: 'nest-composed',
        kind: 'SUMMARY',
        format: 'JSON',
        sourceRows: [{ title: 'synthetic' }],
      });
      assert.equal(
        (
          await adapters.objectStore.storeArtifact({
            exportId: 'nest-composed',
            kind: 'SUMMARY',
            format: 'JSON',
            content: bytes,
          })
        ).outcome,
        'STORED',
      );
    } finally {
      await module.close();
    }
  });
});
