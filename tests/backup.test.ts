import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { copyCacheSnapshot } from '../src/reasoning/backup.ts';
import { ReplayStore } from '../src/reasoning/store.ts';

test('offline snapshots preserve secret, refuse owner and never overwrite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'replay-backup-'));
    const path = join(directory, 'source.sqlite');
    const options = { path, idleDays: 30, diskBytes: 1e7, reserveBytes: 1, memoryBytes: 1e6, maxEntryBytes: 1e6 };
    try {
        const store = new ReplayStore(options);
        store.ensureScope({ digest: 'scope', credential: 'credential', model: 'test', caller: 'caller' });
        assert.throws(() => copyCacheSnapshot(path, join(directory, 'locked.sqlite'), false));
        store.close();
        const backup = join(directory, 'backup.sqlite');
        copyCacheSnapshot(path, backup, false);
        assert.deepEqual(readFileSync(`${path}.secret`), readFileSync(`${backup}.secret`));
        assert.equal(existsSync(`${backup}.blocked`), false);
        const snapshot = new DatabaseSync(backup);
        assert.equal(snapshot.prepare("SELECT value FROM metadata WHERE key='coverage-gap'").get()?.value, '1');
        snapshot.close();
        assert.throws(() => copyCacheSnapshot(path, backup, false));
        const destination = join(directory, 'restore.sqlite');
        copyCacheSnapshot(backup, destination, true);
        const restored = new ReplayStore({ ...options, path: destination });
        assert.equal(restored.ensureScope({ digest: 'scope', credential: 'credential', model: 'test', caller: 'caller' }), 2);
        restored.close();
        writeFileSync(`${destination}.blocked`, 'Interrupted publication', { mode: 0o600 });
        assert.throws(() => new ReplayStore({ ...options, path: destination }), /recovery/);
        assert.throws(() => copyCacheSnapshot(destination, join(directory, 'unsafe.sqlite'), true), /healthy/);
        writeFileSync(`${path}.guard`, Buffer.from([1]));
        assert.throws(() => copyCacheSnapshot(path, join(directory, 'unsafe-guard.sqlite'), false), /healthy/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
