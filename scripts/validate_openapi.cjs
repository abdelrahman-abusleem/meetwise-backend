#!/usr/bin/env node

const { readFileSync } = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);

function resolvePointer(root, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('#/'))
    return 'unresolvable-external';
  let node = root;
  for (const segment of pointer.slice(2).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (
      node === null ||
      typeof node !== 'object' ||
      !Object.hasOwn(node, key)
    ) {
      return `missing:${segment}`;
    }
    node = node[key];
  }
  if (node === null || node === undefined) {
    return 'resolves-to-null';
  }
  return null;
}

function collectRefs(node, refs) {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, refs);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref') refs.push(value);
      else collectRefs(value, refs);
    }
  }
}

function requireContainer(schemaName, value, problems) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length === 0
  ) {
    problems.push(`${schemaName}: missing/empty`);
    return false;
  }
  return true;
}

function validateDocument(file, doc, problems) {
  if (typeof doc.openapi !== 'string' || !/^3\.(0|1)\.\d+$/.test(doc.openapi))
    problems.push(
      'openapi: document must declare a supported OpenAPI 3.0.x or 3.1.x version',
    );
  if (typeof (doc.info && doc.info.title) !== 'string' || !doc.info.title)
    problems.push('info.title: missing/not a string');
  if (typeof (doc.info && doc.info.version) !== 'string' || !doc.info.version)
    problems.push('info.version: missing/not a string');
  if (!requireContainer('paths', doc.paths, problems)) return;

  let operations = 0;
  for (const [itemPath, item] of Object.entries(doc.paths)) {
    if (!itemPath.startsWith('/')) {
      problems.push(`paths: entry "${itemPath}" is not a path template`);
      continue;
    }
    if (item === null || typeof item !== 'object') {
      problems.push(`paths.${itemPath}: not an object`);
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!operation || typeof operation !== 'object') {
        problems.push(`${method} ${itemPath}: operation not an object`);
        continue;
      }
      operations += 1;
      if (typeof operation.operationId !== 'string' || !operation.operationId)
        problems.push(`${method} ${itemPath}: missing operationId`);
      if (
        !operation.responses ||
        typeof operation.responses !== 'object' ||
        Object.keys(operation.responses).filter(
          (code) => !code.startsWith('x-'),
        ).length === 0
      ) {
        problems.push(`${method} ${itemPath}: responses block missing/empty`);
      } else {
        for (const [code, response] of Object.entries(operation.responses)) {
          if (code.startsWith('x-')) continue;
          if (code !== 'default' && !/^[1-5](?:[0-9]{2}|XX)$/.test(code))
            problems.push(
              `${method} ${itemPath}: invalid response code ${code}`,
            );
          if (
            !response ||
            typeof response !== 'object' ||
            !response.description
          )
            problems.push(
              `${method} ${itemPath}: response ${code} missing description`,
            );
        }
      }
    }
  }
  if (operations === 0) problems.push('paths: no operations found');

  const refs = [];
  collectRefs(doc, refs);
  for (const ref of refs) {
    const problem = resolvePointer(doc, ref);
    if (problem === 'unresolvable-external')
      problems.push(`$ref: external (non-#/) reference "${ref}"`);
    else if (problem)
      problems.push(`$ref: unresolved reference "${ref}" (${problem})`);
  }

  const schemas =
    doc.components && doc.components.schemas
      ? Object.keys(doc.components.schemas)
      : [];
  return { operations, schemas: schemas.length };
}

function main() {
  const inputs = process.argv.slice(2);
  if (!inputs.length) {
    console.error(
      'usage: node scripts/validate_openapi.cjs <openapi.yaml> [...more]',
    );
    process.exit(1);
  }
  let failed = false;
  for (const input of inputs) {
    const problems = [];
    let doc;
    try {
      doc = yaml.load(readFileSync(path.resolve(input), 'utf8'), {
        schema: yaml.JSON_SCHEMA,
      });
    } catch (error) {
      problems.push(`yaml: could not parse (${error.message || error})`);
    }
    let stats = { operations: 0, schemas: 0 };
    if (doc) {
      const result = validateDocument(input, doc, problems);
      if (result) stats = result;
    }
    if (problems.length) {
      failed = true;
      console.error(`${input}: INVALID`);
      for (const problem of problems) console.error(`  - ${problem}`);
    } else {
      console.log(
        `${input}: structurally valid (paths=${Object.keys(doc.paths).length}, operations=${stats.operations}, schemas=${stats.schemas})`,
      );
    }
  }
  process.exit(failed ? 1 : 0);
}

module.exports = { validateDocument, resolvePointer };
if (require.main === module) main();
