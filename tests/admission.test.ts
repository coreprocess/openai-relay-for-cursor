import assert from 'node:assert/strict';
import test from 'node:test';
import { CacheAdmission } from '../src/reasoning/admission.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';

test('default cache budget admits eight small concurrent generations, not just one', () => {
    const admission = new CacheAdmission(loadCacheConfig({}));
    const releases: Array<() => void> = [];
    for (let i = 0; i < 8; i++) {
        const release = admission.reserve(5000);
        assert.ok(release);
        releases.push(release);
    }
    assert.equal(admission.reserve(5000), null);
    for (const release of releases) { release(); release(); }
    assert.equal(admission.activeSessions, 0);
    assert.equal(admission.retainedBytes, 0);
});

test('actual history size governs leases and large concurrent histories degrade caching only', () => {
    const admission = new CacheAdmission(loadCacheConfig({}));
    const releases: Array<() => void> = [];
    for (let i = 0; i < 4; i++) {
        const release = admission.reserve(6 * 1024 * 1024);
        assert.ok(release);
        releases.push(release);
    }
    assert.equal(admission.reserve(6 * 1024 * 1024), null);
    releases.forEach((release) => release());
    assert.ok(admission.reserve(6 * 1024 * 1024));
});

test('enabled budgets must fit shared workspace before any request is prepared', () => {
    assert.throws(() => new CacheAdmission({ ...loadCacheConfig({}), enabled: true, memoryBytes: 1024 }), /workspace/);
    // Disabled installations do not use canonicalization and must keep working.
    const disabled = new CacheAdmission({ ...loadCacheConfig({}), memoryBytes: 1024 });
    assert.equal(disabled.reserve(5000), null);
});

test('capacity reasons distinguish concurrency from memory and invalid measurements fail closed', () => {
    const config = loadCacheConfig({});
    const concurrency = new CacheAdmission({ ...config, maxConcurrent: 1 });
    const release = concurrency.reserve(100)!;
    assert.equal(concurrency.refusalReason(100), 'maxConcurrent');
    release();
    assert.equal(concurrency.refusalReason(100), null);
    assert.equal(concurrency.refusalReason(config.memoryBytes), 'memory');
    assert.throws(() => concurrency.reserve(-1), /measured/);
    assert.throws(() => concurrency.reserve(NaN), /measured/);
});
