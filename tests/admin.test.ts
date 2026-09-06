import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
    renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { requestAdmin } from '../src/admin/client.ts';
import { resolveAdminSocketPath } from '../src/admin/paths.ts';
import { startAdminServer, type AdminHandlers } from '../src/admin/server.ts';
import { parseAdminArguments } from '../src/reasoning/admin.ts';

const fixture = (t: TestContext) => {
    const directory = mkdtempSync(join(tmpdir(), 'relay-admin-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return { directory, socket: join(directory, 'admin', 'relay-admin.sock') };
};
const handlers = (): AdminHandlers => ({ status: () => ({ enabled: true }), snapshot: async () => ({ path: '/safe/snapshot.sqlite' }) });
const serve = async (t: TestContext, path: string, callbacks = handlers()) => {
    const server = await startAdminServer(path, callbacks);
    t.after(() => server.close());
    return server;
};
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};
const call = (socketPath: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ socketPath, method, path, headers, agent: false }, (response) => {
            let output = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { output += chunk; });
            response.once('end', () => resolve({ status: response.statusCode!, body: output }));
            response.once('error', reject);
        });
        req.once('error', reject);
        req.setTimeout(10_000, () => req.destroy(new Error('Test request timed out')));
        req.end(body);
    });
const raw = (socketPath: string, input: string) => new Promise<string>((resolve, reject) => {
    const socket = createConnection(socketPath, () => socket.write(input));
    let output = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { output += chunk; });
    socket.once('end', () => { socket.destroy(); resolve(output); });
    socket.once('error', reject);
    socket.setTimeout(10_000, () => socket.destroy(new Error('Test socket timed out')));
});

test('admin publishes a private UNIX socket, serves metadata, and cleans up idempotently', async (t) => {
    const f = fixture(t);
    const server = await serve(t, f.socket);
    assert.equal(lstatSync(join(f.directory, 'admin')).mode & 0o7777, 0o700);
    assert.equal(lstatSync(f.socket).mode & 0o7777, 0o600);
    assert.equal(lstatSync(f.socket).isSocket(), true);
    assert.deepEqual(readdirSync(join(f.directory, 'admin')), ['relay-admin.sock']);
    assert.deepEqual(await requestAdmin(f.socket, 'status'), { enabled: true });
    assert.deepEqual(await requestAdmin(f.socket, 'snapshot'), { path: '/safe/snapshot.sqlite' });
    assert.equal((await call(f.socket, 'GET', '/status')).status, 200);
    const closing = server.close();
    assert.equal(server.close(), closing);
    await closing;
    assert.equal(existsSync(f.socket), false);
});

test('admin refuses existing files, dangling links, and another active admin socket without unlinking', async (t) => {
    const f = fixture(t);
    mkdirSync(join(f.directory, 'admin'), { mode: 0o700 });
    writeFileSync(f.socket, 'owned by someone else');
    await assert.rejects(startAdminServer(f.socket, handlers()), /already exists/);
    assert.equal(readFileSync(f.socket, 'utf8'), 'owned by someone else');
    unlinkSync(f.socket);
    symlinkSync(join(f.directory, 'missing'), f.socket);
    await assert.rejects(startAdminServer(f.socket, handlers()), /already exists/);
    assert.equal(lstatSync(f.socket).isSymbolicLink(), true);
    unlinkSync(f.socket);
    await serve(t, f.socket);
    const identity = lstatSync(f.socket);
    await assert.rejects(startAdminServer(f.socket, handlers()), /already exists/);
    assert.equal(lstatSync(f.socket).ino, identity.ino);
    assert.deepEqual(await requestAdmin(f.socket, 'status'), { enabled: true });
});

test('admin refuses symlink parents and does not chmod existing shared directories', async (t) => {
    const f = fixture(t);
    const shared = join(f.directory, 'shared');
    mkdirSync(shared, { mode: 0o700 });
    chmodSync(shared, 0o755);
    await assert.rejects(startAdminServer(join(shared, 's'), handlers()), /0700/);
    assert.equal(lstatSync(shared).mode & 0o777, 0o755);
    symlinkSync(shared, join(f.directory, 'linked'));
    await assert.rejects(startAdminServer(join(f.directory, 'linked', 'private', 's'), handlers()), /real directories/);
    assert.equal(existsSync(join(shared, 'private')), false);
    await assert.rejects(startAdminServer('relative.sock', handlers()), /absolute UNIX/);
});

