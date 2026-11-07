const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const toolingRequire = createRequire(require.resolve('ts-jest'));
const Handlebars = toolingRequire('handlebars');

function blockAst() {
  return Handlebars.parse('{{#if enabled}}safe{{/if}}');
}

test('rejects object-shaped block parameters before compiling them into JavaScript', () => {
  const ast = blockAst();
  ast.body[0].program.blockParams = { length: '(1 + 1)' };

  assert.throws(() => Handlebars.precompile(ast));
});

test('rejects a non-string StringLiteral under stringParams', () => {
  const ast = Handlebars.parse('{{helper "safe"}}');
  ast.body[0].params[0].value = 7;
  assert.throws(() => Handlebars.precompile(ast, { stringParams: true }));
});

test('rejects malformed depth on non-PathExpression parameters', () => {
  const ast = Handlebars.parse('{{helper "safe"}}');
  ast.body[0].params[0].depth = '0 + 1';
  assert.throws(() => Handlebars.precompile(ast, { stringParams: true }));
});

test('safely quotes non-string path originals in generated source', () => {
  const ast = Handlebars.parse('{{helper value}}');
  const marker = 'MEETWISE_SAFE_MARKER';
  ast.body[0].params[0].original = [marker];
  const output = Handlebars.precompile(ast, { stringParams: true });

  assert.equal(output.includes(JSON.stringify(marker)), true);
});

test('blocks Function constructor lookup through its own prototype property', () => {
  const engine = Handlebars.create();
  engine.registerHelper('inspection', (value) =>
    value === undefined ? 'blocked' : 'reachable',
  );
  const template = engine.compile(
    '{{inspection (lookup (lookup fn "__proto__") "constructor")}}',
  );
  const output = template(
    { fn: function harmlessContextFunction() {} },
    { allowProtoMethodsByDefault: true },
  );
  assert.equal(output, 'blocked');
});

test('does not emit literal script terminators in inline precompiled template source', () => {
  const output = Handlebars.precompile(
    'text</script><span>synthetic text</span>',
  );
  assert.equal(/<\/script/i.test(output), false);
});

test('still renders ordinary templates and escapes untrusted text', () => {
  assert.equal(
    Handlebars.compile('Hello {{name}}')({ name: '<guest>' }),
    'Hello &lt;guest&gt;',
  );
});

test('still renders legitimate parsed ASTs with block parameters', () => {
  const ast = Handlebars.parse('{{#each values as |value|}}{{value}}{{/each}}');
  assert.equal(Handlebars.compile(ast)({ values: ['a', 'b'] }), 'ab');
});

test('does not expose inherited constructor properties by default', () => {
  const engine = Handlebars.create();
  engine.registerHelper('inspection', (value) =>
    value === undefined ? 'blocked' : 'reachable',
  );
  assert.equal(
    engine.compile('{{inspection (lookup value "constructor")}}')({
      value: {},
    }),
    'blocked',
  );
});
