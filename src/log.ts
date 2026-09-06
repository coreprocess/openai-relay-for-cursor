import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const logLine = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
};

export const truncate = (text: string, maxLength = 2000): string =>
    text.length <= maxLength ? text : `${text.slice(0, maxLength)}… (${text.length - maxLength} more chars)`;

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_WRITE_TIMEOUT_MS = 2_000;
const MAX_PENDING_WRITES = 4;
export const LOG_TRUNCATION_MARKER = '\n[diagnostic log truncated]\n';
let pendingWrites = 0;

export type LogBuffer = { push: (chunk: string | Uint8Array) => void; text: () => string };

/** Retains at most maxBytes of UTF-8 payload, plus a fixed truncation marker on output. */
export const createLogBuffer = (enabled: boolean, maxBytes = DEFAULT_MAX_BYTES): LogBuffer => {
    const limit = Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_MAX_BYTES;
    let storage = Buffer.alloc(0);
    let length = 0;
    let truncated = false;
    return {
        push: (chunk) => {
            if (!enabled || truncated || chunk.length === 0) return;
            const incomingBytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
            const available = Math.min(incomingBytes, limit - length);
            if (storage.length < length + available) {
                const next = Buffer.allocUnsafe(Math.min(limit, Math.max(4096, storage.length * 2, length + available)));
                storage.copy(next, 0, 0, length);
                storage = next;
            }
            if (typeof chunk === 'string') {
                // Buffer.write never cuts a string's UTF-8 code point in half.
                length += storage.write(chunk, length, available, 'utf8');
            } else {
                storage.set(chunk.subarray(0, available), length);
                length += available;
            }
            truncated = incomingBytes > available;
        },
        text: () => {
            const decoder = new StringDecoder('utf8');
            const text = decoder.write(storage.subarray(0, length));
            // Incomplete trailing bytes are omitted only when capture was truncated.
            return text + (truncated ? LOG_TRUNCATION_MARKER : decoder.end());
        },
    };
};

export type RequestLog = {
    enabled: boolean;
    /** Best-effort artifact write; always resolves, including on I/O failure or timeout. */
    write: (step: string, content: string) => Promise<void>;
};

export type RequestLogOptions = { timeoutMs?: number };
const safeName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) && !value.includes('..');

const privateDirectory = async (directory: string, signal: AbortSignal): Promise<void> => {
    const root = parse(directory).root;
    const parts = directory.slice(root.length).split(sep).filter(Boolean);
    if (!parts.length) throw new Error('Unsafe diagnostic directory');
    let current = root;
    for (const part of parts) {
        signal.throwIfAborted();
        current = join(current, part);
        let created = false;
        try {
            await fs.lstat(current);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            signal.throwIfAborted();
            try {
                await fs.mkdir(current, { mode: 0o700 });
                created = true;
            } catch (mkdirError) {
                if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
            }
        }
        signal.throwIfAborted();
        const stat = await fs.lstat(current);
        signal.throwIfAborted();
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe diagnostic directory');
        // Repair permissions masked during creation, but never chmod existing parent directories.
        if (created) await fs.chmod(current, 0o700);
    }
    signal.throwIfAborted();
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        signal.throwIfAborted();
        await handle.chmod(0o700);
    } finally {
        await handle.close();
    }
};

const writeArtifact = async (directory: string, filename: string, content: string, signal: AbortSignal): Promise<void> => {
    await privateDirectory(directory, signal);
    signal.throwIfAborted();
    // Exclusive creation rejects both existing artifacts and symlink targets without overwriting.
    const handle = await fs.open(join(directory, filename),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        signal.throwIfAborted();
        await handle.chmod(0o600);
        signal.throwIfAborted();
        await handle.writeFile(content, { encoding: 'utf8', signal });
    } finally {
        await handle.close();
    }
};

/**
 * Files share a timestamp/request prefix. A failed writer stays disabled; no write is retried.
 * Waiting is capped at 2s (optionally shorter). Timed-out I/O retains its global admission slot
 * until all work/cleanup settles, bounding uncancellable filesystem operations to four total.
 * Static ancestor symlinks are rejected; Node's path APIs cannot eliminate ancestor-swap races.
 */
export const createRequestLog = (
    enabled: boolean, logDir: string, requestId: string, options: RequestLogOptions = {},
): RequestLog => {
    const prefix = `${new Date().toISOString().replace(/[:.]/g, '-')}-${requestId}`;
    const requestedTimeout = options.timeoutMs ?? MAX_WRITE_TIMEOUT_MS;
    const timeoutMs = Number.isFinite(requestedTimeout)
        ? Math.max(1, Math.min(MAX_WRITE_TIMEOUT_MS, requestedTimeout)) : MAX_WRITE_TIMEOUT_MS;
    let disabled = false;
    let writing = false;
    const disable = (reason: string): void => {
        if (disabled) return;
        disabled = true;
        // Never include paths, step names, request IDs, content, or filesystem error messages.
        try { console.warn(`[diagnostic log] disabled: ${reason}`); } catch { /* Logging must not fail the request. */ }
    };
    return {
        get enabled() { return enabled && !disabled; },
        write: async (step, content) => {
            if (!enabled || disabled) return;
            if (!safeName(requestId) || !safeName(step)) return disable('invalid artifact name');
            if (writing || pendingWrites >= MAX_PENDING_WRITES) return disable('capacity limit');
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                const directory = resolve(logDir);
                const capture = createLogBuffer(true);
                capture.push(content);
                content = capture.text();
                const controller = new AbortController();
                writing = true;
                pendingWrites++;
                const operation = writeArtifact(directory, `${prefix}-${step}`, content, controller.signal)
                    .catch(() => { disable('I/O failure'); })
                    .finally(() => { pendingWrites--; writing = false; });
                const deadline = new Promise<void>((done) => {
                    timer = setTimeout(() => {
                        disable('write timeout');
                        controller.abort();
                        done();
                    }, timeoutMs);
                });
                await Promise.race([operation, deadline]);
            } catch {
                disable('I/O failure');
            } finally {
                clearTimeout(timer);
            }
        },
    };
};
