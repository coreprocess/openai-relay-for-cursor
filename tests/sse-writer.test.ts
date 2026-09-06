import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { createSseWriter } from '../src/sseWriter.ts';

const KEEPALIVE = ': keepalive\n\n';
const DATA = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
const TERMINAL = 'data: [DONE]\n\n';
const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const clock = (t: TestContext): void => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    t.mock.method(performance, 'now', () => Date.now());
};
const fakeResponse = (writable = true) => {
    const frames: string[] = [];
    const raw = Object.assign(new EventEmitter(), {
        destroyed: false,
        closed: false,
        writableEnded: false,
        writableFinished: false,
        writableNeedDrain: false,
        writableLength: 0,
        write: (frame: string): boolean => {
            frames.push(frame);
            if (!writable) { raw.writableNeedDrain = true; raw.writableLength += Buffer.byteLength(frame); }
            return writable;
        },
        destroy: () => { raw.destroyed = true; raw.closed = true; raw.emit('close'); return raw; },
    });
    return {
        raw, frames, res: raw as unknown as ServerResponse,
        setWritable: (value: boolean) => { writable = value; },
        drain: () => { raw.writableNeedDrain = false; raw.writableLength = 0; raw.emit('drain'); },
    };
};

test('default quiet period is 15 seconds and sends only complete SSE comments', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const onKeepalive = t.mock.fn<(frame: string) => void>();
    const writer = createSseWriter(fake.res, { onKeepalive });
    t.after(writer.stop);
    t.mock.timers.tick(14_999);
    assert.deepEqual(fake.frames, []);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    assert.deepEqual(onKeepalive.mock.calls[0].arguments, [KEEPALIVE]);
    t.mock.timers.tick(14_999);
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE, KEEPALIVE]);
    assert.ok(fake.frames.every((frame: string) => !frame.includes('data:') && !frame.includes('choices')));
});

test('zero disables the timer but preserves complete main writes and the exact API', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res, { intervalMs: 0 });
    t.after(writer.stop);
    assert.deepEqual(Object.keys(writer).sort(), ['stop', 'write']);
    t.mock.timers.tick(100_000); await flush();
    await writer.write(DATA);
    writer.stop();
    await writer.write(TERMINAL);
    assert.deepEqual(fake.frames, [DATA, TERMINAL]);
});

for (const option of ['intervalMs', 'writeTimeoutMs'] as const) {
    test(`${option} rejects invalid or overflowing timer values`, () => {
        for (const value of [-1, 1.5, NaN, Infinity, -Infinity, 2_147_483_648]) {
            const fake = fakeResponse();
            assert.throws(() => createSseWriter(fake.res, { [option]: value }), RangeError);
            assert.deepEqual(fake.raw.eventNames(), []);
        }
    });
}

test('downstream main activity restarts the full quiet period', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res, { intervalMs: 100 });
    t.after(writer.stop);
    t.mock.timers.tick(70);
    await writer.write(DATA);
    t.mock.timers.tick(99); await flush();
    assert.deepEqual(fake.frames, [DATA]);
    t.mock.timers.tick(1); await flush();
    assert.deepEqual(fake.frames, [DATA, KEEPALIVE]);
});

test('the injected clock enforces elapsed quiet time even when a timer fires early', async (t) => {
    clock(t);
    let now = 0;
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res, { intervalMs: 100, now: () => now });
    t.after(writer.stop);
    now = 40;
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(fake.frames, []);
    now = 100;
    t.mock.timers.tick(60); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE]);
});

