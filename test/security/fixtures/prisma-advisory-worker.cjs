const assert = require('node:assert/strict');
const merge = require('deepmerge-ts');
const operation = process.argv[2];
assert(
  [
    'deepmerge',
    'deepmergeCustom',
    'deepmergeInto',
    'deepmergeIntoCustom',
  ].includes(operation),
);
const left = { left: true },
  right = { right: true };
left.self = left;
right.self = right;
let output;
let rejected = false;
try {
  const callable = operation.endsWith('Custom')
    ? merge[operation]({})
    : merge[operation];
  const result = callable(left, right);
  output = operation.startsWith('deepmergeInto') ? left : result;
} catch (error) {
  rejected = true;
  assert(
    !(error instanceof RangeError),
    'Stack exhaustion is not a safe cycle rejection',
  );
  assert.match(error.message, /cyclic|cycle|circular|recursive/i);
}

if (!rejected) {
  assert.equal(output.left, true);
  assert.equal(output.right, true);
  assert.equal(
    output.self,
    output,
    'Cyclic merge must preserve its graph relationship',
  );
}
