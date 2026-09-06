// Six explicitly authorized calls: three public JPEGs, relay vs exact-wire direct Responses.
// Excluded from pnpm test; never starts a tunnel or changes the serving checkout.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAcceptance, assertCompleted } from './live-acceptance-support.ts';
import type { JsonBody } from '../src/http.ts';

const suite = await openAcceptance(3);
const fixtures = [
    { id: 237, path: '/tmp/relay-picsum-237.jpg', url: 'https://picsum.photos/id/237/512/512.jpg', expected: 'dog', pattern: /\b(dog|puppy|labrador|retriever)\b/i },
    { id: 1025, path: '/tmp/relay-picsum-1025.jpg', url: 'https://picsum.photos/id/1025/512/512.jpg', expected: 'dog', pattern: /\b(dog|puppy|pug)\b/i },
    { id: 10, path: '/tmp/relay-picsum-10.jpg', url: 'https://picsum.photos/id/10/640/480.jpg', expected: 'outdoor landscape', pattern: /\b(landscape|lake|mountain|forest|trees|water|hill|valley)\b/i },
];
const comparisons: JsonBody[] = [];
let directCalls = 0;
suite.summary.fixtureSource = 'https://picsum.photos/';
suite.summary.imageComparisons = comparisons;
try {
    for (const fixture of fixtures) {
        await suite.check(`photo ${fixture.id}: relay and direct provider identify the broad subject`, async () => {
            const bytes = await readFile(fixture.path);
            assert.equal(bytes.readUInt16BE(0), 0xffd8, 'Fixture must be JPEG');
            const image = `data:image/jpeg;base64,${bytes.toString('base64')}`;
            const prompt = 'Describe only what is actually visible in this attached photograph, in two short sentences. Identify the main subject, its appearance and surroundings. If you cannot see the image, say so; do not invent details.';
            const result = await suite.request(`picsum-${fixture.id}`, {
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image, detail: 'high' } }] }],
                user: `picsum-comparison-${fixture.id}`, stream: false, max_completion_tokens: 1024,
            });
            assertCompleted(result);
            assert.ok(result.wire, 'Actual dispatched payload must be logged');
            const input = result.wire.input as Array<{ content: JsonBody[] }>;
            const part = input[0]!.content.find((item) => item.type === 'input_image');
            assert.equal(part?.image_url, image);
            const directStarted = performance.now();
            directCalls++;
            const response = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST', headers: { authorization: `Bearer ${suite.config.openAiApiKey}`, 'content-type': 'application/json' },
                // Exactly the body dispatched by the relay, not a second conversion or URL fetch.
                body: JSON.stringify(result.wire), signal: AbortSignal.timeout(90_000),
            });
            const raw = await response.json() as JsonBody;
            await writeFile(join(suite.directory, `direct-photo-${fixture.id}.json`), JSON.stringify(raw, null, 2), { mode: 0o600 });
            const directText = ((raw.output ?? []) as Array<{ content?: Array<{ type: string; text?: string }> }>)
                .flatMap((item) => item.content ?? []).filter((item) => item.type === 'output_text').map((item) => item.text ?? '').join('');
            const relayText = String(result.observation.text);
            const comparison: JsonBody = {
                id: fixture.id, sourceUrl: fixture.url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
                imageInputUnchanged: true, identicalRequestBodies: true, expectedBroadSubject: fixture.expected,
                relay: { status: result.observation.http, text: relayText, usage: result.observation.usage,
                    broadSubjectMatch: fixture.pattern.test(relayText), durationMs: result.observation.elapsedMs },
                direct: { status: response.status, responseStatus: raw.status, text: directText, usage: raw.usage,
                    broadSubjectMatch: fixture.pattern.test(directText), durationMs: Math.round(performance.now() - directStarted) },
            };
            comparisons.push(comparison);
            console.log(JSON.stringify({ event: 'photo-comparison', ...comparison }));
            assert.equal(response.status, 200);
            assert.equal(raw.status, 'completed');
            assert.ok(fixture.pattern.test(relayText), 'Relay-side broad-subject description did not match fixture');
            assert.ok(fixture.pattern.test(directText), 'Direct broad-subject description did not match fixture');
        });
    }
    await suite.check('image tests leave no unresolved sessions or intents', () => suite.waitForIdle());
} finally {
    suite.summary.directProviderRequests = directCalls;
    suite.summary.totalRequests = directCalls + fixtures.length;
    await suite.close();
    if (suite.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}
