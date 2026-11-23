import assert from 'node:assert/strict';
import test from 'node:test';
import {
    orderTripItems,
    TRIP_ITEM_PHASE_LABEL,
    tripItemDoneAt,
    tripItemPhase,
    type TripItemPhase,
    type TripItemPhaseInput,
} from '../src/features/archive/trip-item-logic.ts';

const MIN = 60_000;

function item(overrides: Partial<TripItemPhaseInput> & { time: string }): TripItemPhaseInput {
    return {
        status: 'pending',
        local_date: '2026-11-24',
        title: 'T',
        completed_at: null,
        wrap_closed_at: null,
        ...overrides,
    };
}

const due = (time: string) => {
    const [h, m] = time.split(':').map(Number);
    return new Date(2026, 10, 24, h, m, 0, 0).getTime();
};

test('doneAt is the earlier of +30min and the next item due', () => {
    assert.equal(tripItemDoneAt(due('10:00'), undefined), due('10:00') + 30 * MIN);
    assert.equal(tripItemDoneAt(due('10:00'), due('10:10')), due('10:10'));
    assert.equal(tripItemDoneAt(due('10:00'), due('10:45')), due('10:00') + 30 * MIN);
});

test('phase is pending before the due time', () => {
    const now = due('10:00') - MIN;
    assert.equal(tripItemPhase(item({ time: '10:00' }), now), 'pending');
});

test('phase is ongoing from due until doneAt', () => {
    const now = due('10:00') + 5 * MIN;
    assert.equal(tripItemPhase(item({ time: '10:00' }), now, due('10:10')), 'ongoing');
});

test('phase is done at doneAt', () => {
    const now = due('10:10') + 1;
    assert.equal(tripItemPhase(item({ time: '10:00' }), now, due('10:10')), 'done');
    assert.equal(tripItemPhase(item({ time: '10:00' }), due('10:00') + 31 * MIN), 'done');
});

test('completed_at moves the phase to wrap, wrap_closed_at to terminal', () => {
    const now = due('10:00') + 5 * MIN;
    assert.equal(tripItemPhase(item({ time: '10:00', completed_at: now }), now), 'wrap');
    assert.equal(
        tripItemPhase(item({ time: '10:00', completed_at: now, wrap_closed_at: now + 1 }), now),
        'terminal',
    );
});

test('legacy rows map sanely: status done -> wrap, status failed -> terminal', () => {
    const now = due('10:00') + MIN;
    assert.equal(tripItemPhase(item({ time: '10:00', status: 'done' }), now), 'wrap');
    assert.equal(tripItemPhase(item({ time: '10:00', status: 'failed' }), now), 'terminal');
    // a failed item that has not reached its time is still terminal
    assert.equal(tripItemPhase(item({ time: '10:00', status: 'failed' }), now - 2 * 60 * MIN), 'terminal');
});

test('phase labels cover every phase', () => {
    const phases: TripItemPhase[] = ['pending', 'ongoing', 'done', 'wrap', 'terminal'];
    for (const phase of phases) {
        assert.match(TRIP_ITEM_PHASE_LABEL[phase], /./);
    }
});

test('ordering keeps the exact sequence: ongoing, future desc, settled desc, terminal desc', () => {
    const now = due('10:00') + 5 * MIN;
    const items = [
        item({ time: '18:00' }),
        item({ time: '14:00' }),
        item({ time: '10:00' }),
        item({ time: '09:00' }),
        item({ time: '07:00' }),
        item({ time: '08:00', status: 'failed' }),
    ];
    const times = orderTripItems(items, now).map((i) => i.time);
    assert.deepEqual(times, ['10:00', '18:00', '14:00', '09:00', '07:00', '08:00']);
});