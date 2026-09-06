import assert from 'node:assert/strict';
import test from 'node:test';
import { created, faultFixture, reasoning, sendHealthy, sse, type Outcome } from './fault-fixture.ts';

const options = { concurrency: false, timeout: 8_000 };
const upstreamError = { code: 'synthetic_fault', message: 'Synthetic upstream failure', param: null };
const terminal = (type: 'response.failed' | 'error') => type === 'error' ? { type, ...upstreamError } :
    { type, response: { id: 'synthetic-response', model: 'fault-model', status: 'failed', error: upstreamError, output: [] } };
const frames = (outcome: Outcome) => outcome.body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    assert.ok(frame.startsWith('data: '), `unexpected client SSE frame: ${frame}`);
    return frame.slice(6);
});
const assertTerminalFailure = (outcome: Outcome, partial = '') => {
    assert.equal(outcome.status, 200, JSON.stringify(outcome));
    assert.equal(outcome.complete, true, JSON.stringify(outcome));
    const data = frames(outcome);
    assert.equal(data.filter((value) => value === '[DONE]').length, 1, outcome.body);
    assert.equal(data.at(-1), '[DONE]', outcome.body);
    const events = data.filter((value) => value !== '[DONE]').map((value) => JSON.parse(value));
    assert.deepEqual(events.filter((event) => event.error).map((event) => event.error), [upstreamError]);
    assert.equal(events.flatMap((event) => event.choices ?? []).map((choice) => choice.delta?.content ?? '').join(''), partial);
    assert.equal(events.flatMap((event) => event.choices ?? []).some((choice) => choice.finish_reason === 'stop'), false);
    assert.equal(outcome.body.includes('synthetic-fault-cipher'), false, 'reasoning ciphertext must never reach the client');
};

for (const status of [429, 500]) for (const stream of [false, true]) {
    test(`transport: upstream ${status} JSON preserves exact error bytes with stream=${stream} and never retries`, options, async (t) => {
        const app = await faultFixture(t);
        const body = ` {\n  "error": { "message": "Synthetic ${status} — do not retry", "code": "test_${status}" }\n}\n`;
        app.route('http-fault', ({ res }) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '0' });
            res.end(body);
        });
        const outcome = await app.start('http-fault', stream).done;
        t.diagnostic(`observed status=${outcome.status}, complete=${outcome.complete}, body=${JSON.stringify(outcome.body)}`);
        assert.deepEqual(outcome, { status, complete: true, body });
        await app.idle();
        await app.healthy();
        await app.idle(1);
        assert.equal(app.received.filter((entry) => entry.prompt === 'http-fault').length, 1, 'upstream error must not be retried');
    });
}

test('transport: failed Responses JSON is not converted into a successful empty answer', options, async (t) => {
    const app = await faultFixture(t);
    app.route('failed-json', ({ res }) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'r', model: 'fault-model', status: 'failed', error: upstreamError, output: [] }));
    });
    const outcome = await app.start('failed-json', false).done;
    assert.equal(outcome.status, 502);
    assert.deepEqual(JSON.parse(outcome.body), { error: upstreamError });
    await app.idle(); await app.healthy(); await app.idle(1);
});

test('transport: nonterminal JSON response cannot masquerade as a completed Chat answer', options, async (t) => {
    const app = await faultFixture(t);
    app.route('pending-json', ({ res }) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'r', model: 'fault-model', status: 'in_progress', output: [] }));
    });
    const outcome = await app.start('pending-json', false).done;
    assert.equal(outcome.status, 502);
    assert.ok(JSON.parse(outcome.body).error);
    await app.idle(); await app.healthy(); await app.idle(1);
});

