// Two explicitly authorized real calls on an isolated listener; no ngrok or production state.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonBody } from '../src/http.ts';
import { openAcceptance, assertCompleted, containsBlock } from './live-acceptance-support.ts';

const suite = await openAcceptance(2);
suite.config.transport = { sseKeepaliveMs: 250 };
try {
    await suite.check('live reasoning-only interval receives SSE comments and preserves replay', async () => {
        const messages: JsonBody[] = [{ role: 'user', content: 'Invoice: 3 items at 120 EUR plus 2 at 80 EUR, discount goods 10%, add 15 EUR shipping, then VAT 19%. Give the gross total with a short calculation.' }];
        const first = await suite.request('keepalive-seed', { messages, user: 'keepalive-live', stream: true, max_completion_tokens: 2048 });
        assertCompleted(first); assert.match(String(first.observation.text), /574[.,]77/);
        messages.push(first.envelope, { role: 'user', content: 'Change only the discount to 15%. Give the new gross total and savings.' });
        const second = await suite.request('keepalive-next', { messages, user: 'keepalive-live', stream: true, max_completion_tokens: 2048 });
        assertCompleted(second); assert.match(String(second.observation.text), /543[.,]83/);
        assert.ok(Number(first.observation.encryptedOutput) > 0, 'A reasoning item is needed to verify replay');
        assert.ok(containsBlock(second.input, first.output));
        const names = await readdir(suite.config.logDir);
        const frameFiles = names.filter((name) => name.endsWith('4-client-response.sse'));
        assert.equal(frameFiles.length, 2);
        const counts: number[] = [];
        for (const name of frameFiles) {
            const text = await readFile(join(suite.config.logDir, name), 'utf8');
            const comments = text.match(/^: keepalive$/gm) ?? [];
            counts.push(comments.length);
            assert.ok(comments.length > 0);
            assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
            assert.ok(!text.slice(text.indexOf('data: [DONE]')).includes(': keepalive'));
        }
        suite.summary.keepaliveFramesPerResponse = counts;
        suite.summary.intervalMs = 250;
        suite.summary.exactReasoningReplay = true;
        await suite.waitForIdle();
    });
} finally {
    await suite.close();
    if (suite.results.some((result) => result.status !== 'pass')) process.exitCode = 1;
}
