import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildWidgetSnapshot,
    WIDGET_ROW_LIMIT,
    type WidgetItemInput,
    type WidgetTripInput,
} from '../src/features/archive/widget-snapshot.ts';

// 固定「现在」：2026-11-25 09:45 本地时区（避免测试随真实时钟漂移）
const NOW = new Date(2026, 10, 25, 9, 45, 0, 0).getTime();
const TODAY = '2026-11-25';

let seq = 0;

function trip(overrides: Partial<WidgetTripInput> & { start_date: string }): WidgetTripInput {
    seq += 1;
    return {
        id: `trip-${seq}`,
        title: `行程 ${seq}`,
        end_date: 'open',
        ...overrides,
    };
}

function item(tripId: string, localDate: string, time: string, overrides: Partial<WidgetItemInput> = {}): WidgetItemInput {
    seq += 1;
    return {
        id: `item-${seq}`,
        trip_id: tripId,
        local_date: localDate,
        time,
        title: `事项 ${seq}`,
        status: 'pending',
        completed_at: null,
        wrap_closed_at: null,
        ...overrides,
    };
}

test('no trips at all produces an empty snapshot (widget shows the empty-state line)', () => {
    const snap = buildWidgetSnapshot([], [], NOW);
    assert.deepEqual(snap, { tripId: '', tripTitle: '', items: [] });
});

test('finished (locked) trips never render, even when their dates are most recent', () => {
    const locked = trip({ start_date: '2026-11-20', end_date: '2026-11-24' }); // 已结束
    const open = trip({ start_date: TODAY, end_date: '2026-11-27' });
    const snap = buildWidgetSnapshot([locked, open], [item(locked.id, '2026-11-23', '10:00')], NOW);
    assert.equal(snap.tripId, open.id);
    assert.equal(snap.items.length, 0); // 锁定行程的项不参与
});

test('among active trips the latest start_date wins (user ruling: newest itinerary)', () => {
    const older = trip({ start_date: '2026-11-20', end_date: '2026-11-30' });
    const newer = trip({ start_date: '2026-11-24', end_date: '2026-12-01' });
    const snap = buildWidgetSnapshot([older, newer], [], NOW);
    assert.equal(snap.tripId, newer.id);
});

test('items are ordered today-first then future dates ascending, capped at the row limit', () => {
    const active = trip({ start_date: TODAY });
    const items = [
        item(active.id, '2026-11-27', '08:00'),
        item(active.id, TODAY, '16:00'),
        item(active.id, '2026-11-26', '07:30'),
        item(active.id, TODAY, '11:00'),
        item(active.id, TODAY, '09:30'),
    ];
    const snap = buildWidgetSnapshot([active], items, NOW);
    assert.equal(snap.items.length, WIDGET_ROW_LIMIT);
    assert.deepEqual(
        snap.items.map((row) => row.time),
        ['09:30', '11:00', '16:00', '11-26 07:30'],
    );
});

test('same-day items render plain HH:mm, future-day items carry the MM-DD prefix', () => {
    const active = trip({ start_date: TODAY });
    const snap = buildWidgetSnapshot(
        [active],
        [item(active.id, TODAY, '18:05'), item(active.id, '2026-11-26', '09:00')],
        NOW,
    );
    assert.equal(snap.items[0].time, '18:05');
    assert.equal(snap.items[1].time, '11-26 09:00');
});

test('phase labels follow the derived phase machine (ongoing window, pending, done)', () => {
    const active = trip({ start_date: TODAY });
    const snap = buildWidgetSnapshot(
        [active],
        [
            item(active.id, TODAY, '09:30'), // 到点 15min：30min 窗口内 → 进行中
            item(active.id, TODAY, '11:00'), // 未到点 → 待进行
        ],
        NOW,
    );
    assert.equal(snap.items[0].status, 'ongoing');
    assert.equal(snap.items[0].phase, '进行中');
    assert.equal(snap.items[1].status, 'pending');
    assert.equal(snap.items[1].phase, '待进行');
    // dueAt = 本地时刻组合（双端就地重推导时间派生档的数据面）
    assert.equal(snap.items[1].dueAt, new Date(2026, 10, 25, 11, 0, 0, 0).getTime());
});

test('completed items keep their wrap/done tone in the list and past-day items never show', () => {
    const active = trip({ start_date: '2026-11-24' });
    const snap = buildWidgetSnapshot(
        [active],
        [
            item(active.id, '2026-11-24', '10:00'), // 昨天 → 过滤
            item(active.id, TODAY, '08:00', { status: 'done' }), // 库里历史 done 值 → wrap 阶段词表
            item(active.id, TODAY, '10:30'),
        ],
        NOW,
    );
    assert.equal(snap.items.length, 2);
    assert.equal(snap.items[0].status, 'wrap');
    assert.equal(snap.items[0].phase, '收尾');
});

test('empty title falls back through tripDisplayTitle, keeping the card header readable', () => {
    const active = trip({ start_date: TODAY, title: '  ' });
    const snap = buildWidgetSnapshot([active], [], NOW);
    assert.equal(snap.tripTitle, '未命名行程');
});
