import assert from 'node:assert/strict';
import test from 'node:test';
import { SizedHotCache } from '../src/reasoning/resources.ts';

test('hot cache charges replacements and evicts only its own copies', () => {
    const cache = new SizedHotCache<string>(10);
    cache.set('a', 'A', 6);
    cache.set('b', 'B', 4);
    assert.equal(cache.retainedBytes, 10);
    cache.get('a');
    cache.set('c', 'C', 4);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 'A');
    cache.set('a', 'small', 1);
    assert.equal(cache.retainedBytes, 5);
    cache.set('huge', 'skip', 11);
    assert.equal(cache.get('huge'), undefined);
    cache.clear();
    assert.equal(cache.retainedBytes, 0);
});
