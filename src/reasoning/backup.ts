import {
    chmodSync, closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const syncFile = (path: string): void => {
    const fd = openSync(path, constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
};

/** Offline only. Incomplete snapshots have a durable blocker and can never silently be activated. */
export const copyCacheSnapshot = (sourcePath: string, destinationPath: string, _restoring: boolean): void => {
    const source = resolve(sourcePath);
    const destination = resolve(destinationPath);
    if (source === destination || ['', '.secret', '.blocked'].some((suffix) => existsSync(destination + suffix))) {
        throw new Error('Destination must be a new database path');
    }
    if (!existsSync(source) || !existsSync(`${source}.secret`) || existsSync(`${source}.blocked`) ||
        (existsSync(`${source}.guard`) && readFileSync(`${source}.guard`)[0] !== 0)) {
        throw new Error('A healthy source database and secret are required');
    }
    const db = new DatabaseSync(source, { readOnly: false });
    try {
        db.exec('PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN IMMEDIATE; COMMIT;');
        const secret = readFileSync(`${source}.secret`);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(`${destination}.blocked`, 'Incomplete snapshot; do not activate.\n', { flag: 'wx', mode: 0o600 });
        syncFile(`${destination}.blocked`);
        syncFile(dirname(destination));
        const fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        closeSync(fd);
        db.prepare('VACUUM INTO ?').run(destination);
        writeFileSync(`${destination}.secret`, secret, { flag: 'wx', mode: 0o600 });
        chmodSync(destination, 0o600);
    } finally { db.close(); }
    const copied = new DatabaseSync(destination);
    try {
        copied.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE;');
        // Even directly activating a backup must fence; copied history may precede later observations.
        copied.prepare("INSERT INTO metadata(key,value) VALUES ('coverage-gap','1') ON CONFLICT(key) DO UPDATE SET value='1'").run();
        copied.exec('COMMIT;');
    } finally { copied.close(); }
    syncFile(destination);
    syncFile(`${destination}.secret`);
    syncFile(dirname(destination));
    unlinkSync(`${destination}.blocked`);
    syncFile(dirname(destination));
};
