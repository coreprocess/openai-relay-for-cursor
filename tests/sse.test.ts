import assert from 'node:assert/strict';
import test from 'node:test';
import { readSseEvents } from '../src/sse.ts';

test('split CRLF and multibyte characters preserve event boundaries', async () => {
    const encoded = new TextEncoder().encode('data: {"text":"😀"}\r\n\r\ndata: [DONE]\r\n\r\n');
    async function* chunks() { for (const byte of encoded) yield Uint8Array.of(byte); }
    const events = [];
    for await (const event of readSseEvents(chunks())) events.push(event.data);
    assert.deepEqual(events, ['{"text":"😀"}', '[DONE]']);
});