for (const property of ['writableNeedDrain', 'writableLength'] as const) {
    test(`timer skips a response with ${property}`, async (t) => {
        clock(t);
        const fake = fakeResponse();
        if (property === 'writableNeedDrain') fake.raw.writableNeedDrain = true;
        else fake.raw.writableLength = 1;
        const writer = createSseWriter(fake.res, { intervalMs: 10 });
        t.after(writer.stop);
        for (let i = 0; i < 20; i++) { t.mock.timers.tick(10); await flush(); }
        assert.deepEqual(fake.frames, []);
        fake.raw.writableNeedDrain = false;
        fake.raw.writableLength = 0;
        t.mock.timers.tick(10); await flush();
        assert.deepEqual(fake.frames, [KEEPALIVE]);
    });
}

for (const property of ['destroyed', 'closed', 'writableEnded', 'writableFinished'] as const) {
    test(`disconnected response (${property}) never receives keepalives`, async (t) => {
        clock(t);
        const fake = fakeResponse();
        fake.raw[property] = true;
        const writer = createSseWriter(fake.res, { intervalMs: 10 });
        t.after(writer.stop);
        t.mock.timers.tick(100); await flush();
        assert.deepEqual(fake.frames, []);
        await assert.rejects(writer.write(DATA), /Client disconnected/);
    });
}

test('a disconnect detected at the tick stops future heartbeats without writing', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res, { intervalMs: 10 });
    t.after(writer.stop);
    fake.raw.destroyed = true;
    t.mock.timers.tick(10); await flush();
    fake.raw.destroyed = false;
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(fake.frames, []);
});

for (const event of ['finish', 'close', 'error'] as const) {
    test(`${event} stops keepalives and removes lifecycle listeners`, async (t) => {
        clock(t);
        const fake = fakeResponse();
        const onError = t.mock.fn<(error: unknown) => void>();
        const writer = createSseWriter(fake.res, { intervalMs: 10, onError });
        t.after(writer.stop);
        const error = new Error('asynchronous response failure');
        fake.raw.emit(event, error);
        t.mock.timers.tick(100); await flush();
        assert.deepEqual(fake.frames, []);
        assert.deepEqual(fake.raw.eventNames(), []);
        assert.equal(onError.mock.callCount(), event === 'error' ? 1 : 0);
        if (event === 'error') await assert.rejects(writer.write(DATA), value => value === error);
    });
}

test('stop is idempotent and prevents comments before and after terminal writes', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const writer = createSseWriter(fake.res, { intervalMs: 10 });
    t.mock.timers.tick(9);
    writer.stop(); writer.stop();
    t.mock.timers.tick(100); await flush();
    await writer.write(TERMINAL);
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(fake.frames, [TERMINAL]);
    assert.deepEqual(fake.raw.eventNames(), []);
});

test('frequent ticks during heartbeat backpressure stay bounded and terminal write waits once', async (t) => {
    clock(t);
    const fake = fakeResponse(false);
    const writer = createSseWriter(fake.res, { intervalMs: 1, writeTimeoutMs: 1000 });
    t.after(writer.stop);
    t.mock.timers.tick(1); await flush();
    // In-flight protection must also work independently of the response buffer flags.
    fake.raw.writableNeedDrain = false; fake.raw.writableLength = 0;
    for (let i = 0; i < 100; i++) { t.mock.timers.tick(1); await flush(); }
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    assert.equal(fake.raw.listenerCount('drain'), 1);
    writer.stop();
    let delivered = false;
    const terminal = writer.write(TERMINAL).then(() => { delivered = true; });
    t.mock.timers.tick(100); await flush();
    assert.equal(delivered, false);
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    fake.setWritable(true); fake.drain();
    await terminal;
    t.mock.timers.tick(1000); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE, TERMINAL]);
    assert.deepEqual(fake.raw.eventNames(), []);
});

test('stop during a pending heartbeat alone cannot schedule later comments', async (t) => {
    clock(t);
    const fake = fakeResponse(false);
    const writer = createSseWriter(fake.res, { intervalMs: 10 });
    t.mock.timers.tick(10); await flush();
    writer.stop();
    fake.setWritable(true); fake.drain(); await flush();
    t.mock.timers.tick(1000); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    assert.deepEqual(fake.raw.eventNames(), []);
});

