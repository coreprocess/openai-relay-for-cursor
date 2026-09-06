import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import type { RelayConfig } from '../src/config.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';

const history = [{ role: 'user', content: 'hello' }];
const answer = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] };
const output = (cipher = 'opaque-A') => [
    { type: 'reasoning', id: 'r1', summary: [], encrypted_content: cipher },
    { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] },
];

const setup = async (enabled: boolean) => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-offline-'));
    const received: Record<string, unknown>[] = [];
    let cipher = 'opaque-A';
    let tools = false;
    const upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        received.push(body);
        const responseOutput = tools ? [output(cipher)[0]!,
            ...[0, 1].map((i) => ({ type: 'function_call', id: `fc${i}`, call_id: `call${i}`, name: 'lookup', arguments: '{ "q": "test" }', status: 'completed' })),
        ] : output(cipher);
        const response = { id: 'resp1', model: 'test-model', status: 'completed', output: responseOutput };
        if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
        res.setHeader('content-type', 'text/event-stream');
        const emit = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
        emit({ type: 'response.created', response: { ...response, output: [] } });
        if (tools) {
            for (let i = 0; i < 2; i++) {
                emit({ type: 'response.output_item.added', output_index: i + 1, item: { ...responseOutput[i + 1], arguments: '' } });
                emit({ type: 'response.function_call_arguments.delta', item_id: `fc${i}`, delta: '{ "q": "test" }' });
            }
        } else emit({ type: 'response.output_text.delta', delta: 'Done.' });
        response.output.forEach((item, output_index) => emit({ type: 'response.output_item.done', item, output_index }));
        emit({ type: 'response.completed', response });
        res.end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const config: RelayConfig = {
        host: '127.0.0.1', port: 0, relayToken: 'test-token', openAiApiKey: 'test-key', modelPrefix: 'relay-',
        defaultReasoningEffort: 'high', ngrokAuthtoken: undefined, ngrokDomain: undefined, logBodies: false,
        logDir: join(directory, 'logs'), upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        cache: { ...loadCacheConfig({}), enabled, dbPath: join(directory, 'cache.sqlite'), reserveBytes: 1 },
    };
    let relay = createRelay(config);
    const listen = async () => { relay.server.listen(0, '127.0.0.1'); await once(relay.server, 'listening'); };
    await listen();
    return {
        received, config, setCipher: (value: string) => { cipher = value; }, setTools: () => { tools = true; },
        restart: async (enabled: boolean) => { await relay.close(); config.cache.enabled = enabled; relay = createRelay(config); await listen(); },
        request: async (messages: unknown[], stream = false) => {
            const port = (relay.server.address() as { port: number }).port;
            const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
                method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
                body: JSON.stringify({ model: 'relay-test-model-high', messages, stream, stream_options: { include_usage: true } }),
            });
            const text = await response.text();
            assert.equal(response.status, 200, text);
            return text;
        },
        cleanup: async () => { await relay.close(); upstream.closeAllConnections(); await new Promise<void>((r) => upstream.close(() => r())); await rm(directory, { recursive: true, force: true }); },
    };
};

for (const stream of [false, true]) {
    test(`offline ${stream ? 'SSE' : 'JSON'} capture and replay survive restart`, async () => {
        const app = await setup(true);
        try {
            await app.request(history, stream);
            assert.equal(app.received[0]!.store, false);
            await app.restart(true);
            await app.request([...history, answer, { role: 'user', content: 'continue' }], stream);
            const input = app.received[1]!.input as Record<string, unknown>[];
            assert.equal(input.filter((item) => item.type === 'reasoning').length, 1);
            assert.equal(input.find((item) => item.type === 'reasoning')?.encrypted_content, 'opaque-A');
            assert.equal(input.filter((item) => item.type === 'message').length, 1);
        } finally { await app.cleanup(); }
    });
}

for (const stream of [false, true]) {
    test(`parallel tool continuation restores original blocks (${stream ? 'SSE' : 'JSON'})`, async () => {
        const app = await setup(true);
        app.setTools();
        try {
            await app.request(history, stream);
            const toolAnswer = { role: 'assistant', content: [], tool_calls: [0, 1].map((index) => ({
                index, id: `call${index}`, type: 'function', function: { name: 'lookup', arguments: '{"q":"test"}' },
            })) };
            await app.request([...history, toolAnswer, ...[0, 1].map((i) => ({
                role: 'tool', tool_call_id: `call${i}`, name: 'lookup', content: 'result',
            }))], stream);
            const input = app.received[1]!.input as Record<string, unknown>[];
            assert.equal(input.filter((item) => item.type === 'reasoning').length, 1);
            assert.equal(input.filter((item) => item.type === 'function_call').length, 2);
            assert.equal(input.filter((item) => item.type === 'function_call_output').length, 2);
            assert.equal(input.find((item) => item.type === 'function_call')?.arguments, '{ "q": "test" }');
        } finally { await app.cleanup(); }
    });
}

test('capture budget exhaustion still delivers a successful visible response and clean DONE', async () => {
    const app = await setup(true);
    try {
        app.config.cache.maxEntryBytes = 128;
        const text = await app.request(history, true);
        assert.ok(text.includes('Done.'));
        assert.ok(text.includes('data: [DONE]'));
        assert.ok(!text.includes('"error"'));
        await app.request([...history, answer, { role: 'user', content: 'continue' }], false);
        assert.equal((app.received[1]!.input as Record<string, unknown>[]).some((item) => item.type === 'reasoning'), false);
    } finally { await app.cleanup(); }
});

test('disabled mode preserves baseline and reentry quarantines old uniqueness', async () => {
    const app = await setup(true);
    try {
        await app.request(history);
        await app.restart(false);
        app.setCipher('opaque-B');
        await app.request(history);
        assert.equal(app.received[1]!.store, undefined);
        await app.restart(true);
        await app.request([...history, answer, { role: 'user', content: 'continue' }]);
        assert.equal((app.received[2]!.input as Record<string, unknown>[]).some((item) => item.type === 'reasoning'), false);
    } finally { await app.cleanup(); }
});

test('same visible output with different ciphertext is never replayed', async () => {
    const app = await setup(true);
    try {
        await app.request(history);
        app.setCipher('opaque-B');
        await app.request(history);
        await app.request([...history, answer, { role: 'user', content: 'continue' }]);
        assert.equal((app.received[2]!.input as Record<string, unknown>[]).some((item) => item.type === 'reasoning'), false);
    } finally { await app.cleanup(); }
});
