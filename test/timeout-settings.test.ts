import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/store';
import { defaultConfiguration } from '../src/shared/defaults';

test('timeout defaults to ten minutes and migrates the former default only once', () => {
  for (const oldValue of [undefined, 180, 900]) {
    const directory = mkdtempSync(path.join(tmpdir(), 'teamytime-timeout-'));
    let store: Store | undefined;
    try {
      if (oldValue !== undefined) {
        const db = new DatabaseSync(path.join(directory, 'teamytime.sqlite'));
        const config = structuredClone(defaultConfiguration); config.cli.timeoutSeconds = oldValue;
        db.exec('CREATE TABLE config (id INTEGER PRIMARY KEY, json TEXT NOT NULL)');
        db.prepare('INSERT INTO config VALUES (1,?)').run(JSON.stringify(config)); db.close();
      }
      store = new Store(directory);
      assert.equal(store.config().cli.timeoutSeconds, oldValue === 900 ? 900 : 600);
      const config = store.config(); config.cli.timeoutSeconds = 180; store.saveConfig(config);
      store.close(); store = undefined;
      store = new Store(directory); assert.equal(store.config().cli.timeoutSeconds, 180);
    } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
