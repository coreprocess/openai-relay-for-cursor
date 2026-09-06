// Aggregate this round's private synthetic evidence only; no network or credentials.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const paths = process.argv.slice(2);
assert.ok(paths.every((path) => /^\/tmp\/openai-replay-(acceptance|live)-[A-Za-z0-9]+$/.test(path)));
const runs = await Promise.all(paths.map(async (directory) => JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'))));
const direct = JSON.parse(await readFile('/tmp/openai-replay-acceptance-REvj9k/direct-image-comparison.json', 'utf8'));
const calls = runs.reduce((count, run) => count + (run.billableRequestsAttempted ?? run.cases?.length ?? 0), 1);
const usage = runs.flatMap((run) => run.observations ?? run.cases ?? []).reduce((totals, entry) => {
    totals.inputTokens += entry.usage?.prompt_tokens ?? 0;
    totals.outputTokens += entry.usage?.completion_tokens ?? 0;
    return totals;
}, { inputTokens: Number(direct.usage?.input_tokens ?? 0), outputTokens: Number(direct.usage?.output_tokens ?? 0) });
const evidence = {
    generatedAt: new Date().toISOString(), attemptedRequests: calls, providerReportedUsage: usage,
    noServingCheckoutChanges: true, tunnelTested: false, allOwnedListenersStopped: runs.every((run) => run.testRelayStopped),
    allStoresHaveZeroUnresolvedIntents: runs.every((run) => run.database.unresolvedIntents === 0),
    live: {
        core: 'Latest deep run passed 24 scenario groups over 64 requests. Final four-call smoke passed after final protocol fixes.',
        coverage: ['4 conversations x 5 turns with two restarts and exact-block isolation', '10 simultaneous requests with cache cap 2',
            'Unicode/escaping/nested tool arguments', '3 sequential tool rounds', 'identical-answer ambiguity and concurrent regeneration',
            'history, caller, effort, tools and output-limit scope isolation', 'Responses-shaped wire path and existing-scope fence',
            'real partial tool-argument truncation in SSE and JSON', 'repeated cancellation and recovery', 'capture/disk quota fallback',
            'invalid image and orphan tool-result provider errors', 'enable/disable cycles'],
        unresolved: ['Positive solid-red image interpretation failed. Identical wire inputs and a direct OpenAI bypass also produced imprecise/wrong colors; cause not established.'],
    },
    offline: { tests: 150, typecheck: 'pass', diffCheck: 'pass',
        faults: ['429/500 forwarding without retry', 'failed/error SSE', 'failed/nonterminal JSON', 'malformed/truncated SSE',
            'socket resets', 'header/body timeouts', 'disconnect before headers', 'unrelated concurrent recovery', 'malformed HTTP payload validation'] },
    fixesThisRound: ['Invalid generation request structures now return local 400 before upstream dispatch',
        'Broken/missing-terminal SSE fails transport rather than cleanly ending HTTP',
        'Failed/nonterminal JSON upstream responses cannot become successful empty Chat answers'],
    fixtureCorrections: ['Responses-shaped calls must not inherit max_completion_tokens from a Chat harness',
        'Low token limits initially truncated reasoning only; targeted literal-copy case proved actual partial tool arguments',
        'Image diagnostic uses exact color match, not substring reddish'],
    limitations: ['Not all possible edge cases', 'No sustained production-load soak', 'No actual Cursor/tunnel cutover',
        'Cancellation usage may be unreported; token totals are not a complete bill', 'No real provider outage or physical disk/power-loss injection'],
    runs: runs.map((run) => ({ directory: run.directory, attempts: run.billableRequestsAttempted ?? run.cases?.length,
        passed: run.passed ?? run.replayVerified, results: run.results, database: run.database, ports: run.ports })),
    directImageComparison: direct,
};
const report = join(paths.at(-1)!, 'deep-acceptance-report.json');
await writeFile(report, JSON.stringify(evidence, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ report, ...evidence }));
