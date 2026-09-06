import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';

export const DEFAULT_ADMIN_SOCKET_PATH = join('data', 'admin', 'relay-admin.sock');

/** Resolving a default does not enable the admin server; the runtime controls opt-in. */
export const resolveAdminSocketPath = (configured = process.env.RELAY_ADMIN_SOCKET, cwd = process.cwd()): string =>
    resolve(cwd, configured || DEFAULT_ADMIN_SOCKET_PATH);

const inspect = (path: string): Stats | undefined => {
    try { return lstatSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error('Cannot inspect the admin socket location');
    }
};

const removeOwnedSocket = (path: string, identity: Stats | undefined): void => {
    if (!identity) return;
    const current = inspect(path);
    if (current?.isSocket() && current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
};

/** Never repair an existing shared directory, and never follow a symlink parent. */
const prepareDirectory = (socketPath: string): string => {
    if (!isAbsolute(socketPath) || socketPath.includes('\0') || socketPath.endsWith(sep) ||
        socketPath.split(sep).some((part) => part === '.' || part === '..') || !process.geteuid) {
        throw new Error('An absolute UNIX admin socket path is required');
    }
    const directory = dirname(socketPath);
    let current = parse(directory).root;
    for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
        current = join(current, part);
        if (!inspect(current)) {
            try { mkdirSync(current, { mode: 0o700 }); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Cannot create admin directory');
            }
        }
        const entry = inspect(current);
        if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error('Admin socket parents must be real directories');
    }
    const leaf = inspect(directory);
    if (!leaf || leaf.uid !== process.geteuid() || (leaf.mode & 0o7777) !== 0o700) {
        throw new Error('Admin socket directory must be owned by this user with mode 0700');
    }
    if (inspect(socketPath)) throw new Error('Admin socket path already exists; refusing to replace it');
    return directory;
};

/**
 * Bind privately, then publish an exclusive hard link. Node unlinks its original
 * bind path on close, so remove that staging directory before exposing the socket:
 * Node must never unlink the public name, which somebody may have replaced.
 */
export const prepareAdminSocket = (socketPath: string) => {
    const directory = prepareDirectory(socketPath);
    const staging = mkdtempSync(join(directory, '.bind-'));
    const bindingPath = join(staging, 's');
    let identity: Stats | undefined;
    let published = false;
    let stagingRemoved = false;
    const removeStaging = () => {
        if (stagingRemoved) return;
        removeOwnedSocket(bindingPath, identity);
        rmdirSync(staging);
        stagingRemoved = true;
    };
    return {
        bindingPath,
        publish: () => {
            identity = inspect(bindingPath);
            if (!identity?.isSocket()) throw new Error('Admin socket could not be initialized');
            chmodSync(bindingPath, 0o600);
            linkSync(bindingPath, socketPath); // Atomic no-replace, including dangling symlinks.
            published = true;
            removeStaging();
        },
        cleanup: () => {
            if (published) removeOwnedSocket(socketPath, identity);
            removeStaging();
        },
    };
};
