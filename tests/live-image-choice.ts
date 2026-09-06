// Manual billable test: exact visual-choice scoring, matched direct/relay inputs, no tunnel.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAcceptance, assertCompleted } from './live-acceptance-support.ts';
import type { JsonBody } from '../src/http.ts';

const suite = await openAcceptance(5);
const choices = [
    ['a cat', 'a dog', 'a fish', 'something else', 'cannot determine from the supplied image'],
    ['a dog', 'a fish', 'something else', 'a cat', 'cannot determine from the supplied image'],
    ['a fish', 'something else', 'a cat', 'a dog', 'cannot determine from the supplied image'],
];
const fixtures = [
    { path: '/tmp/relay-picsum-237.jpg', order: 0, expected: 'B', subject: 'dog' },
    { path: '/tmp/relay-picsum-10.jpg', order: 0, expected: 'D', subject: 'landscape' },
    { path: '/tmp/relay-picsum-1025.jpg', order: 1, expected: 'A', subject: 'dog' },
    { path: '/tmp/relay-picsum-237.jpg', order: 2, expected: 'D', subject: 'dog-reordered' },
    { path: null, order: 0, expected: 'E', subject: 'no-image-control' },
];
const evidence: JsonBody[] = [];
let directRequests = 0;
suite.summary.exactChoiceResults = evidence;
suite.summary.scoring = 'Exact single uppercase letter. No trimming, case folding, regex subject matching, or retry.';
try {
    for (const [index, fixture] of fixtures.entries()) {
        await suite.check(`exact visual classification ${index + 1}`, async () => {
            const options = choices[fixture.order]!;
            const prompt = 'Which option best describes the main subject of the attached image?\n' +
                options.map((option, i) => `${String.fromCharCode(65 + i)}) ${option}`).join('\n') +
                '\nIf no image is attached or you cannot see it, choose the cannot-determine option. ' +
                'Respond with exactly one uppercase letter from A, B, C, D, E. No spaces, punctuation or explanation.';
            const content: JsonBody[] = [{ type: 'text', text: prompt }];
            let digest: string | null = null;
            let image: string | null = null;
            if (fixture.path) {
                const bytes = await readFile(fixture.path);
                assert.equal(bytes.readUInt16BE(0), 0xffd8);
                digest = createHash('sha256').update(bytes).digest('hex');
                image = `data:image/jpeg;base64,${bytes.toString('base64')}`;
                content.push({ type: 'image_url', image_url: { url: image, detail: 'high' } });
            }
            const result = await suite.request(`visual-${randomUUID()}`, {
                messages: [{ role: 'user', content }], stream: false, max_completion_tokens: 512,
                user: `visual-${randomUUID()}`,
            });
            assertCompleted(result);
            assert.ok(result.wire);
            const sent = (result.wire.input as Array<{ content: JsonBody[] }>)[0]!.content;
            assert.equal(sent[0]!.text, prompt);
            assert.equal(sent.find((part) => part.type === 'input_image')?.image_url ?? null, image);
            directRequests++;
            const response = await fetch('https://api.openai.com/v1/responses', {
                method: 'POST', headers: { authorization: `Bearer ${suite.config.openAiApiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify(result.wire), signal: AbortSignal.timeout(90_000),
            });
            const direct = await response.json() as JsonBody;
            await writeFile(join(suite.directory, `direct-choice-${index + 1}.json`), JSON.stringify(direct, null, 2), { mode: 0o600 });
            const directText = ((direct.output ?? []) as Array<{ content?: Array<{ type: string; text?: string }> }>)
                .flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text ?? '').join('');
            const relayText = String(result.observation.text);
            const scored = {
                case: index + 1, expectedSubject: fixture.subject, expected: fixture.expected, sha256: digest, options,
                samePromptAndImage: true, relay: { status: result.observation.http, answer: relayText, correct: relayText === fixture.expected },
                direct: { status: response.status, responseStatus: direct.status, answer: directText, correct: directText === fixture.expected, usage: direct.usage },
            };
            evidence.push(scored);
            console.log(JSON.stringify({ event: 'exact-choice', ...scored }));
            assert.equal(response.status, 200); assert.equal(direct.status, 'completed');
            assert.equal(relayText, fixture.expected, 'Relay exact-choice mismatch');
            assert.equal(directText, fixture.expected, 'Direct exact-choice mismatch');
        });
    }
    await suite.check('exact-choice test leaves no active work', () => suite.waitForIdle());
} finally {
    suite.summary.directProviderRequests = directRequests;
    suite.summary.totalRequests = directRequests + evidence.length;
    await suite.close();
    if (suite.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}