test('main backpressure suppresses heartbeats and concurrent calls cannot build a queue', async (t) => {
    clock(t);
    const fake = fakeResponse(false);
    const writer = createSseWriter(fake.res, { intervalMs: 1, writeTimeoutMs: 1000 });
    t.after(writer.stop);
    const main = writer.write(DATA);
    fake.raw.writableNeedDrain = false; fake.raw.writableLength = 0;
    for (let i = 0; i < 100; i++) { t.mock.timers.tick(1); await flush(); }
    await assert.rejects(writer.write(TERMINAL), /Concurrent SSE writes/);
    assert.deepEqual(fake.frames, [DATA]);
    assert.equal(fake.raw.listenerCount('drain'), 1);
    fake.setWritable(true); fake.drain(); await main;
    writer.stop();
    await writer.write(TERMINAL);
    assert.deepEqual(fake.frames, [DATA, TERMINAL]);
});

test('heartbeat timeout is observed once without an awaiting main write or unhandled rejection', async (t) => {
    clock(t);
    const fake = fakeResponse(false);
    const onError = t.mock.fn<(error: unknown) => void>();
    const writer = createSseWriter(fake.res, { intervalMs: 10, writeTimeoutMs: 25, onError });
    t.after(writer.stop);
    t.mock.timers.tick(10); await flush();
    t.mock.timers.tick(25); await flush();
    assert.equal(onError.mock.callCount(), 1);
    const failure = onError.mock.calls[0].arguments[0];
    assert.match(String(failure), /backpressure/);
    await assert.rejects(writer.write(DATA), error => error === failure);
    await assert.rejects(writer.write(TERMINAL), error => error === failure);
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    assert.equal(fake.raw.destroyed, true);
    assert.equal(onError.mock.callCount(), 1);
    assert.deepEqual(fake.raw.eventNames(), []);
});

for (const outcome of ['error', 'close', 'timeout'] as const) {
    test(`pending main write rejects without hanging after stopped heartbeat ${outcome}`, async (t) => {
        clock(t);
        const fake = fakeResponse(false);
        const onError = t.mock.fn<(error: unknown) => void>();
        const writer = createSseWriter(fake.res, { intervalMs: 10, writeTimeoutMs: 25, onError });
        t.after(writer.stop);
        t.mock.timers.tick(10); await flush();
        writer.stop();
        const main = assert.rejects(writer.write(TERMINAL), /blocked heartbeat|client[ _]disconnected|backpressure/i);
        if (outcome === 'error') fake.raw.emit('error', new Error('blocked heartbeat'));
        else if (outcome === 'close') fake.raw.destroy();
        else t.mock.timers.tick(25);
        await main;
        assert.equal(onError.mock.callCount(), 1);
        assert.deepEqual(fake.frames, [KEEPALIVE]);
        assert.deepEqual(fake.raw.eventNames(), []);
    });
}

test('synchronous heartbeat write failure is retained and throwing error reporter stays handled', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const failure = new Error('synchronous write failed');
    t.mock.method(fake.raw, 'write', () => { throw failure; });
    const onError = t.mock.fn(() => { throw new Error('reporter failed'); });
    const writer = createSseWriter(fake.res, { intervalMs: 10, onError });
    t.after(writer.stop);
    t.mock.timers.tick(10); await flush();
    await assert.rejects(writer.write(DATA), error => error === failure);
    assert.equal(onError.mock.callCount(), 1);
    assert.deepEqual(fake.frames, []);
});

test('asynchronous keepalive and error callback failures cannot escape the timer', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const failure = new Error('keepalive observer failed');
    const onError = t.mock.fn(async () => { throw new Error('error observer failed'); });
    const writer = createSseWriter(fake.res, {
        intervalMs: 10,
        onKeepalive: async () => { throw failure; },
        onError,
    });
    t.after(writer.stop);
    t.mock.timers.tick(10); await flush();
    await assert.rejects(writer.write(DATA), error => error === failure);
    assert.equal(onError.mock.callCount(), 1);
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(fake.frames, [KEEPALIVE]);
});