test('admin rejects a private leaf owned by another user without changing its owner', async (t) => {
    const f = fixture(t);
    const leaf = join(f.directory, 'admin');
    mkdirSync(leaf, { mode: 0o700 });
    const owner = lstatSync(leaf).uid;
    const effectiveUser = t.mock.method(process as NodeJS.Process & { geteuid: () => number }, 'geteuid', () => owner + 1);
    try { await assert.rejects(startAdminServer(f.socket, handlers()), /owned by this user/); }
    finally { effectiveUser.mock.restore(); }
    assert.equal(lstatSync(leaf).uid, owner);
});

test('concurrent starts publish exactly one socket without disturbing its owner', async (t) => {
    const f = fixture(t);
    const starts = await Promise.allSettled([startAdminServer(f.socket, handlers()), startAdminServer(f.socket, handlers())]);
    const winners = starts.filter((result) => result.status === 'fulfilled');
    for (const result of winners) t.after(() => result.value.close());
    assert.equal(winners.length, 1);
    assert.deepEqual(await requestAdmin(f.socket, 'status'), { enabled: true });
    assert.deepEqual(readdirSync(join(f.directory, 'admin')), ['relay-admin.sock']);
});

test('admin rejects methods, paths, queries, bodies, protocol upgrades, and excessive headers', async (t) => {
    const f = fixture(t);
    let calls = 0;
    await serve(t, f.socket, { status: () => { calls++; return {}; }, snapshot: async () => { calls++; return {}; } });
    for (const [method, path, status] of [
        ['GET', '/snapshot', 405], ['POST', '/status', 405], ['DELETE', '/snapshot', 405], ['HEAD', '/status', 405],
        ['GET', '/snapshot.sqlite', 404], ['POST', '/snapshot?path=/private', 400], ['GET', '/status?', 400],
        ['POST', '/snapshot/../snapshot', 404], ['POST', '/%73napshot', 404], ['POST', '/execute', 404],
    ] as const) assert.equal((await call(f.socket, method, path)).status, status, `${method} ${path}`);
    for (const body of ['{"path":"/private"}', '{"sql":"DROP TABLE metadata"}', 'x']) {
        assert.equal((await call(f.socket, 'POST', '/snapshot', body, { 'Content-Length': String(Buffer.byteLength(body)) })).status, 400);
    }
    assert.equal((await call(f.socket, 'POST', '/snapshot', '', { 'Transfer-Encoding': 'chunked' })).status, 400);
    assert.match(await raw(f.socket, 'POST /snapshot HTTP/1.1\r\nHost: localhost\r\nExpect: 100-continue\r\nContent-Length: 0\r\n\r\n'), /417/);
    assert.match(await raw(f.socket, 'GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'), /405/);
    assert.match(await raw(f.socket, 'CONNECT localhost:80 HTTP/1.1\r\nHost: localhost\r\n\r\n'), /405/);
    assert.match(await raw(f.socket, `GET /status HTTP/1.1\r\nHost: localhost\r\nX-Huge: ${'x'.repeat(9000)}\r\n\r\n`), /431/);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`X-${index}`, 'x']));
    assert.equal((await call(f.socket, 'GET', '/status', undefined, many)).status, 431);
    assert.equal(calls, 0);
});

test('admin snapshots are single-flight while status remains available, including after errors', async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    await serve(t, f.socket, { status: () => ({ running: true }), snapshot: async () => {
        calls++;
        entered.resolve();
        await release.promise;
        if (calls === 1) throw new Error('/private/db.sqlite secret sql payload');
        return { path: '/safe/snapshot.sqlite' };
    } });
    t.after(() => release.resolve());
    const first = call(f.socket, 'POST', '/snapshot');
    await entered.promise;
    assert.equal((await call(f.socket, 'POST', '/snapshot')).status, 409);
    await assert.rejects(requestAdmin(f.socket, 'snapshot'), /already in progress/);
    assert.deepEqual(await requestAdmin(f.socket, 'status'), { running: true });
    assert.equal(calls, 1);
    release.resolve();
    const failed = await first;
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.body), { error: 'Admin snapshot failed' });
    assert.deepEqual(await requestAdmin(f.socket, 'snapshot'), { path: '/safe/snapshot.sqlite' });
    assert.equal(calls, 2);
});

