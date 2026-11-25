import assert from 'node:assert/strict';
import test from 'node:test';
import {
    alarmDeepLink,
    alarmRoutePath,
    decideAlarmLadder,
    itemIdFromNotificationId,
    pickDueEntries,
    tripDeepLink,
    type ScheduledAlarmEntry,
} from '../src/features/archive/alarm-ladder.ts';

// ─── 阶梯决策（用户令 #2：先系统原生精确，做不到的档位落全屏闹钟 + 常驻通知）──

test('android + exact granted leads with the native exact alarm', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'granted', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-exact', 'system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.fullscreen, true);
    assert.equal(ladder.keepAlive, true);
    assert.equal(ladder.presentable, true);
});

test('android + exact denied degrades to inexact-but-delivered, keepAlive stays on', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'denied', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-inexact', 'system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.keepAlive, true);
});

test('android + module missing (unsupported) keeps only notification + fullscreen, no keepAlive', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'unsupported', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.keepAlive, false);
});

test('android + notification permission denied drops presentability but keeps the alarm ladder', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'granted', notificationsGranted: false });
    assert.equal(ladder.presentable, false);
    assert.deepEqual(ladder.tiers, ['system-exact', 'system-notification', 'in-app-fullscreen']);
});

test('ios has no third-party alarm API: notification ladder + foreground-only fullscreen', () => {
    const ladder = decideAlarmLadder({ platform: 'ios', exact: 'unsupported', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.keepAlive, false);
    assert.equal(ladder.presentable, true);
});

test('web has no system surface at all: in-app fullscreen only', () => {
    const ladder = decideAlarmLadder({ platform: 'web', exact: 'unsupported', notificationsGranted: false });
    assert.deepEqual(ladder.tiers, ['in-app-fullscreen']);
    assert.equal(ladder.keepAlive, false);
    assert.equal(ladder.presentable, false);
});

// ─── 深链路径构造（用户令 #3：三端一律路径参数，勿 query——AGENTS.md 偏差表）──

test('alarm route path is a path-param route, not a query', () => {
    const path = alarmRoutePath('3f2a-uuid-ish');
    assert.equal(path, '/alarm/3f2a-uuid-ish');
    assert.ok(!path.includes('?'));
});

test('alarm deep link uses the archive scheme and path segment', () => {
    assert.equal(alarmDeepLink('abc'), 'archive://alarm/abc');
    assert.equal(alarmDeepLink('a b', 'myapp'), 'myapp://alarm/a%20b');
});

test('trip deep link keeps the widget tap contract archive://trip/<id>', () => {
    assert.equal(tripDeepLink('t1'), 'archive://trip/t1');
});

// ─── 到点判定（watcher 软计时的数据面）────────────────────────────────────

function entry(id: string, at: number): ScheduledAlarmEntry {
    return { id, at, title: `t-${id}`, body: '' };
}

test('pickDueEntries returns only elapsed entries sorted by due time', () => {
    const now = 1_000;
    const due = pickDueEntries([entry('late', now - 200), entry('future', now + 10_000), entry('near', now - 50)], now);
    assert.deepEqual(due.map((e) => e.id), ['late', 'near']);
});

test('itemIdFromNotificationId strips the trip-item prefix contract (store identifier scheme)', () => {
    assert.equal(itemIdFromNotificationId('trip-item-42'), '42');
    assert.equal(itemIdFromNotificationId('other-42'), null);
});