for (const type of ['response.failed', 'error'] as const) {
    test(`transport: ${type} SSE is delivered once with one DONE and no cache state`, options, async (t) => {
        const app = await faultFixture(t);
        app.route('terminal-fault', ({ res }) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            // Coalesced repeated terminals must not duplicate the visible error or DONE.
            res.end(sse(created) + sse(reasoning) + sse(terminal(type)) + sse(terminal(type)));
        });
        const outcome = await app.start('terminal-fault').done;
        t.diagnostic(`observed ${type}: ${JSON.stringify(outcome)}`);
        assertTerminalFailure(outcome);
        await app.idle();
        await app.healthy();
        await app.idle(1);
        assert.equal(app.received.filter((entry) => entry.prompt === 'terminal-fault').length, 1);
    });
}

for (const [name, suffix] of [
    ['malformed SSE JSON', 'data: {this-is-not-json}\n\n'],
    ['premature EOF without terminal', ''],
    ['abrupt EOF inside terminal frame', 'data: {"type":"response.completed","response":'],
] as const) {
    test(`transport: ${name} admits no capture and leaks no intent or session`, options, async (t) => {
        const app = await faultFixture(t);
        app.route('broken-stream', ({ res }) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(sse(created) + sse(reasoning) + suffix);
        });
        const outcome = await app.start('broken-stream').done;
        t.diagnostic(`observed ${name}: ${JSON.stringify(outcome)}`);
        assert.equal(outcome.status, 200, JSON.stringify(outcome));
        assert.equal(outcome.complete, false, 'broken stream must not end as a successful HTTP transfer');
        assert.equal(outcome.body.includes('[DONE]'), false, 'truncated generation must not announce successful completion');
        assert.equal(outcome.body.includes('"finish_reason":"stop"'), false);
        assert.equal(outcome.body.includes('synthetic-fault-cipher'), false);
        await app.idle();
        await app.healthy();
        await app.idle(1);
        assert.equal(app.received.filter((entry) => entry.prompt === 'broken-stream').length, 1);
    });
}

for (const mode of ['silent headers', 'silent SSE body', 'silent JSON body', 'silent HTTP error body'] as const) {
    test(`transport: idle timeout stops ${mode} and frees the intent before fixture cleanup`, options, async (t) => {
        const app = await faultFixture(t, { idleTimeoutMs: 120 });
        app.route('silent', ({ res }) => {
            if (mode === 'silent headers') return;
            res.writeHead(mode === 'silent HTTP error body' ? 500 : 200, {
                'content-type': mode === 'silent SSE body' ? 'text/event-stream' : 'application/json',
            });
            res.flushHeaders();
        });
        const started = performance.now();
        const client = app.start('silent', mode !== 'silent JSON body');
        const exchange = await app.arrived('silent');
        assert.equal(app.state().intents, 1, 'test must exercise a dispatched intent, not bypass');
        assert.equal(app.state().active, 1);
        let outcome: Outcome | undefined;
        void client.done.then((value) => { outcome = value; });
        await app.waitFor(() => outcome !== undefined, 'relay idle watchdog must terminate silent upstream', 1_500);
        const elapsed = performance.now() - started;
        t.diagnostic(`observed ${mode}: ${JSON.stringify(outcome)}, elapsed=${elapsed.toFixed(0)}ms`);
        assert.ok(elapsed >= 60 && elapsed < 1_500, `timeout must be owned by the 120ms idle deadline: ${elapsed}ms`);
        assert.equal(outcome!.complete, false, 'silent response must not turn into a successful empty completion');
        assert.equal(outcome!.body.includes('[DONE]'), false);
        await app.waitFor(() => exchange.closed, 'idle expiry must cancel the upstream transport');
        await app.idle();
        await app.healthy();
        await app.idle(1);
        assert.equal(app.received.filter((entry) => entry.prompt === 'silent').length, 1);
    });
}

