// Three-call, explicitly authorized follow-up for the acceptance suite's two failures.
import assert from 'node:assert/strict';
import { openAcceptance, assertCompleted } from './live-acceptance-support.ts';
const suite = await openAcceptance();
try {
    await suite.check('JSON token exhaustion reports length', async () => {
        const result = await suite.request('json-length-recheck', { stream: false, max_completion_tokens: 16,
            messages: [{ role: 'user', content: 'List 500 English nouns, one per line.' }] });
        assert.equal(result.observation.http, 200); assert.equal(result.observation.upstreamStatus, 'incomplete');
        assert.equal(result.observation.finish, 'length');
    });
    await suite.check('actual client cancellation occurs after visible text', async () => {
        const result = await suite.request('cancel-recheck', { model: 'relay-gpt-6-astra-low', stream: true, max_completion_tokens: 2048,
            messages: [{ role: 'user', content: 'Count from 1 to 300, writing each integer on its own line. Begin immediately.' }] }, { cancel: true });
        assert.equal(result.observation.canceled, true); assert.ok(Number(result.observation.chunks) > 0);
        await suite.waitForIdle();
    });
    await suite.check('client cancellation during reasoning clears the active intent', async () => {
        const result = await suite.request('cancel-headers', { stream: true, max_completion_tokens: 512,
            messages: [{ role: 'user', content: 'Calculate 1234567 times 891011 and explain the arithmetic briefly.' }] }, { cancelHeaders: true });
        assert.equal(result.observation.canceled, true);
        await suite.waitForIdle();
    });
    await suite.check('service works after canceled generation', async () => {
        const result = await suite.request('after-cancel-recheck', { stream: true,
            messages: [{ role: 'user', content: 'Return only the integer (137 * 17 + 23) * 19.' }] });
        assertCompleted(result); assert.equal(String(result.observation.text).trim(), '44688');
    });
} finally {
    await suite.close();
    if (suite.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}
