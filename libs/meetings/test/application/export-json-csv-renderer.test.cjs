'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { ExportJsonCsvRenderer } = require(
  process.env.MEETWISE_EXPORT_ADAPTER_BUILD
    ? require('node:path').join(
        process.env.MEETWISE_EXPORT_ADAPTER_BUILD,
        'application/export-json-csv-renderer.js',
      )
    : '../../src/application/export-json-csv-renderer.ts',
);

const RENDERER = new ExportJsonCsvRenderer();

function cmd(overrides = {}) {
  return {
    exportId: 'req_abc123',
    kind: 'ANALYSIS',
    format: 'JSON',
    sourceRows: [
      { itemId: 'i-1', status: 'APPROVED', score: 7, fixed: false, note: null },
      {
        itemId: 'i-2',
        status: 'NEEDS_EDITS',
        score: 3.5,
        fixed: true,
        note: 'edit, before "committing"\nnext line',
      },
    ],
    ...overrides,
  };
}

const bytesToText = (bytes) => Buffer.from(bytes).toString('utf8');

test('JSON: artifact bytes are the verbatim bundle (mechanical, no report schema)', async () => {
  const { bytes } = await RENDERER.renderArtifact(cmd());
  const parsed = JSON.parse(bytesToText(bytes));
  assert.deepEqual(parsed, cmd().sourceRows);

  assert.ok(!bytesToText(bytes).includes('req_abc123'));
  assert.ok(!bytesToText(bytes).includes('"kind"'));

  assert.equal(bytes[0], 0x5b);
});

test('JSON: scalar fidelity incl. null, booleans, numbers and unicode roundtrip', async () => {
  const rows = [
    {
      a: null,
      b: true,
      c: false,
      d: 0,
      e: 1.5,
      f: '',
      g: 'unicode 临文本 é "\n\r\t',
      h: '\u2028\u2029',
    },
  ];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'JSON', sourceRows: rows }),
  );
  assert.deepEqual(JSON.parse(bytesToText(bytes)), rows);
});

test('JSON: two renders of identical input are byte-identical', async () => {
  const one = await RENDERER.renderArtifact(cmd());
  const two = await RENDERER.renderArtifact(cmd());
  assert.deepEqual(one.bytes, two.bytes);
});

test('CSV: sorted-union header, preserved row order, exact mechanical text', async () => {
  const rows = [
    { b: 1, a: 'x' },
    { b: 2, a: 'y', aExtra: null },
  ];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(
    bytesToText(bytes),

    'a,aExtra,b\r\nx,,1\r\ny,,2\r\n',
  );
});

test('CSV: special characters quote and escape exactly per RFC4180 rules', async () => {
  const rows = [
    { comma: 'a,b', quote: 'say "hi"', crlf: 'r1\r\nr2', plain: 'ok' },
  ];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(
    bytesToText(bytes),

    'comma,crlf,plain,quote\r\n"a,b","r1\r\nr2",ok,"say ""hi"""\r\n',
  );
});

test('CSV: cell-type mapping is canonical and locale-independent', async () => {
  const rows = [
    {
      intVal: 42,
      floatVal: 1.5,
      bigPrecise: '1.30000000000000004',
      bool: true,
      boolNo: false,
      emptyStr: '',
      nullVal: null,
    },
  ];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(
    bytesToText(bytes),
    'bigPrecise,bool,boolNo,emptyStr,floatVal,intVal,nullVal\r\n' +
      '1.30000000000000004,true,false,"",1.5,42,\r\n',
  );
});

test('CSV: empty bundle composes zero bytes (fail-closed against the orchestrator artifact rule)', async () => {
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: [] }),
  );
  assert.equal(bytes.length, 0);
});

test('CSV: formula-injection trigger strings are apostrophe-patched (strings only; JSON untouched)', async () => {
  const rows = [{ eq: '=1+1', plus: '+SUM(A1:A2)', at: '@cmd', tab: '\tTAB' }];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(
    bytesToText(bytes),
    "at,eq,plus,tab\r\n'@cmd,'=1+1,'+SUM(A1:A2),'\tTAB\r\n",
  );

  const jsonText = bytesToText(
    (await RENDERER.renderArtifact(cmd({ format: 'JSON', sourceRows: rows })))
      .bytes,
  );
  assert.deepEqual(JSON.parse(jsonText), rows);
  assert.ok(!jsonText.includes("'"));
});

test('CSV: quoted formula cells are BOTH guarded and RFC4180-quoted (quoting alone does not neutralize)', async () => {
  const rows = [{ hyper: '=HYPERLINK("http://x")' }];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(bytesToText(bytes), 'hyper\r\n"\'=HYPERLINK(""http://x"")"\r\n');
});

