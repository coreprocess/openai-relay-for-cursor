// Bounded follow-up: 16 real requests maximum, no tunnel or serving-checkout changes.
import assert from 'node:assert/strict';
import type { JsonBody } from '../src/http.ts';
import { openAcceptance, assertCompleted, containsBlock } from './live-acceptance-support.ts';

const suite = await openAcceptance();
type Result = Awaited<ReturnType<typeof suite.request>>;
const seedHistories = [131, 137, 149, 157].map((number) => [{ role: 'user',
    content: `Compute (${number} * 173 + 251) * 197. Output only the final integer.` }]);
let seeds: Result[] = [];
try {
    await suite.check('four simultaneous cache-enabled requests complete', async () => {
        seeds = await Promise.all(seedHistories.map((messages, i) => suite.request(`four-seed-${i}`, { messages, stream: i % 2 === 0, user: `four-${i}` })));
        for (const [i, result] of seeds.entries()) {
            assertCompleted(result); assert.equal(result.observation.cacheControls, true);
            assert.equal(String(result.observation.text).trim(), String(([131, 137, 149, 157][i]! * 173 + 251) * 197));
        }
    });
    await suite.restart();
    await suite.check('four concurrent followups replay their own blocks after restart', async () => {
        assert.equal(seeds.length, 4);
        const results = await Promise.all(seedHistories.map((messages, i) => suite.request(`four-next-${i}`, {
            messages: [...messages, seeds[i]!.envelope, { role: 'user', content: 'Add 7 to that result; output only the new integer.' }],
            stream: i % 2 !== 0, user: `four-${i}`,
        })));
        let observedHits = 0;
        for (const [i, result] of results.entries()) {
            assertCompleted(result);
            assert.equal(String(result.observation.text).trim(), String(([131, 137, 149, 157][i]! * 173 + 251) * 197 + 7));
            if (Number(seeds[i]!.observation.encryptedOutput) > 0) { assert.ok(containsBlock(result.input, seeds[i]!.output)); observedHits++; }
            for (let j = 0; j < seeds.length; j++) if (j !== i) assert.equal(containsBlock(result.input, seeds[j]!.output), false);
        }
        assert.ok(observedHits > 0, 'At least one encrypted response needed to prove live replay');
    });
    await suite.check('same-prefix identical visible generations become ambiguous rather than replaying either branch', async () => {
        const messages = [{ role: 'user', content: 'Compute 137 times 173. Output only the integer.' }];
        const body = { messages, stream: true, user: 'ambiguity-probe' };
        const first = await suite.request('ambiguous-first', body); assertCompleted(first);
        const second = await suite.request('ambiguous-second', body); assertCompleted(second);
        assert.equal(first.observation.text, second.observation.text, 'Requires identical visible projection');
        assert.notEqual(JSON.stringify(first.output), JSON.stringify(second.output), 'Requires independently generated outputs');
        const next = await suite.request('ambiguous-next', { ...body,
            messages: [...messages, first.envelope, { role: 'user', content: 'Repeat that exact integer.' }] });
        assertCompleted(next); assert.equal(next.observation.encryptedInput, 0);
    });
    await suite.check('moderately large synthetic context retains information and encrypted replay', async () => {
        const rows = Array.from({ length: 1000 }, (_, i) => `record ${String(i).padStart(4, '0')}: quantity=${i + 2}; unit_price=${(i % 17) + 1}; state=synthetic; marker=row-${i}`).join('\n');
        const messages: JsonBody[] = [{ role: 'system', content: 'Use supplied synthetic records only. Output concise results.' },
            { role: 'user', content: `${rows}\nCompute quantity times unit_price for record 0999, and report its marker.` }];
        const first = await suite.request('large-seed', { messages, stream: true, user: 'large-context' }); assertCompleted(first);
        const expected = (999 + 2) * ((999 % 17) + 1);
        assert.ok(String(first.observation.text).replace(/[,.]/g, '').includes(String(expected)));
        assert.match(String(first.observation.text), /row-999/);
        const next = await suite.request('large-followup', { messages: [...messages, first.envelope,
            { role: 'user', content: 'Subtract 15 from that computed value. Give only the resulting number.' }], stream: false, user: 'large-context' });
        assertCompleted(next); assert.equal(String(next.observation.text).trim().replace(/[,.]/g, ''), String(expected - 15));
        if (Number(first.observation.encryptedOutput) > 0) assert.ok(containsBlock(next.input, first.output));
    });
    await suite.check('unknown dropped field observes a competing generation without making old reasoning reusable', async () => {
        const messages = [{ role: 'user', content: 'Compute 151 times 197. Output only the integer.' }];
        const base = { messages, stream: false, user: 'observe-only-competitor' };
        const first = await suite.request('observed-seed', base); assertCompleted(first);
        const competing = await suite.request('observed-competitor', { ...base, unsupported_top_level: 'drop' }); assertCompleted(competing);
        assert.equal(competing.observation.cacheControls, false);
        assert.equal(first.observation.text, competing.observation.text);
        const next = await suite.request('observed-next', { ...base, messages: [...messages, competing.envelope,
            { role: 'user', content: 'Repeat that integer.' }] });
        assertCompleted(next); assert.equal(next.observation.encryptedInput, 0);
    });
    await suite.check('no unresolved work before test shutdown', () => suite.waitForIdle());
} finally {
    await suite.close();
    if (suite.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}
