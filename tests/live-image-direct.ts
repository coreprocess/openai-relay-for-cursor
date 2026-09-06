// Single authorized diagnostic bypassing the relay, using only a prior synthetic test image.
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
assert.equal(process.env.ALLOW_BILLABLE_REPLAY_SMOKE, '1');
assert.ok(process.env.REPLAY_SMOKE_KEY_FILE);
const directory = process.argv[2];
assert.ok(/^\/tmp\/openai-replay-acceptance-[A-Za-z0-9]+$/.test(directory ?? ''));
const key = parseEnv(await readFile(process.env.REPLAY_SMOKE_KEY_FILE, 'utf8')).OPENAI_API_KEY;
assert.ok(key);
const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
const logs = await readdir(join(directory, 'logs'));
let wire;
for (const name of logs.filter((name) => name.endsWith('0-client-headers.json'))) {
    const headers = JSON.parse(await readFile(join(directory, 'logs', name), 'utf8'));
    if (headers['x-test-case'] !== 'image-native-diagnostic') continue;
    wire = JSON.parse(await readFile(join(directory, 'logs', name.replace('0-client-headers.json', '2-upstream-request.json')), 'utf8'));
}
assert.ok(wire?.input?.[0]?.content?.some((part: { type?: string }) => part.type === 'input_image'));
const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...wire, stream: false, max_output_tokens: 512, store: false }), signal: AbortSignal.timeout(90_000),
});
const body = await response.json() as { status?: string; output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>; usage?: unknown; error?: unknown };
const text = (body.output ?? []).flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text ?? '').join('');
const evidence = { directOpenAI: true, relayBypassed: true, sourceTestDirectory: directory, status: response.status,
    responseStatus: body.status, expectedColor: 'red', text, expectedColorMentioned: /\bred\b/i.test(text),
    interpretation: 'Unresolved vision/fixture behavior; substring matches such as reddish are not a color-identification pass.', usage: body.usage,
    sameInputAsRelay: true, priorRelayResults: summary.observations.map((o: { tag: string; text: string }) => ({ tag: o.tag, text: o.text })) };
await writeFile(join(directory, 'direct-image-comparison.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify(evidence));
if (response.status !== 200) process.exitCode = 1;