test('CSV: the guard never touches numeric facts (a negative number stays canonical, not text)', async () => {
  const rows = [{ score: -1, ratio: -0.5, tag: '=-1+cmd' }];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(bytesToText(bytes), "ratio,score,tag\r\n-0.5,-1,'=-1+cmd\r\n");
});

test('CSV: lead-CR strings guarded+quoted; lone CR inside a cell stays quoted; bare tab stays unquoted (QA-7C-03 pin)', async () => {
  const rows = [{ leadCr: '\rX', loneCr: 'r1\rr2', embeddedTab: 'a\tb' }];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );

  assert.equal(
    bytesToText(bytes),
    'embeddedTab,leadCr,loneCr\r\n' + 'a\tb,"\'\rX","r1\rr2"\r\n',
  );
});

test('CSV: header names trigger the guard too (a header cannot execute formulas)', async () => {
  const rows = [{ '=A1': 'payload', ok: 1 }];
  const { bytes } = await RENDERER.renderArtifact(
    cmd({ format: 'CSV', sourceRows: rows }),
  );
  assert.equal(bytesToText(bytes), "'=A1,ok\r\npayload,1\r\n");
});

test('CSV/QA-7C-02: an own __proto__ scalar property is serialized byte-faithfully and as a literal column; non-scalar is refused', async () => {
  const crafted = JSON.parse('{"__proto__":"scalar-fact","other":1}');
  const jsonText = bytesToText(
    (await RENDERER.renderArtifact(cmd({ sourceRows: [crafted] }))).bytes,
  );
  assert.deepEqual(JSON.parse(jsonText), [crafted]);
  const csvText = bytesToText(
    (
      await RENDERER.renderArtifact(
        cmd({ format: 'CSV', sourceRows: [crafted] }),
      )
    ).bytes,
  );

  assert.equal(csvText, '__proto__,other\r\nscalar-fact,1\r\n');
  const craftedObject = JSON.parse('{"__proto__":{"deep":1}}');
  await assert.rejects(
    RENDERER.renderArtifact(cmd({ sourceRows: [craftedObject] })),
    /export-render-source-shape-defect/,
  );
});

test('unsupported kind/format refuses loudly: PDF deliberately unsupported by this candidate', async () => {
  await assert.rejects(
    RENDERER.renderArtifact(cmd({ format: 'PDF' })),
    /export-render-format-unsupported/,
  );
  await assert.rejects(
    RENDERER.renderArtifact(cmd({ kind: 'UNKNOWN', format: 'JSON' })),
    /export-render-format-unsupported/,
  );
  await assert.rejects(
    RENDERER.renderArtifact(cmd({ format: 'XLSX' })),
    /export-render-format-unsupported/,
  );
});

test('command shape refuses are loud, before any byte composition', async () => {
  for (const bad of [
    null,
    undefined,
    'x',
    { ...cmd(), exportId: '' },
    { ...cmd(), exportId: 5 },
    { ...cmd(), kind: 12 },
    { ...cmd(), format: null },
  ]) {
    await assert.rejects(
      RENDERER.renderArtifact(bad),
      /export-render-command-shape-defect/,
    );
  }
});

test('source bundle shape defects are loud (row and cell level)', async () => {
  for (const badRows of [
    'rows',
    null,
    [[1], [2]],
    [{ ok: 1 }, 42],
    [{ nested: { deep: 1 } }],
    [{ arr: [] }],
    [{ undef: undefined }],
    [{ notFinite: NaN }],
    [{ notFinite: Infinity }],
    [{ fun: () => 1 }],
  ]) {
    await assert.rejects(
      RENDERER.renderArtifact(cmd({ sourceRows: badRows })),
      /export-render-source-shape-defect/,
    );
  }
});

test('mixed valid+invalid bundle is refused BEFORE any byte (no partial artifacts)', async () => {
  const rows = [{ ok: 1 }, { broken: new Map([['x', 1]]) }];
  await assert.rejects(
    RENDERER.renderArtifact(cmd({ format: 'CSV', sourceRows: rows })),
    /export-render-source-shape-defect/,
  );
});

test('result carries ONLY the frozen bytes fact', async () => {
  const result = await RENDERER.renderArtifact(cmd({ format: 'CSV' }));
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(Object.keys(result), ['bytes']);
  assert.ok(result.bytes instanceof Uint8Array);
  assert.ok(result.bytes.length > 0);
});
