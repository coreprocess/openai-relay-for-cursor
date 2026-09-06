import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRelay } from '../src/app.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

const message = [{ role: 'user', content: 'initial' }];
const completed = {
    id: 'response', model: 'test', status: 'completed', output: [
        { type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] },
        { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] },
    ],
};

test('truncated generation poisons only its position; unrelated histories still cache', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'replay-truncation-'));
    let calls = 0;
    const received: Record<string, unknown>[] = [];
    const upstream = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        received.push(JSON.parse(Buffer.concat(chunks).toString()));
        const generation = ++calls;
        res.setHeader('content-type', 'text/event-stream');
        const emit = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        emit({ type: 'response.created', response: { id: 'response', model: 'test' } });
        emit({ type: 'response.output_text.delta', delta: 'Done.' });
        if (generation !== 2) {
            completed.output.forEach((item, output_index) => emit({ type: 'response.output_item.done', item, output_index }));
            emit({ type: 'response.completed', response: completed });
        }
        res.end();
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const config: RelayConfig = {
        cache: { ...loadCacheConfig({}), enabled: true, dbPath: join(directory, 'cache.sqlite'), reserveBytes: 1 },
        host: '127.0.0.1', port: 0, relayToken: 'token', openAiApiKey: 'fake', modelPrefix: '', defaultReasoningEffort: 'high',
        upstreamOrigin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        ngrokAuthtoken: undefined, ngrokDomain: undefined, logBodies: false, logDir: join(directory, 'logs'),
    };
    const relay = createRelay(config);
    relay.server.listen(0, '127.0.0.1');
    await once(relay.server, 'listening');
    const request = async (messages: unknown[]) => {
        const response = await fetch(`http://127.0.0.1:${(relay.server.address() as { port: number }).port}/v1/chat/completions`, {
            method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'test', stream: true, messages }),
        });
        try { await response.text(); }
        catch (error) { if (calls !== 2) throw error; } // Deliberately truncated second generation must fail transport.
    };
    const answer = { role: 'assistant', content: 'Done.' };
    try {
        await request(message);
        await request(message); // Upstream closes without a semantic completion.
        await request([...message, answer, { role: 'user', content: 'next' }]);
        assert.equal((received[2]!.input as Record<string, unknown>[]).some((item) => item.type === 'reasoning'), false);
        const other = [{ role: 'user', content: 'unrelated' }];
        await request(other);
        await request([...other, answer, { role: 'user', content: 'next' }]);
        assert.equal((received[4]!.input as Record<string, unknown>[]).some((item) => item.type === 'reasoning'), true);
    } finally {
        await relay.close(); upstream.closeAllConnections();
        await new Promise<void>((resolve) => upstream.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
    }
});
