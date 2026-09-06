import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import { ReplayRuntime } from '../src/reasoning/runtime.ts';
import type { RelayConfig } from '../src/config.ts';
import { chatToResponsesBody } from '../src/chatToResponses.ts';
import { CacheUnavailableError } from '../src/reasoning/admission.ts';

const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'replay-runtime-'));
    const config: RelayConfig = {
        cache: { ...loadCacheConfig({}), enabled: true, reserveBytes: 1, dbPath: join(dir, 'cache.sqlite') },
        host: '127.0.0.1', port: 0, relayToken: 'token', openAiApiKey: 'fake', upstreamOrigin: 'https://example.invalid',
        modelPrefix: '', defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined,
        logBodies: false, logDir: join(dir, 'logs'),
    };
    return { config, dir };
};

test('cache saturation forwards normally after durably covering the unobserved position', () => {
    const { config, dir } = fixture();
    config.cache.maxConcurrent = 1;
    const runtime = new ReplayRuntime(config);
    const chat = { model: 'test', messages: [{ role: 'user', content: 'hello' }] };
    const outbound = chatToResponsesBody(chat, { aliasEffort: undefined, defaultEffort: 'high' }).body;
    try {
        const first = runtime.prepare(chat, outbound, {}, true);
        assert.ok(first.session);
        assert.deepEqual(runtime.prepare(chat, outbound, {}, true), { payload: null, session: null });
        first.session.abort();
        const next = runtime.prepare(chat, outbound, {}, true);
        assert.ok(next.session);
        next.session.abort();
    } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed safety writes never produce a passthrough result or leak an admission lease', () => {
    const { config, dir } = fixture();
    config.cache.maxConcurrent = 1;
    const runtime = new ReplayRuntime(config);
    const chat = { model: 'test', messages: [{ role: 'user', content: 'hello' }] };
    const outbound = { model: 'test', input: [] };
    const store = runtime.store!;
    try {
        const first = runtime.prepare(chat, outbound, {}, true);
        const bypass = store.bypass;
        store.bypass = () => { throw new Error('synthetic disk fault'); };
        assert.throws(() => runtime.prepare(chat, outbound, {}, true), CacheUnavailableError);
        store.bypass = bypass;
        first.session!.abort();
        const begin = store.begin;
        store.begin = () => { throw new Error('synthetic begin fault'); };
        assert.throws(() => runtime.prepare(chat, outbound, {}, true), CacheUnavailableError);
        store.begin = begin;
        const next = runtime.prepare(chat, outbound, {}, true);
        assert.ok(next.session, 'failed preparation must release its lease');
        next.session.abort();
    } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('disabled runtime retains exclusive ownership until its unobserved traffic stops', () => {
    const { config, dir } = fixture();
    new ReplayRuntime(config).close();
    const disabled = new ReplayRuntime({ ...config, cache: { ...config.cache, enabled: false } });
    try {
        assert.throws(() => new ReplayRuntime(config), /locked|busy/i);
        assert.deepEqual(disabled.prepare({ model: 'test', messages: [] }, { model: 'test', input: [] }, {}, true),
            { payload: null, session: null });
    } finally { disabled.close(); }
    const enabled = new ReplayRuntime(config);
    enabled.close();
    rmSync(dir, { recursive: true, force: true });
});

test('direct Responses passthrough never enters Chat capture even if it contains messages', () => {
    const { config, dir } = fixture();
    const runtime = new ReplayRuntime(config);
    try {
        assert.deepEqual(runtime.prepare({ model: 'test', messages: [] }, { model: 'test', messages: [] }, {}, true,
            '/v1/responses', false), { payload: null, session: null });
    } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('deterministic history refusal does not write an intent or change baseline payload', () => {
    const { config, dir } = fixture();
    config.cache.limits.maxMessages = 1;
    const runtime = new ReplayRuntime(config);
    const chat = { model: 'test', messages: [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }] };
    try {
        assert.deepEqual(runtime.prepare(chat, { model: 'test', input: [] }, {}, true), { payload: null, session: null });
    } finally { runtime.close(); rmSync(dir, { recursive: true, force: true }); }
});