for (const mode of ['response.failed', 'error', 'malformed SSE', 'socket reset'] as const) {
    test(`transport: ${mode} after client-visible partial text leaves no orphan state`, options, async (t) => {
        const app = await faultFixture(t);
        app.route('partial', ({ res }) => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.write(sse(created) + sse(reasoning) + sse({ type: 'response.output_text.delta', delta: 'Visible partial text' }));
        });
        const client = app.start('partial');
        const exchange = await app.arrived('partial');
        await app.waitFor(() => client.body.includes('Visible partial text'), 'partial text must be visible before injecting failure');
        assert.equal(app.state().intents, 1);
        if (mode === 'socket reset') exchange.res.destroy();
        else exchange.res.end(mode === 'malformed SSE' ? 'data: invalid-json\n\n' : sse(terminal(mode)));
        const outcome = await client.done;
        t.diagnostic(`observed partial ${mode}: ${JSON.stringify(outcome)}`);
        if (mode === 'response.failed' || mode === 'error') assertTerminalFailure(outcome, 'Visible partial text');
        else {
            assert.equal(outcome.status, 200, JSON.stringify(outcome));
            assert.equal(outcome.complete, false);
            assert.equal(outcome.body.includes('[DONE]'), false);
            assert.equal(outcome.body.includes('"finish_reason":"stop"'), false);
            const visible = frames(outcome).map((value) => JSON.parse(value)).flatMap((event) => event.choices ?? [])
                .map((choice) => choice.delta?.content ?? '').join('');
            assert.equal(visible, 'Visible partial text');
        }
        await app.waitFor(() => exchange.closed, 'failed upstream must close');
        await app.idle();
        await app.healthy();
        await app.idle(1);
    });
}

test('transport: client disconnect before upstream headers cancels intent without unhandled errors', options, async (t) => {
    const app = await faultFixture(t);
    app.route('disconnect', () => {});
    const client = app.start('disconnect');
    const exchange = await app.arrived('disconnect');
    assert.equal(client.status, null, 'upstream must not have sent headers');
    assert.equal(app.state().sessions, 1);
    assert.equal(app.state().intents, 1);
    client.disconnect();
    const outcome = await client.done;
    t.diagnostic(`observed disconnect: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.status, null);
    assert.equal(outcome.complete, false);
    await app.waitFor(() => exchange.closed, 'client disconnect must abort the pending upstream request');
    await app.idle();
    await app.healthy();
    await app.idle(1);
    assert.deepEqual(app.unhandledErrors, []);
    assert.equal(app.received.filter((entry) => entry.prompt === 'disconnect').length, 1);
});

test('transport: one failed request does not cancel an unrelated concurrent generation or block a new healthy request', options, async (t) => {
    const app = await faultFixture(t, { maxConcurrent: 2 });
    app.route('held-healthy', () => {});
    app.route('concurrent-fault', () => {});
    const held = app.start('held-healthy', false);
    const healthyExchange = await app.arrived('held-healthy');
    const failed = app.start('concurrent-fault');
    const faultExchange = await app.arrived('concurrent-fault');
    assert.equal(app.state().sessions, 2, 'both upstream generations must overlap');
    assert.equal(app.state().intents, 2);
    faultExchange.res.writeHead(200, { 'content-type': 'text/event-stream' });
    faultExchange.res.end(sse(created) + sse(terminal('response.failed')));
    assertTerminalFailure(await failed.done);
    await app.waitFor(() => app.state().active === 1 && app.state().intents === 1, 'only the failed lease must be released');
    assert.equal(healthyExchange.closed, false, 'failure must not cancel the unrelated request');
    // The second slot must be reusable while the first healthy generation is still held.
    await app.healthy('healthy-after-failure');
    assert.equal(app.state().intents, 1);
    sendHealthy(healthyExchange);
    const outcome = await held.done;
    assert.equal(outcome.status, 200, JSON.stringify(outcome));
    assert.equal(outcome.complete, true, JSON.stringify(outcome));
    assert.equal(JSON.parse(outcome.body).choices[0].message.content, 'Healthy: held-healthy');
    await app.idle(2);
    assert.equal(app.received.length, 3, 'concurrent failures must not trigger retries');
});
