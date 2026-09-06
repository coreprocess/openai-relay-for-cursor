// Aggregate existing test-owned summaries only. No API requests or secret reads.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const paths = process.argv.slice(2);
assert.ok(paths.length > 0 && paths.every((path) => /^\/tmp\/openai-replay-acceptance-[A-Za-z0-9]+$/.test(path)));
const runs = await Promise.all(paths.map(async (directory) => JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))));
const totals = runs.reduce((sum, run) => {
    sum.requests += run.billableRequestsAttempted ?? 0;
    for (const observation of run.observations ?? []) {
        sum.inputTokens += observation.usage?.prompt_tokens ?? 0;
        sum.outputTokens += observation.usage?.completion_tokens ?? 0;
        sum.cachedInputTokens += observation.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    }
    return sum;
}, { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
const evidence = {
    generatedAt: new Date().toISOString(), totals, model: 'gpt-6-astra', noTunnel: true,
    allTestRelaysStopped: runs.every((run) => run.testRelayStopped),
    allStoresHaveZeroUnresolvedIntents: runs.every((run) => run.database.unresolvedIntents === 0),
    ports: runs.flatMap((run) => run.ports),
    runs: runs.map((run) => ({ directory: run.directory, attempted: run.billableRequestsAttempted, passed: run.passed,
        checks: run.results.map((result: unknown) => result), database: run.database })),
    notes: [
        'Initial run found a JSON finish_reason truncation bug; fixed and verified by focused and full reruns.',
        'Initial cancellation trigger did not see visible output; later supported-low-effort and header-abort cases actually canceled.',
        'A cancellation fixture used unsupported effort none; provider rejection was preserved and corrected fixture used low.',
        'Extended large-context expected arithmetic was wrong; fixture-derived result and replay passed focused rerun.',
        'Token totals are provider-reported completed usage only; canceled/error calls may incur unreported usage.',
        'No assertion of actual Cursor/tunnel cutover, sustained load, power-loss durability, or provider fault injection.',
    ],
};
const path = join(paths.at(-1)!, 'acceptance-report.json');
await writeFile(path, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ report: path, ...evidence }));