test('admin sanitizes throwing status handlers and response serialization failures', async (t) => {
    const f = fixture(t);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let result: unknown = cycle;
    await serve(t, f.socket, { status: () => { throw new Error('secret /private/path SELECT payload'); }, snapshot: async () => result });
    assert.deepEqual(JSON.parse((await call(f.socket, 'GET', '/status')).body), { error: 'Admin status failed' });
    assert.deepEqual(JSON.parse((await call(f.socket, 'POST', '/snapshot')).body), { error: 'Admin snapshot failed' });
    result = 'x'.repeat(1024 * 1024);
    assert.equal((await call(f.socket, 'POST', '/snapshot')).status, 500);
    result = { path: '/safe/output.sqlite' };
    assert.equal((await call(f.socket, 'POST', '/snapshot')).status, 200);
});

test('close stops accepting, drains an active snapshot even if its client disconnects, and then removes its socket', async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const release = deferred();
    const server = await serve(t, f.socket, { status: () => ({}), snapshot: async () => {
        entered.resolve(); await release.promise; return { path: '/safe/output.sqlite' };
    } });
    t.after(() => release.resolve());
    const client = request({ socketPath: f.socket, path: '/snapshot', method: 'POST', agent: false });
    client.on('error', () => {});
    client.end();
    await entered.promise;
    client.destroy();
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    await assert.rejects(requestAdmin(f.socket, 'status'), /unavailable/);
    assert.equal(closed, false);
    assert.equal(existsSync(f.socket), true);
    release.resolve();
    await closing;
    assert.equal(existsSync(f.socket), false);
});

test('close lets a connected snapshot finish and closes idle incomplete requests promptly', async (t) => {
    const f = fixture(t);
    const entered = deferred();
    const release = deferred();
    const server = await serve(t, f.socket, { status: () => ({}), snapshot: async () => {
        entered.resolve(); await release.promise; return { path: '/safe/completed.sqlite' };
    } });
    t.after(() => release.resolve());
    const response = call(f.socket, 'POST', '/snapshot');
    await entered.promise;
    const idle = createConnection(f.socket);
    await new Promise<void>((resolve, reject) => { idle.once('connect', resolve); idle.once('error', reject); });
    const idleClosed = new Promise<void>((resolve) => idle.once('close', resolve));
    idle.write('GET /status HTTP/1.1\r\n');
    const closing = server.close();
    await idleClosed;
    assert.equal(existsSync(f.socket), true);
    release.resolve();
    const result = await response;
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { path: '/safe/completed.sqlite' });
    await closing;
    assert.equal(existsSync(f.socket), false);
});

test('cleanup preserves a replacement regular file, symlink, or another server socket', async (t) => {
    const f = fixture(t);
    for (const replacement of ['file', 'symlink', 'socket']) {
        const path = join(f.directory, replacement);
        const server = await serve(t, path);
        unlinkSync(path);
        let other: ReturnType<typeof createNetServer> | undefined;
        if (replacement === 'file') writeFileSync(path, 'do not remove');
        if (replacement === 'symlink') symlinkSync(join(f.directory, 'nonexistent'), path);
        if (replacement === 'socket') {
            other = createNetServer();
            await new Promise<void>((resolve) => other!.listen(path, resolve));
        }
        const identity = lstatSync(path);
        await server.close();
        assert.equal(lstatSync(path).ino, identity.ino);
        if (other) await new Promise<void>((resolve) => other!.close(() => resolve()));
    }
});

test('cleanup does not remove a renamed socket at an unowned path', async (t) => {
    const f = fixture(t);
    const server = await serve(t, f.socket);
    const moved = join(f.directory, 'moved.sock');
    renameSync(f.socket, moved);
    await server.close();
    assert.equal(lstatSync(moved).isSocket(), true);
});

