import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { RelayFailure, safeFailure } from '../src/failure.ts';
import { RequestTransport, transportLimits } from '../src/transport.ts';
import { loadCacheConfig } from '../src/reasoning/config.ts';
import type { RelayConfig } from '../src/config.ts';

const config = { cache: loadCacheConfig({}) } as RelayConfig;
test('failure diagnostics expose only allowlisted classifications and never exception text', () => {
    const error = new Error('private prompt with sk-secret and https://provider?token=secret', { cause: { code: 'UND_ERR_SOCKET', message: 'secret body' } });
    error.name = 'UserSuppliedSecret';
    const result = safeFailure(error, new RelayFailure('client_disconnected'));
    assert.deepEqual(result, { reason: 'client_disconnected', errorType: 'Error', errorCode: null, causeCode: 'UND_ERR_SOCKET' });
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(safeFailure({ message: 'private' }).reason, 'request_failed');
    const injected = Object.assign(new Error('private'), { code: 'secret-id' });
    assert.equal(safeFailure(injected).errorCode, null);
});

test('keepalive defaults to 15 seconds, zero disables, and invalid values fail validation', () => {
    assert.equal(transportLimits(config).sseKeepaliveMs, 15000);
    assert.equal(transportLimits({ ...config, transport: { sseKeepaliveMs: 0 } }).sseKeepaliveMs, 0);
    assert.throws(() => transportLimits({ ...config, transport: { sseKeepaliveMs: -1 } }));
    assert.throws(() => transportLimits({ ...config, transport: { sseKeepaliveMs: NaN } }));
});

test('transport records client close independently from upstream rejection', () => {
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false }) as ServerResponse;
    const transport = new RequestTransport(response, transportLimits(config));
    transport.receivedHeaders(200); transport.clientFrame(); transport.keepalive();
    response.emit('close');
    assert.equal((transport.controller.signal.reason as RelayFailure).reason, 'client_disconnected');
    const status = transport.diagnostics();
    assert.equal(status.upstreamStatus, 200); assert.equal(status.downstream, 'client_close');
    assert.equal(status.keepalives, 1); assert.equal(status.visibleFrames, 0);
    assert.equal(response.listenerCount('close'), 0);
});

test('local keepalives do not renew transport upstream inactivity', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const response = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false, destroy() { this.destroyed = true; } }) as unknown as ServerResponse;
    const transport = new RequestTransport(response, { ...transportLimits(config), idleTimeoutMs: 100 });
    t.mock.timers.tick(60); transport.keepalive(); t.mock.timers.tick(40);
    assert.equal((transport.controller.signal.reason as RelayFailure).reason, 'upstream_idle_timeout');
    assert.equal(response.destroyed, true);
});
