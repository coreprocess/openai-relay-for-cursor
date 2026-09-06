// Final targeted live boundaries; synthetic data, <=20 attempts, isolated listener only.
import assert from 'node:assert/strict';
import { deflateSync, inflateSync } from 'node:zlib';
import type { JsonBody } from '../src/http.ts';
import { openAcceptance, assertCompleted } from './live-acceptance-support.ts';
const suite = await openAcceptance(20);
const seedMessages: JsonBody[] = [{ role: 'user', content: 'Compute (173 * 137 + 251) * 197. Return only the integer.' }];
const crc32 = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, bytes: Buffer) => {
    const tagged = Buffer.concat([Buffer.from(type), bytes]);
    const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tagged));
    return Buffer.concat([size, tagged, crc]);
};
const png = () => {
    const header = Buffer.alloc(13); header.writeUInt32BE(32, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
    const data = Buffer.alloc((32 * 3 + 1) * 32);
    for (let row = 0; row < 32; row++) for (let col = 0; col < 32; col++) data[row * 97 + 1 + col * 3] = 255;
    const compressed = deflateSync(data);
    const decoded = inflateSync(compressed);
    for (let row = 0; row < 32; row++) for (let col = 0; col < 32; col++) {
        assert.deepEqual([...decoded.subarray(row * 97 + 1 + col * 3, row * 97 + 4 + col * 3)], [255, 0, 0]);
    }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]).toString('base64');
};
try {
    await suite.check('positive data-URL image survives Chat-to-Responses conversion', async () => {
        const messages: JsonBody[] = [{ role: 'user', content: [{ type: 'text', text: 'Name the dominant color in this image in one word.' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png()}`, detail: 'low' } }] }];
        const first = await suite.request('image-positive', { messages, stream: true, user: 'positive-image' }); assertCompleted(first);
        assert.match(String(first.observation.text), /red/i);
        const next = await suite.request('image-next', { messages: [...messages, first.envelope,
            { role: 'user', content: 'Give that color as its standard six-digit hexadecimal code.' }], stream: false, user: 'positive-image' });
        assertCompleted(next); assert.match(String(next.observation.text), /ff0000/i);
    });
    await suite.check('image diagnostic: compare converted Chat versus native Responses body using same pixels', async () => {
        const url = `data:image/png;base64,${png()}`;
        const prompt = 'Describe the color of the supplied image. Name its dominant color, do not guess if the image is unavailable.';
        const chat = await suite.request('image-chat-diagnostic', { stream: false,
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url, detail: 'high' } }] }] });
        const native = await suite.request('image-native-diagnostic', { stream: false, max_output_tokens: 512,
            input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: url, detail: 'high' }] }] });
        assertCompleted(chat); assertCompleted(native);
        assert.deepEqual(chat.wire?.input, native.wire?.input, 'Input image conversion must be exact');
        assert.match(String(chat.observation.text), /red/i);
        assert.match(String(native.observation.text), /red/i);
    });
    await suite.check('simultaneous regenerations create ambiguity before later replay', async () => {
        const body = { messages: seedMessages, user: 'concurrent-identical', stream: true };
        const [first, second] = await Promise.all([suite.request('same-A', body), suite.request('same-B', body)]);
        assertCompleted(first); assertCompleted(second);
        assert.equal(first.observation.text, second.observation.text);
        await suite.waitForIdle();
        const result = await suite.request('same-next', { ...body, messages: [...seedMessages, second.envelope,
            { role: 'user', content: 'Repeat the previous number.' }] });
        assertCompleted(result); assert.equal(result.observation.encryptedInput, 0);
    });
    await suite.check('Responses-shaped traffic fences pre-existing matching caller payloads', async () => {
        const body = { messages: seedMessages, user: 'shape-fence', stream: true };
        const seed = await suite.request('fence-seed', body); assertCompleted(seed);
        assert.ok(Number(seed.observation.encryptedOutput) > 0);
        const direct = await suite.request('fence-direct', { input: [{ role: 'user', content: 'Return only 12345.' }],
            safety_identifier: 'shape-fence', stream: true, max_output_tokens: 128 }); assertCompleted(direct);
        const next = await suite.request('fence-next', { ...body, messages: [...seedMessages, seed.envelope,
            { role: 'user', content: 'Repeat the previous number.' }] });
        assertCompleted(next); assert.equal(next.observation.encryptedInput, 0);
    });
    await suite.check('tiny disk payload quota does not reject valid real model work', async () => {
        await suite.waitForIdle(); const previous = suite.config.cache.diskBytes; suite.config.cache.diskBytes = 1;
        await suite.restart();
        try {
            const body = { messages: seedMessages, user: 'disk-pressure', stream: true };
            const seed = await suite.request('quota-seed', body); assertCompleted(seed);
            const next = await suite.request('quota-next', { ...body, messages: [...seedMessages, seed.envelope,
                { role: 'user', content: 'Add 7 and return only the new number.' }] });
            assertCompleted(next); assert.equal(next.observation.encryptedInput, 0);
        } finally { suite.config.cache.diskBytes = previous; await suite.restart(); }
    });
    await suite.check('repeated enable/disable startup cycles keep service usable and settle all guards', async () => {
        for (let i = 0; i < 3; i++) {
            await suite.restart(i !== 1);
            const result = await suite.request(`toggle-${i}`, { messages: [{ role: 'user', content: `Return only integer ${1000 + i}.` }], stream: i % 2 === 0 });
            assertCompleted(result); assert.equal(result.observation.cacheControls, i !== 1);
            assert.equal(String(result.observation.text).trim(), String(1000 + i));
        }
        await suite.waitForIdle();
    });
} finally { await suite.close(); if (suite.results.some((r) => r.status !== 'pass')) process.exitCode = 1; }