test('CLI parses defaults and strict explicit options without configuration or an API key', () => {
    assert.equal(resolveAdminSocketPath('', '/work'), '/work/data/admin/relay-admin.sock');
    assert.deepEqual(parseAdminArguments(['status'], {}, '/work'),
        { command: 'status', json: false, socketPath: '/work/data/admin/relay-admin.sock' });
    assert.deepEqual(parseAdminArguments(['snapshot', '--json'], { RELAY_ADMIN_SOCKET: '/private/relay.sock' }, '/work'),
        { command: 'snapshot', json: true, socketPath: '/private/relay.sock' });
    assert.equal((parseAdminArguments(['status', '--socket', '/explicit.sock', '--json'], { RELAY_ADMIN_SOCKET: '/env.sock' }) as
        { socketPath: string }).socketPath, '/explicit.sock');
    assert.deepEqual(parseAdminArguments(['backup', 'a.sqlite', 'b.sqlite']), { command: 'backup', source: 'a.sqlite', destination: 'b.sqlite' });
    assert.deepEqual(parseAdminArguments(['restore', 'a.sqlite', 'b.sqlite']), { command: 'restore', source: 'a.sqlite', destination: 'b.sqlite' });
    for (const options of [[], ['status', '--socket'], ['status', '--socket', 'relative'], ['status', '--socket', 'http://localhost'],
        ['snapshot', '--path', '/arbitrary'], ['status', '--json', '--json'], ['status', '--socket', '/a', '--socket', '/b'],
        ['snapshot', 'SELECT 1'], ['backup', 'a', 'b', 'c'], ['restore', 'a']]) assert.throws(() => parseAdminArguments(options));
});

test('CLI status and snapshot JSON work against mock handlers without OPENAI_API_KEY or loading .env', async (t) => {
    const f = fixture(t);
    const socket = join(f.directory, 'data', 'admin', 'relay-admin.sock');
    await serve(t, socket);
    writeFileSync(join(f.directory, '.env'), 'RELAY_ADMIN_SOCKET=/must-not-be-loaded.sock\nOPENAI_API_KEY=not-a-real-key\n');
    const script = fileURLToPath(new URL('../src/reasoning/admin.ts', import.meta.url));
    const run = (args: string[], env: NodeJS.ProcessEnv = {}) => promisify(execFile)(process.execPath, [script, ...args],
        { cwd: f.directory, env: { PATH: process.env.PATH, ...env }, timeout: 10_000 });
    const status = await run(['status', '--json']);
    assert.deepEqual(JSON.parse(status.stdout), { enabled: true });
    assert.equal(status.stderr, '');
    const snapshot = await run(['snapshot', '--json', '--socket', socket]);
    assert.deepEqual(JSON.parse(snapshot.stdout), { path: '/safe/snapshot.sqlite' });
    const viaEnvironment = await run(['status', '--json'], { RELAY_ADMIN_SOCKET: socket });
    assert.deepEqual(JSON.parse(viaEnvironment.stdout), { enabled: true });
    await assert.rejects(run(['status', '--socket', join(f.directory, 'absent.sock')]), (error: unknown) => {
        const result = error as Error & { stderr: string; code: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Enable RELAY_ADMIN_SOCKET and restart/);
        assert.doesNotMatch(result.stderr, /absent\.sock/);
        return true;
    });
});

test('client caps responses, sanitizes errors, and reports unavailable sockets actionably', async (t) => {
    const f = fixture(t);
    await assert.rejects(requestAdmin(f.socket, 'status'), /Enable RELAY_ADMIN_SOCKET and restart/);
    await assert.rejects(requestAdmin('https://localhost/status', 'status'), /absolute UNIX/);
    const path = join(f.directory, 'mock.sock');
    let body = 'x'.repeat(1024 * 1024 + 1);
    let status = 200;
    const mock = createServer((_request, response) => { response.writeHead(status); response.end(body); });
    await new Promise<void>((resolve) => mock.listen(path, resolve));
    t.after(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    await assert.rejects(requestAdmin(path, 'status'), /1 MiB/);
    body = '/secret/path SQL private request';
    await assert.rejects(requestAdmin(path, 'status'), /invalid JSON/);
    status = 500;
    await assert.rejects(requestAdmin(path, 'snapshot'), (error: Error) => {
        assert.match(error.message, /HTTP 500/);
        assert.doesNotMatch(error.message, /secret|SQL|private request/);
        return true;
    });
});
