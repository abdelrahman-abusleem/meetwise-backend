const test = require('node:test');
const assert = require('node:assert/strict');
const { ExportJsonCsvRenderer } = require(
  process.env.MEETWISE_EXPORT_ADAPTER_BUILD
    ? require('node:path').join(
        process.env.MEETWISE_EXPORT_ADAPTER_BUILD,
        'application/export-json-csv-renderer.js',
      )
    : '../../libs/meetings/src/application/export-json-csv-renderer.ts',
);
const renderer = new ExportJsonCsvRenderer();
const command = (row) => ({
  exportId: 'export-boundary',
  kind: 'SUMMARY',
  format: 'JSON',
  sourceRows: [row],
});

test('JSON snapshots enumerable scalar facts without invoking a hidden serialization hook', async () => {
  let calls = 0;
  const row = { title: 'synthetic authorized fact' };
  Object.defineProperty(row, 'toJSON', {
    value() {
      calls++;
      return { title: 'substituted' };
    },
  });
  const result = await renderer.renderArtifact(command(row));
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(Buffer.from(result.bytes).toString()), [
    { title: 'synthetic authorized fact' },
  ]);
});

test('JSON ignores inherited serialization hooks', async () => {
  let calls = 0;
  const row = Object.assign(
    Object.create({
      toJSON() {
        calls++;
        return { title: 'substituted' };
      },
    }),
    { title: 'synthetic authorized fact' },
  );
  const result = await renderer.renderArtifact(command(row));
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(Buffer.from(result.bytes).toString()), [
    { title: 'synthetic authorized fact' },
  ]);
});

test('accessor cells are rejected without invoking them', async () => {
  let calls = 0;
  const row = {};
  Object.defineProperty(row, 'title', {
    enumerable: true,
    get() {
      calls++;
      return 'dynamic';
    },
  });
  await assert.rejects(
    renderer.renderArtifact(command(row)),
    /export-render-source-shape-defect/,
  );
  assert.equal(calls, 0);
});

test('scalar __proto__ field stays an ordinary own JSON fact', async () => {
  const row = JSON.parse('{"__proto__":"synthetic","title":"ordinary"}');
  const result = await renderer.renderArtifact(command(row));
  assert.equal(
    Buffer.from(result.bytes).toString(),
    '[{"__proto__":"synthetic","title":"ordinary"}]',
  );
});

test('a source array cannot replace validation through an overridden map', async () => {
  let calls = 0;
  const cmd = command({ title: 'synthetic' });
  cmd.sourceRows.map = () => {
    calls++;
    return [{ title: 'substituted' }];
  };
  const result = await renderer.renderArtifact(cmd);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(Buffer.from(result.bytes).toString()), [
    { title: 'synthetic' },
  ]);
});

test('accessor array entries are rejected without invoking them', async () => {
  let calls = 0;
  const cmd = command({ title: 'unused' });
  Object.defineProperty(cmd.sourceRows, '0', {
    get() {
      calls++;
      return { title: 'dynamic' };
    },
  });
  await assert.rejects(
    renderer.renderArtifact(cmd),
    /export-render-source-shape-defect/,
  );
  assert.equal(calls, 0);
});
