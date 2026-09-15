import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('lockfile contains complete versions and all pinned esbuild platform packages', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  assert.deepEqual(lock.packages[''].engines, pkg.engines);
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!name) continue;
    const entry = value as { version?: string; resolved?: string; integrity?: string };
    assert.match(entry.version ?? '', /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/, `${name}: missing or invalid version`);
    assert(entry.resolved, `${name}: missing resolution`);
    assert(entry.integrity, `${name}: missing integrity`);
  }
  const esbuild = lock.packages['node_modules/esbuild'];
  assert.equal(pkg.dependencies.esbuild, esbuild.version);
  assert.equal(pkg.devDependencies.esbuild, undefined);
  assert.notEqual(esbuild.dev, true, 'esbuild must be installed with --omit=dev');
  for (const [name, version] of Object.entries(esbuild.optionalDependencies)) {
    const entry = lock.packages[`node_modules/${name}`] ?? lock.packages[`node_modules/esbuild/node_modules/${name}`];
    assert(entry, `${name}: missing platform package`);
    assert.equal(entry.version, version, `${name}: incompatible esbuild binary version`);
    assert.equal(entry.optional, true, `${name}: platform package must remain optional`);
    assert.notEqual(entry.dev, true, `${name}: platform binary must be available with --omit=dev`);
  }
  assert(!Object.keys(lock.packages).some(name => /(?:^|\/)node_modules\/tsx(?:\/|$)/.test(name)), 'tsx must not return as a dependency');
});
