import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import test from 'node:test';
import { writeClientFrame } from '../src/clientWrite.ts';

const slowResponse = () => {
    const events = new EventEmitter();
    let destroyed = false;
    const response = Object.assign(events, {
        get destroyed() { return destroyed; },
        write: (_bytes: unknown) => false,
        destroy: () => { destroyed = true; events.emit('close'); },
    }) as unknown as ServerResponse;
    return { response, events, destroyed: () => destroyed };
};
test('backpressure deadline bounds passthrough/SSE writes and removes listeners', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fake = slowResponse();
    const result = writeClientFrame(fake.response, Buffer.alloc(64), 50);
    const rejected = assert.rejects(result, /backpressure/);
    t.mock.timers.tick(50);
    await rejected;
    assert.equal(fake.destroyed(), true);
    assert.equal(fake.events.listenerCount('drain'), 0);
    assert.equal(fake.events.listenerCount('error'), 0);
});
test('drain releases backpressure without aborting downstream', async () => {
    const fake = slowResponse();
    const result = writeClientFrame(fake.response, 'frame', 1000);
    fake.events.emit('drain'); await result;
    assert.equal(fake.destroyed(), false);
    assert.equal(fake.events.listenerCount('close'), 0);
});
