import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
    readdirSync, rmdirSync, statfsSync, unlinkSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

const snapshotFileNames = new Set(['snapshot.tmp', 'snapshot.tmp-journal', 'snapshot.tmp-wal', 'snapshot.tmp-shm',
    'snapshot.sqlite', 'snapshot.sqlite-wal', 'snapshot.sqlite-shm']);

function assertPrivateDirectory(path: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()
        || (stat.mode & 0o777) !== 0o700) throw new Error('Unsafe inspection directory');
}

/** Reject symlink ancestors; only a root-owned sticky ancestor (e.g. /tmp) may be publicly writable. */
function assertSafeParent(path: string): void {
    const root = parse(path).root;
    for (let current = path; ; current = dirname(current)) {
        const stat = lstatSync(current);
        const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !stickyRoot)
            || (stat.uid !== 0 && stat.uid !== process.getuid?.())) throw new Error('Unsafe inspection parent');
        if (current === root) break;
    }
    assertPrivateDirectory(path);
}

export function syncInspectionDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

function snapshotFiles(directory: string): string[] {
    assertPrivateDirectory(directory);
    const paths = readdirSync(directory).map((name) => {
        if (!snapshotFileNames.has(name)) throw new Error('Unexpected inspection snapshot contents');
        const path = join(directory, name);
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
            || (stat.mode & 0o077) !== 0) throw new Error('Unsafe inspection snapshot file');
        return path;
    });
    return paths;
}

export function removeInspectionDirectory(directory: string): void {
    for (const path of snapshotFiles(directory)) unlinkSync(path);
    rmdirSync(directory);
    syncInspectionDirectory(dirname(directory));
}

export function availableInspectionBytes(path: string): number {
    // Configured snapshot directories may not exist yet. Check their filesystem before mkdir.
    let current = resolve(path);
    for (;;) {
        try {
            const stat = statfsSync(current, { bigint: true });
            return Number(stat.bavail * stat.bsize);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error;
            current = dirname(current);
        }
    }
}

/** Dedicated namespace: reject unexpected data instead of deleting anything we do not own. */
export function createInspectionDestination(sourcePath: string, configuredDirectory?: string) {
    if (!configuredDirectory) assertSafeParent(dirname(resolve(sourcePath)));
    const root = configuredDirectory ? resolve(configuredDirectory) : join(dirname(resolve(sourcePath)), 'inspection');
    // Walk existing ancestors before creating anything: no mkdir through a symlink.
    const ensureParent = (directory: string): void => {
        try {
            const stat = lstatSync(directory);
            const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
            if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !stickyRoot) ||
                (stat.uid !== 0 && stat.uid !== process.getuid?.())) throw new Error('Unsafe inspection parent');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const parent = dirname(directory);
            if (parent === directory) throw new Error('Inspection parent unavailable');
            ensureParent(parent);
            mkdirSync(directory, { mode: 0o700 });
            syncInspectionDirectory(parent);
        }
    };
    const parent = dirname(root);
    // Validate every ancestor, including existing ones; only the final root must be 0700.
    for (let current = parent; ; current = dirname(current)) {
        ensureParent(current);
        if (current === parse(current).root) break;
    }
    try { mkdirSync(root, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    assertPrivateDirectory(root);
    // Previously returned snapshots belong to the operator. Do not scan, touch or
    // delete them; only this invocation's private partial directory may be cleaned up.
    const directory = join(root, randomUUID());
    mkdirSync(directory, { mode: 0o700 });
    try {
        assertPrivateDirectory(directory);
        syncInspectionDirectory(root);
        syncInspectionDirectory(parent);
        const temporaryPath = join(directory, 'snapshot.tmp');
        const path = join(directory, 'snapshot.sqlite');
        const fd = openSync(temporaryPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const identity = fstatSync(fd);
        return { directory, temporaryPath, path, fd, identity };
    } catch (error) {
        removeInspectionDirectory(directory);
        throw error;
    }
}
