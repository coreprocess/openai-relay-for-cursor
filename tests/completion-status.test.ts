import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test from 'node:test';
import { toChatCompletion } from '../src/convertResponse.ts';
import { ReplaySession } from '../src/reasoning/session.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { PreparedIdentity } from '../src/reasoning/types.ts';
import type { ReplayStore } from '../src/reasoning/store.ts';

test('JSON token exhaustion maps to length even when only reasoning or partial calls exist', () => {
    for (const output of [[], [{ type: 'reasoning', encrypted_content: 'synthetic' }],
        [{ type: 'function_call', id: 'f', call_id: 'c', name: 'lookup', arguments: '{' }]]) {
        const result = toChatCompletion({ id: 'response', model: 'test', status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' }, output });
        assert.equal(result.choices[0]!.finish_reason, 'length');
    }
    assert.equal(toChatCompletion({ id: 'r', model: 'test', status: 'completed', output: [] }).choices[0]!.finish_reason, 'stop');
});

test('upstream terminal failures poison cache without aborting terminal delivery', () => {
    const events: string[] = [];
    const store = { poison: () => events.push('poison'), resolve: () => events.push('resolve') } as unknown as ReplayStore;
    const identity: PreparedIdentity = { eligible: true,
        scope: { digest: 'scope', credential: 'test', model: 'test', caller: 'test' },
        messages: [], prefixes: ['start'], envelopes: [], canonicalBytes: 0,
        append: () => ({ endDigest: 'end', envelopeFingerprint: 'envelope' }) };
    const session = new ReplaySession(store, 'intent', identity, loadCacheConfig({}), () => events.push('release'));
    const response = new EventEmitter() as ServerResponse;
    session.bind(response);
    session.finishWithoutCapture();
    assert.deepEqual(events, ['poison']);
    assert.equal(session.controller.signal.aborted, false);
    response.emit('finish');
    session.requestFinished();
    assert.deepEqual(events, ['poison', 'release']);
});
