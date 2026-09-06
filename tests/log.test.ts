import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createLogBuffer, createRequestLog, LOG_TRUNCATION_MARKER } from '../src/log.ts';

const temporaryDirectory = async (t: TestContext): Promise<string> => {
    const root = await fs.mkdtemp(join(tmpdir(), 'relay-log-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
};
const warnings = (t: TestContext): string[] => {
    const messages: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => { messages.push(args.join(' ')); });
    return messages;
};
const settle = (): Promise<void> => new Promise((done) => setImmediate(done));

test('disabled capture retains nothing and enabled capture preserves strings and split UTF-8', () => {
    const disabled = createLogBuffer(false, 2);
    disabled.push('secret body');
    disabled.push(new Uint8Array([65]));
    assert.equal(disabled.text(), '');
    const capture = createLogBuffer(true, 30);
    capture.push('Hello ');
    const emoji = Buffer.from('😀');
    capture.push(emoji.subarray(0, 2));
    capture.push(emoji.subarray(2));
    capture.push(' é');
    assert.equal(capture.text(), 'Hello 😀 é');
    assert.equal(capture.text(), 'Hello 😀 é', 'text does not consume the buffer');
});

test('capture respects byte limits and omits cut UTF-8 code points with a fixed marker', () => {
    for (const chunk of ['a😀z', Buffer.from('a😀z')]) {
        const capture = createLogBuffer(true, 4);
        capture.push(chunk);
        capture.push('ignored secret body');
        assert.equal(capture.text(), `a${LOG_TRUNCATION_MARKER}`);
        assert.equal(capture.text().includes('\uFFFD'), false);
    }
    const split = createLogBuffer(true, 3);
    const emoji = Buffer.from('😀');
    split.push(emoji.subarray(0, 2));
    split.push(emoji.subarray(2));
    assert.equal(split.text(), LOG_TRUNCATION_MARKER);
    const exact = createLogBuffer(true, 4);
    exact.push('😀');
    assert.equal(exact.text(), '😀');
    exact.push('');
    assert.equal(exact.text(), '😀');
    exact.push('x');
    assert.equal(exact.text(), `😀${LOG_TRUNCATION_MARKER}`);
    const empty = createLogBuffer(true, 0);
    empty.push('x');
    assert.equal(empty.text(), LOG_TRUNCATION_MARKER);
});

test('default capture is bounded to 8 MiB and does not retain mutable source views', () => {
    const capture = createLogBuffer(true);
    capture.push('x'.repeat(8 * 1024 * 1024 + 100));
    for (let i = 0; i < 1_000; i++) capture.push('never retained');
    assert.equal(Buffer.byteLength(capture.text()), 8 * 1024 * 1024 + Buffer.byteLength(LOG_TRUNCATION_MARKER));
    assert.ok(capture.text().endsWith(LOG_TRUNCATION_MARKER));
    const source = Buffer.from('safe');
    const copied = createLogBuffer(true, 4);
    copied.push(source);
    source.fill(0);
    assert.equal(copied.text(), 'safe');
});

test('disabled request logging has no I/O or warnings', async (t) => {
    const root = await temporaryDirectory(t);
    const messages = warnings(t);
    const directory = join(root, 'not-created');
    const log = createRequestLog(false, directory, '../invalid');
    await log.write('../bad', 'secret body');
    assert.equal(log.enabled, false);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    assert.deepEqual(messages, []);
});

test('new diagnostic directories and files are owner-only under permissive umask', async (t) => {
    const root = await temporaryDirectory(t);
    const directory = join(root, 'new-parent', 'logs');
    const originalUmask = process.umask(0);
    try {
        const log = createRequestLog(true, directory, 'request');
        await log.write('1-client-request.json', '{"ok":true}');
        await log.write('2-upstream-request.json', 'second');
        assert.equal(log.enabled, true);
        assert.equal((await fs.stat(join(root, 'new-parent'))).mode & 0o777, 0o700);
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        const names = await fs.readdir(directory);
        assert.equal(names.length, 2);
        for (const name of names) {
            assert.equal((await fs.stat(join(directory, name))).mode & 0o777, 0o600);
        }
        assert.equal(await fs.readFile(join(directory, names[0]!), 'utf8'), '{"ok":true}');
    } finally {
        process.umask(originalUmask);
    }
});

test('owner permissions are restored even when restrictive umask removes all creation permissions', async (t) => {
    const root = await temporaryDirectory(t);
    const directory = join(root, 'parent', 'logs');
    const originalUmask = process.umask(0o777);
    try {
        const log = createRequestLog(true, directory, 'restricted');
        await log.write('artifact.txt', 'ok');
        assert.equal(log.enabled, true);
        assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
        const [name] = await fs.readdir(directory);
        assert.ok(name);
        assert.equal((await fs.stat(join(directory, name))).mode & 0o777, 0o600);
        assert.equal(await fs.readFile(join(directory, name), 'utf8'), 'ok');
    } finally {
        process.umask(originalUmask);
    }
});

test('existing log directory permissions are repaired without changing existing parents', async (t) => {
    const root = await temporaryDirectory(t);
    const directory = join(root, 'logs');
    await fs.chmod(root, 0o755);
    await fs.mkdir(directory);
    await fs.chmod(directory, 0o777);
    await createRequestLog(true, directory, 'repair').write('artifact.txt', 'ok');
    assert.equal((await fs.stat(root)).mode & 0o777, 0o755);
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});

test('file blockers resolve writes, permanently disable that writer, and warn once without secrets', async (t) => {
    const root = await temporaryDirectory(t);
    const secret = 'secret-body-and-api-key';
    const blocker = join(root, `private-path-${secret}`);
    await fs.writeFile(blocker, 'unchanged');
    const messages = warnings(t);
    const log = createRequestLog(true, blocker, `request-${secret}`);
    await assert.doesNotReject(log.write('artifact.txt', secret));
    await assert.doesNotReject(log.write('another.txt', secret));
    assert.equal(log.enabled, false);
    assert.equal(await fs.readFile(blocker, 'utf8'), 'unchanged');
    assert.deepEqual(messages, ['[diagnostic log] disabled: I/O failure']);
    assert.equal(messages.join('').includes(secret), false);
});

test('artifact and request names reject traversal and never echo rejected names', async (t) => {
    const root = await temporaryDirectory(t);
    const messages = warnings(t);
    const directory = join(root, 'logs');
    const invalid = ['../secret', '/secret', 'a/secret', 'a\\secret', '..', 'a..secret', 'secret\nforged'];
    for (const step of invalid) {
        const log = createRequestLog(true, directory, 'request');
        await assert.doesNotReject(log.write(step, 'secret-body'));
        assert.equal(log.enabled, false);
    }
    await createRequestLog(true, directory, '../secret-id').write('artifact.txt', 'secret-body');
    assert.equal(messages.length, invalid.length + 1);
    assert.ok(messages.every((message) => message === '[diagnostic log] disabled: invalid artifact name'));
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('log directory and ancestor symlinks are rejected without modifying their targets', async (t) => {
    const root = await temporaryDirectory(t);
    const target = join(root, 'target');
    await fs.mkdir(target);
    await fs.chmod(target, 0o755);
    const link = join(root, 'link');
    await fs.symlink(target, link, 'dir');
    warnings(t);
    for (const directory of [link, join(link, 'nested')]) {
        const log = createRequestLog(true, directory, 'request');
        await assert.doesNotReject(log.write('artifact.txt', 'secret-body'));
        assert.equal(log.enabled, false);
    }
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
});

test('artifact symlinks and existing files are not followed or overwritten', async (t) => {
    const root = await temporaryDirectory(t);
    const directory = join(root, 'logs');
    const target = join(root, 'target.txt');
    await fs.writeFile(target, 'unchanged');
    const log = createRequestLog(true, directory, 'request');
    await log.write('first.txt', 'original');
    const [first] = await fs.readdir(directory);
    assert.ok(first);
    await fs.symlink(target, join(directory, first.replace(/first\.txt$/, 'linked.txt')));
    const messages = warnings(t);
    await assert.doesNotReject(log.write('linked.txt', 'secret-body'));
    assert.equal(log.enabled, false);
    assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
    assert.equal(messages.length, 1);
    const other = createRequestLog(true, directory, 'other');
    await other.write('first.txt', 'original');
    await other.write('first.txt', 'overwrite');
    const otherName = (await fs.readdir(directory)).find((name) => name.endsWith('-other-first.txt'))!;
    assert.equal(await fs.readFile(join(directory, otherName), 'utf8'), 'original');
    assert.equal(other.enabled, false);
});

test('a timeout resolves promptly, disables subsequent writes, and observes late I/O rejection', async (t) => {
    const root = await temporaryDirectory(t);
    const messages = warnings(t);
    let reject!: (error: Error) => void;
    const delayed = new Promise<never>((_resolve, fail) => { reject = fail; });
    const mock = t.mock.method(fs, 'lstat', () => delayed);
    const log = createRequestLog(true, join(root, 'logs'), 'request', { timeoutMs: 15 });
    const started = performance.now();
    await assert.doesNotReject(log.write('artifact.txt', 'secret-body'));
    assert.ok(performance.now() - started < 1_000);
    assert.equal(log.enabled, false);
    await log.write('another.txt', 'secret-body');
    assert.equal(mock.mock.callCount(), 1, 'timed-out writes are not retried');
    reject(new Error('secret-path-and-body'));
    await settle();
    assert.deepEqual(messages, ['[diagnostic log] disabled: write timeout']);
    mock.mock.restore();
});

test('write deadlines cannot exceed two seconds even with larger options', async (t) => {
    const root = await temporaryDirectory(t);
    warnings(t);
    let reject!: (error: Error) => void;
    const delayed = new Promise<never>((_resolve, fail) => { reject = fail; });
    const mock = t.mock.method(fs, 'lstat', () => delayed);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const log = createRequestLog(true, join(root, 'logs'), 'request', { timeoutMs: 60_000 });
    let done = false;
    const operation = log.write('artifact.txt', 'body').then(() => { done = true; });
    t.mock.timers.tick(1_999);
    await Promise.resolve();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    await operation;
    assert.equal(done, true);
    reject(new Error('late failure'));
    await settle();
    mock.mock.restore();
    t.mock.timers.reset();
});

test('global admission retains timed-out slots until I/O settles and starts no queued writes', async (t) => {
    const root = await temporaryDirectory(t);
    const messages = warnings(t);
    const rejections: ((error: Error) => void)[] = [];
    const mock = t.mock.method(fs, 'lstat', () => new Promise<never>((_resolve, reject) => { rejections.push(reject); }));
    const logs = Array.from({ length: 10 }, (_, index) =>
        createRequestLog(true, join(root, 'logs'), `request-${index}`, { timeoutMs: 10 }));
    await Promise.all(logs.map((log) => log.write('artifact.txt', 'secret-body')));
    assert.equal(mock.mock.callCount(), 4);
    assert.equal(rejections.length, 4);
    assert.equal(logs.filter((log) => log.enabled).length, 0);
    const blocked = createRequestLog(true, join(root, 'logs'), 'blocked', { timeoutMs: 10 });
    await blocked.write('artifact.txt', 'secret-body');
    assert.equal(mock.mock.callCount(), 4, 'expired operations still consume admission capacity');
    for (const reject of rejections) reject(new Error('late secret-body failure'));
    await settle();
    assert.equal(messages.length, 11, 'one warning per disabled writer, including late failures');
    mock.mock.restore();
    const healthy = createRequestLog(true, join(root, 'logs'), 'healthy');
    await healthy.write('artifact.txt', 'ok');
    assert.equal(healthy.enabled, true, 'capacity returns only after actual settlement');
});

test('artifact open and write failures are swallowed, use safe flags, and close handles', async (t) => {
    const root = await temporaryDirectory(t);
    const messages = warnings(t);
    const directory = join(root, 'logs');
    await fs.mkdir(directory);
    const originalOpen = fs.open;
    let closes = 0;
    const mock = t.mock.method(fs, 'open', async (path: Parameters<typeof fs.open>[0], flags: number, mode?: number) => {
        if (flags & constants.O_DIRECTORY) return originalOpen(path, flags, mode);
        assert.ok(flags & constants.O_NOFOLLOW);
        assert.ok(flags & constants.O_EXCL);
        assert.equal(mode, 0o600);
        return {
            chmod: async (permission: number) => { assert.equal(permission, 0o600); },
            writeFile: async () => { throw new Error('ENOSPC private-body-and-key'); },
            close: async () => { closes++; },
        };
    });
    const log = createRequestLog(true, directory, 'failure');
    await assert.doesNotReject(log.write('artifact.txt', 'private-body-and-key'));
    assert.equal(closes, 1);
    assert.equal(log.enabled, false);
    assert.deepEqual(messages, ['[diagnostic log] disabled: I/O failure']);
    mock.mock.restore();
});

test('a timed-out artifact write is aborted and retains admission through delayed cleanup', async (t) => {
    const root = await temporaryDirectory(t);
    const messages = warnings(t);
    const directory = join(root, 'logs');
    await fs.mkdir(directory);
    const originalOpen = fs.open;
    let writeSignal: AbortSignal | undefined;
    let completeWrite!: () => void;
    const delayedWrite = new Promise<void>((done) => { completeWrite = done; });
    let closes = 0;
    const mock = t.mock.method(fs, 'open', async (path: Parameters<typeof fs.open>[0], flags: number, mode?: number) => {
        if (flags & constants.O_DIRECTORY) return originalOpen(path, flags, mode);
        return {
            chmod: async () => {},
            writeFile: async (_content: string, options: { signal: AbortSignal }) => {
                writeSignal = options.signal;
                await delayedWrite;
            },
            close: async () => { closes++; },
        };
    });
    const log = createRequestLog(true, directory, 'delayed', { timeoutMs: 100 });
    await assert.doesNotReject(log.write('artifact.txt', 'secret-body'));
    assert.ok(writeSignal, 'artifact writing started before the timeout');
    assert.equal(writeSignal.aborted, true);
    assert.equal(log.enabled, false);
    assert.equal(closes, 0, 'handle closes only after the filesystem operation finishes');
    completeWrite();
    await settle();
    assert.equal(closes, 1);
    assert.deepEqual(messages, ['[diagnostic log] disabled: write timeout']);
    mock.mock.restore();
});

test('warning sink failures also never fail a request', async (t) => {
    const root = await temporaryDirectory(t);
    t.mock.method(console, 'warn', () => { throw new Error('broken diagnostic sink'); });
    const log = createRequestLog(true, root, '../invalid');
    await assert.doesNotReject(log.write('../invalid', 'secret-body'));
    assert.equal(log.enabled, false);
});
