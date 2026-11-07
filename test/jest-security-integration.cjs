const path = require('node:path');
const { jest: unit } = require('../package.json');

module.exports = {
  ...unit,
  rootDir: path.resolve(__dirname, '..'),
  roots: [
    '<rootDir>/libs/security/test',
    '<rootDir>/libs/infrastructure/queue/test',
  ],
  testRegex: '.*\\.integration-spec\\.ts$',
  testTimeout: 15000,
};
