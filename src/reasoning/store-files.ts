import { randomBytes } from 'node:crypto';
import {
    closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync,
    readFileSync, readSync, statSync, statfsSync, writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

function syncDirectory(path: string): void {
    const fd = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function loadSecret(path: string): string {
    const secretPath = `${path}.secret`;
    if (existsSync(path) && !existsSync(secretPath)) throw new Error('Existing replay database is missing its secret');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(secretPath)) {
        const fd = openSync(secretPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
            const bytes = Buffer.from(randomBytes(32).toString('hex'), 'utf8');
            writeFully(fd, bytes);
            fsyncSync(fd);
        } finally { closeSync(fd); }
        syncDirectory(secretPath);
    }
    const fd = openSync(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
            throw new Error('Replay secret must be an owner-only regular file');
        }
        const secret = readFileSync(fd, 'utf8');
        if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid replay secret');
        return secret;
    } finally { closeSync(fd); }
}

function writeFully(fd: number, buffer: Buffer): void {
    let offset = 0;
    while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (written === 0) throw new Error('Could not persist replay safety file');
        offset += written;
    }
}

/** The reserve is physically allocated, not a sparse file or an accounting promise. */
export class StoreFiles {
    private reserveFd: number | undefined;
    private guardFd: number | undefined;
    private reserved = 0;
    readonly path: string;
    readonly reserveBytes: number;

    constructor(path: string, reserveBytes: number) {
        this.path = path;
        this.reserveBytes = Math.max(65_536, reserveBytes);
    }

    openReserve(): void {
        if (this.reserveFd !== undefined) return;
        const guardPath = `${this.path}.guard`;
        const newGuard = !existsSync(guardPath);
        this.guardFd = openSync(guardPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        const guardStat = fstatSync(this.guardFd);
        if (!guardStat.isFile() || (guardStat.mode & 0o077) !== 0) throw new Error('Unsafe replay guard file');
        if (newGuard) {
            writeFully(this.guardFd, Buffer.alloc(4096));
            fsyncSync(this.guardFd);
            syncDirectory(guardPath);
        }
        const guard = Buffer.alloc(1);
        if (readSync(this.guardFd, guard, 0, 1, 0) !== 1 || guard[0] !== 0) {
            throw new Error('Replay store requires manual recovery after a failed safety write');
        }
        this.reserveFd = openSync(`${this.path}.reserve`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
        const stat = fstatSync(this.reserveFd);
        if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe replay reserve file');
        this.reserved = Math.min(stat.size, stat.blocks * 512);
    }

    allocateReserve(): void {
        this.openReserve();
        const fd = this.reserveFd!;
        const missing = this.reserveBytes - this.reserved;
        if (missing <= 0 || this.availableBytes() < missing + 262_144) return;
        const buffer = Buffer.alloc(Math.min(missing, 1_048_576), 0xa5);
        let position = this.reserved;
        while (position < this.reserveBytes) {
            const length = Math.min(buffer.length, this.reserveBytes - position);
            const written = writeSync(fd, buffer, 0, length, position);
            if (written === 0) throw new Error('Could not allocate replay reserve');
            position += written;
        }
        fsyncSync(fd);
        this.reserved = position;
        syncDirectory(this.path);
    }

    releaseReserve(): boolean {
        if (this.reserveFd === undefined || fstatSync(this.reserveFd).size === 0) return false;
        ftruncateSync(this.reserveFd, 0);
        fsyncSync(this.reserveFd);
        this.reserved = 0;
        return true;
    }

    availableBytes(): number {
        const stat = statfsSync(dirname(this.path), { bigint: true });
        return Number(stat.bavail * stat.bsize);
    }

    databaseBytes(): number {
        return ['', '-wal', '-shm'].reduce((total, suffix) => {
            try {
                const stat = statSync(`${this.path}${suffix}`);
                return total + Math.max(stat.size, stat.blocks * 512);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return total;
                throw error;
            }
        }, 0);
    }

    canAdmit(bytes: number, diskBytes: number): boolean {
        const estimate = bytes * 3 + 65_536;
        return this.reserved >= this.reserveBytes && this.databaseBytes() + estimate <= diskBytes
            && this.availableBytes() >= estimate + 262_144;
    }

    assertDispatchCapacity(): void {
        if (this.reserved < this.reserveBytes || this.availableBytes() < 262_144) {
            throw new Error('Replay safety reserve exhausted; dispatch must stop');
        }
    }

    blockReopening(): void {
        if (this.guardFd === undefined) throw new Error('Replay failure guard unavailable');
        if (writeSync(this.guardFd, Buffer.from([1]), 0, 1, 0) !== 1) throw new Error('Replay failure guard write failed');
        fsyncSync(this.guardFd);
    }

    close(): void {
        if (this.reserveFd !== undefined) closeSync(this.reserveFd);
        if (this.guardFd !== undefined) closeSync(this.guardFd);
        this.reserveFd = undefined;
        this.guardFd = undefined;
    }
}

export function existingReplayStore(path: string): boolean {
    return existsSync(path);
}