test('upstream inactivity and cache deadlines are not extended by downstream-only callbacks', async (t) => {
    clock(t);
    const expired: string[] = [];
    const upstreamProgress = t.mock.fn(() => { setTimeout(() => expired.push('upstream'), 250); });
    const cacheProgress = t.mock.fn(() => { setTimeout(() => expired.push('cache'), 350); });
    upstreamProgress(); cacheProgress();
    const fake = fakeResponse();
    const onKeepalive = t.mock.fn<(frame: string) => void>();
    const writer = createSseWriter(fake.res, { intervalMs: 100, onKeepalive });
    t.after(writer.stop);
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(100); await flush(); }
    assert.deepEqual(expired, ['upstream', 'cache']);
    assert.equal(upstreamProgress.mock.callCount(), 1);
    assert.equal(cacheProgress.mock.callCount(), 1);
    assert.equal(onKeepalive.mock.callCount(), 4);
    assert.deepEqual(fake.frames, [KEEPALIVE, KEEPALIVE, KEEPALIVE, KEEPALIVE]);
});

test('active heartbeat and lifecycle error observers report the same failure only once', async (t) => {
    clock(t);
    const fake = fakeResponse(false);
    const onError = t.mock.fn<(error: unknown) => void>();
    const writer = createSseWriter(fake.res, { intervalMs: 10, onError });
    t.after(writer.stop);
    t.mock.timers.tick(10); await flush();
    const failure = new Error('socket failed during heartbeat drain');
    fake.raw.emit('error', failure); await flush();
    await assert.rejects(writer.write(DATA), error => error === failure);
    assert.equal(onError.mock.callCount(), 1);
    assert.equal(onError.mock.calls[0].arguments[0], failure);
    assert.deepEqual(fake.raw.eventNames(), []);
});

test('asynchronous main-write failure is retained even after a successful write return', async (t) => {
    clock(t);
    const fake = fakeResponse();
    const onError = t.mock.fn<(error: unknown) => void>();
    const writer = createSseWriter(fake.res, { intervalMs: 10, onError });
    t.after(writer.stop);
    const failure = new Error('socket failed after write returned true');
    const rejected = assert.rejects(writer.write(DATA), error => error === failure);
    fake.raw.emit('error', failure);
    await rejected;
    await assert.rejects(writer.write(TERMINAL), error => error === failure);
    t.mock.timers.tick(100); await flush();
    assert.deepEqual(fake.frames, [DATA]);
    assert.equal(onError.mock.callCount(), 1);
});

test('heartbeat failure without an error callback is handled and retained', async (t) => {
    clock(t);
    const fake = fakeResponse(false);
    const writer = createSseWriter(fake.res, { intervalMs: 10, writeTimeoutMs: 25 });
    t.after(writer.stop);
    t.mock.timers.tick(10); await flush();
    t.mock.timers.tick(25); await flush();
    await assert.rejects(writer.write(DATA), /backpressure/);
    assert.deepEqual(fake.frames, [KEEPALIVE]);
    assert.deepEqual(fake.raw.eventNames(), []);
});

test('heartbeat timer is unrefed so idle streams do not pin the event loop', () => {
    const fake = fakeResponse();
    const original = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replacement = ((callback: () => void, delay: number) => {
        timer = original(callback, delay);
        return timer;
    }) as typeof setTimeout;
    const mock = test.mock.method(globalThis, 'setTimeout', replacement);
    let writer: ReturnType<typeof createSseWriter> | undefined;
    try {
        writer = createSseWriter(fake.res);
        assert.ok(timer);
        assert.equal(timer.hasRef(), false);
    } finally { writer?.stop(); mock.mock.restore(); }
});
