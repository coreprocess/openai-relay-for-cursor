import assert from 'node:assert/strict';
import test from 'node:test';
import { ProgressDeadline, type DeadlineUpdate } from '../src/reasoning/lifecycle.ts';

const clock = () => {
    let now = 0;
    let nextId = 0;
    const pending = new Map<number, { callback: () => void; at: number }>();
    const history = new Map<number, () => void>();
    return {
        now: () => now,
        set: (value: number) => { now = value; },
        schedule: (callback: () => void, delay: number) => {
            const id = ++nextId;
            pending.set(id, { callback, at: now + delay });
            history.set(id, callback);
            return id;
        },
        cancel: (id: unknown) => { pending.delete(id as number); },
        fireStale: (id: number) => history.get(id)!(),
        runDue: () => {
            for (const [id, timer] of [...pending]) {
                if (timer.at <= now) { pending.delete(id); timer.callback(); }
            }
        },
        pending,
    };
};

test('defaults to a 15-minute initial idle deadline', () => {
    const timer = clock();
    const renewed: DeadlineUpdate[] = [];
    const expired: DeadlineUpdate[] = [];
    const deadline = new ProgressDeadline({ ...timer, onRenew: (event) => renewed.push(event), onExpire: (event) => expired.push(event) });
    assert.equal(deadline.deadline, 900_000);
    assert.deepEqual(renewed, [{ phase: 'generation', deadline: 900_000 }]);
    timer.set(900_000);
    timer.runDue();
    assert.deepEqual(expired, [{ phase: 'generation', deadline: 900_000 }]);
    assert.equal(deadline.disposed, true);
});

test('progress indefinitely renews idle timeout without an absolute generation timeout', () => {
    const timer = clock();
    const expired: DeadlineUpdate[] = [];
    const deadline = new ProgressDeadline({ ...timer, idleTimeoutMs: 100, onExpire: (event) => expired.push(event) });
    for (let time = 90; time <= 9_000; time += 90) {
        timer.set(time);
        assert.equal(deadline.progress(), true);
        timer.runDue();
    }
    assert.equal(deadline.deadline, 9_100);
    assert.equal(expired.length, 0);
    timer.set(9_100);
    timer.runDue();
    assert.equal(expired.length, 1);
});

test('delivery uses a separate fixed timeout and ignores late progress', () => {
    const timer = clock();
    const expired: DeadlineUpdate[] = [];
    const deadline = new ProgressDeadline({ ...timer, idleTimeoutMs: 100, deliveryTimeoutMs: 20, onExpire: (event) => expired.push(event) });
    timer.set(50);
    assert.equal(deadline.beginDelivery(), true);
    assert.equal(deadline.phase, 'delivery');
    assert.equal(deadline.deadline, 70);
    timer.set(60);
    assert.equal(deadline.progress(), false);
    assert.equal(deadline.beginDelivery(), false);
    timer.fireStale(1);
    assert.equal(expired.length, 0);
    timer.set(70);
    timer.runDue();
    assert.deepEqual(expired, [{ phase: 'delivery', deadline: 70 }]);
});

test('stale generation timer cannot expire a newly renewed deadline', () => {
    const timer = clock();
    let expirations = 0;
    const deadline = new ProgressDeadline({ ...timer, idleTimeoutMs: 100, onExpire: () => expirations++ });
    timer.set(90);
    deadline.progress();
    timer.set(100);
    timer.fireStale(1);
    assert.equal(expirations, 0);
    timer.set(190);
    timer.runDue();
    timer.fireStale(2);
    assert.equal(expirations, 1);
});

test('late progress and delivery cannot resurrect expired idle work before timer dispatch', () => {
    for (const action of ['progress', 'beginDelivery'] as const) {
        const timer = clock();
        let expirations = 0;
        const deadline = new ProgressDeadline({ ...timer, idleTimeoutMs: 100, onExpire: () => expirations++ });
        timer.set(100);
        assert.equal(deadline[action](), false);
        assert.equal(expirations, 1);
        assert.equal(deadline.progress(), false);
        timer.fireStale(1);
        assert.equal(expirations, 1);
    }
});

test('explicit dispose cancels timers and makes all late callbacks harmless', () => {
    const timer = clock();
    let expirations = 0;
    const deadline = new ProgressDeadline({ ...timer, onExpire: () => expirations++ });
    deadline.dispose();
    deadline.dispose();
    timer.set(1_000_000);
    timer.fireStale(1);
    assert.equal(expirations, 0);
    assert.equal(timer.pending.size, 0);
    assert.equal(deadline.progress(), false);
    assert.equal(deadline.beginDelivery(), false);
});

test('early timer wakeups reschedule without false expiration or renewal notifications', () => {
    const timer = clock();
    let expirations = 0;
    let renewals = 0;
    const deadline = new ProgressDeadline({ ...timer, idleTimeoutMs: 100, onRenew: () => renewals++, onExpire: () => expirations++ });
    timer.set(40);
    timer.fireStale(1);
    assert.equal(expirations, 0);
    assert.equal(renewals, 1);
    assert.equal(deadline.deadline, 100);
    timer.set(100);
    timer.runDue();
    assert.equal(expirations, 1);
});

test('clock regression cannot move a renewed deadline backwards', () => {
    const timer = clock();
    const deadline = new ProgressDeadline({ ...timer, idleTimeoutMs: 100, onExpire: () => {} });
    timer.set(80);
    deadline.progress();
    timer.set(10);
    deadline.progress();
    assert.equal(deadline.deadline, 180);
    deadline.dispose();
});

test('phase changes and disposal inside callbacks cannot be overwritten', () => {
    const timer = clock();
    let deadline: ProgressDeadline | undefined;
    let expirations = 0;
    deadline = new ProgressDeadline({
        ...timer, idleTimeoutMs: 100, deliveryTimeoutMs: 20,
        onRenew: ({ phase }) => { if (phase === 'generation') deadline?.beginDelivery(); },
        onExpire: () => { expirations++; assert.equal(deadline!.progress(), false); },
    });
    timer.set(10);
    assert.equal(deadline.progress(), false);
    assert.equal(deadline.phase, 'delivery');
    assert.equal(deadline.deadline, 30);
    timer.set(30);
    timer.runDue();
    assert.equal(expirations, 1);
});

test('throwing renewal callbacks dispose the timer rather than leaking it', () => {
    const timer = clock();
    assert.throws(() => new ProgressDeadline({ ...timer, onRenew: () => { throw new Error('renew failed'); }, onExpire: () => {} }), /renew failed/);
    assert.equal(timer.pending.size, 0);
});

test('rejects invalid timeout durations and partial scheduler injection', () => {
    for (const idleTimeoutMs of [0, -1, Infinity, NaN, 2_147_483_648]) {
        assert.throws(() => new ProgressDeadline({ idleTimeoutMs, onExpire: () => {} }), RangeError);
    }
    assert.throws(() => new ProgressDeadline({ schedule: () => 1, onExpire: () => {} }), TypeError);
});
