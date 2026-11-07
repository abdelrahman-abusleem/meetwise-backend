const path = require('node:path');
require('reflect-metadata');
require('ts-node').register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    target: 'ES2023',
    module: 'CommonJS',
    moduleResolution: 'Node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
  },
});
const root = path.resolve(__dirname, '..');
require('tsconfig-paths').register({
  baseUrl: root,
  paths: require(path.join(root, 'tsconfig.json')).compilerOptions.paths,
});
