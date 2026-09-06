import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCacheConfig } from '../src/reasoning/config.ts';

test('cache is opt-in and retention cannot be shorter than 30 days', () => {
    assert.equal(loadCacheConfig({}).enabled, false);
    assert.equal(loadCacheConfig({ REASONING_CACHE_ENABLED: '1' }).enabled, true);
    assert.throws(() => loadCacheConfig({ REASONING_CACHE_IDLE_DAYS: '29' }));
    assert.throws(() => loadCacheConfig({ REASONING_CACHE_MEMORY_MAX_BYTES: 'NaN' }));
});
