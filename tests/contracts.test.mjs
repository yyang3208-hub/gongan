import { test } from 'node:test';
import assert from 'node:assert/strict';

test('package exposes build and test commands', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(pkg.scripts.build);
  assert.ok(pkg.scripts.test);
});
