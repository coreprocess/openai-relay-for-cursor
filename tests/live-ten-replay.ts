// Manual opt-in: ten real concurrent seeds, then ten concurrent replay continuations after restart.
// No serving checkout changes, no ngrok, and no imported production conversation contents.
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import type { JsonBody } from '../src/http.ts';
import { openAcceptance, assertCompleted, containsBlock } from './live-acceptance-support.ts';

const suite = await openAcceptance(20);
const values = Array.from({ length: 10 }, (_, i) => 137 + i);
const histories: JsonBody[][] = values.map((n) => [{ role: 'user', content: `Compute (${n} * 173 + 251) * 197. Return only the integer.` }]);
try {
    assert.equal(suite.config.cache.maxConcurrent, 10);
    const first = await Promise.all(histories.map(async (messages, i) => {
        // Stagger only request headers slightly to avoid saturating the four diagnostic-file writers;
        // provider generations still overlap. Full overlap is asserted by the offline barrier test.
        await pause(i * 40);
        return suite.request(`ten-seed-${i}`, { messages, user: `simplify-${i}`, stream: i % 2 === 0, max_completion_tokens: 1024 });
    }));
    await suite.check('ten simultaneous requests complete correctly with full cache admission', () => {
        first.forEach((result, i) => {
            assertCompleted(result);
            assert.equal(String(result.observation.text).trim(), String((values[i]! * 173 + 251) * 197));
            assert.equal(result.observation.cacheControls, true);
        });
    });
    await suite.waitForIdle(); await suite.restart();
    const next = await Promise.all(histories.map(async (messages, i) => {
        await pause(i * 40);
        return suite.request(`ten-next-${i}`, {
            messages: [...messages, first[i]!.envelope, { role: 'user', content: 'Add 7. Return only the new integer.' }],
            user: `simplify-${i}`, stream: i % 2 !== 0, max_completion_tokens: 1024,
        });
    }));
    await suite.check('ten continuations preserve exact compatible replay after restart without cross-talk', () => {
        let hits = 0;
        next.forEach((result, i) => {
            assertCompleted(result);
            assert.equal(String(result.observation.text).trim(), String((values[i]! * 173 + 251) * 197 + 7));
            assert.equal(result.observation.cacheControls, true);
            if (Number(first[i]!.observation.encryptedOutput) > 0) { assert.ok(containsBlock(result.input, first[i]!.output)); hits++; }
            for (let j = 0; j < first.length; j++) if (j !== i) assert.equal(containsBlock(result.input, first[j]!.output), false);
        });
        assert.ok(hits >= 5, 'Enough encrypted seeds must exist to make the replay test meaningful');
        suite.summary.verifiedReplayContinuations = hits;
    });
    await suite.check('all live sessions and intents settle', () => suite.waitForIdle());
} catch (error) {
    suite.results.push({ name: 'live ten-agent execution', status: 'fail', error: error instanceof Error ? error.message : 'Request failed' });
    process.exitCode = 1;
} finally {
    await suite.close();
    if (suite.results.some((r) => r.status !== 'pass')) process.exitCode = 1;
}
