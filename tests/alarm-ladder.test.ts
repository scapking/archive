import assert from 'node:assert/strict';
import test from 'node:test';
import {
    alarmCardContent,
    alarmDeepLink,
    alarmRoutePath,
    confirmAlarmSession,
    decideAlarmLadder,
    isAlarmConfirmed,
    isAlarmHandled,
    isAlarmSettled,
    itemIdFromAlarmPath,
    itemIdFromNotificationId,
    markAlarmHandled,
    pickDueEntries,
    shouldPresentAlarm,
    tripDeepLink,
    type ScheduledAlarmEntry,
} from '../src/features/archive/alarm-ladder.ts';

// ─── 阶梯决策（v0.5.1 令 3：统一语义「拉回尝试 → 本地通知兜底 → 前台呈现」；
//     拉回不可得必有通知，不留静默洞）───────────────────────────────────────

test('android + exact granted: pullback via full-screen intent + notification fallback both on', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'granted', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-exact', 'system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.pullback, true);
    assert.equal(ladder.notificationFallback, true);
    assert.equal(ladder.fullscreen, true);
    assert.equal(ladder.keepAlive, true);
    assert.equal(ladder.presentable, true);
});

test('android + exact denied degrades to inexact-but-delivered, pullback/keepAlive stay on', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'denied', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-inexact', 'system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.keepAlive, true);
    // 非精确档到点走同一接收器：拉回尝试与通知兜底不因精度降级消失
    assert.equal(ladder.pullback, true);
    assert.equal(ladder.notificationFallback, true);
});

test('android + module missing (unsupported) keeps only notification + fullscreen, no pullback/keepAlive', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'unsupported', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.pullback, false);
    assert.equal(ladder.notificationFallback, true);
    assert.equal(ladder.keepAlive, false);
});

test('android + notification permission denied drops presentability but keeps the pullback ladder', () => {
    const ladder = decideAlarmLadder({ platform: 'android', exact: 'granted', notificationsGranted: false });
    assert.equal(ladder.presentable, false);
    assert.equal(ladder.notificationFallback, false);
    assert.deepEqual(ladder.tiers, ['system-exact', 'system-notification', 'in-app-fullscreen']);
});

test('ios has no pullback API: notification is the default fallback, not an error state', () => {
    const ladder = decideAlarmLadder({ platform: 'ios', exact: 'unsupported', notificationsGranted: true });
    assert.deepEqual(ladder.tiers, ['system-notification', 'in-app-fullscreen']);
    assert.equal(ladder.pullback, false);
    // 令 2 核心：后台强拉全屏不可得 → 必有本地通知兜底（进 app 腿 = 通知 tap 深链）
    assert.equal(ladder.notificationFallback, true);
    assert.equal(ladder.keepAlive, false);
    assert.equal(ladder.presentable, true);
});

test('ios + notifications denied: nothing system-level can present (honest platform floor)', () => {
    const ladder = decideAlarmLadder({ platform: 'ios', exact: 'unsupported', notificationsGranted: false });
    assert.equal(ladder.pullback, false);
    assert.equal(ladder.notificationFallback, false);
    assert.equal(ladder.presentable, false);
});

test('web has no system surface at all: in-app fullscreen only', () => {
    const ladder = decideAlarmLadder({ platform: 'web', exact: 'unsupported', notificationsGranted: false });
    assert.deepEqual(ladder.tiers, ['in-app-fullscreen']);
    assert.equal(ladder.pullback, false);
    assert.equal(ladder.notificationFallback, false);
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

// ─── v0.5.1 真机纠错判定面（watcher 拉起去重 / 外部停铃收账 / tap 深链回收 /
//     通知内容卡文案）——全部纯函数，屏层与 watcher 只消费不重复实现 ─────────

// v0.5.1 复响回路防线：「本会话已处理」是 watcher/页内检查/全屏屏出口三处
// 共写的共享账（id→计划时刻指纹）——局部 ref 集随屏卸载丢失即「确认后回页
// 再跳、关了又响」的根因；at 指纹让重排后的闹钟重新在场。
test('shared session ledger: keyed by (id, at); reschedule re-arms', () => {
    markAlarmHandled('ledger-1', 5_000);
    assert.equal(isAlarmHandled('ledger-1', 5_000), true);
    assert.equal(isAlarmHandled('ledger-1', 9_000), false); // 重排新时刻 = 未处理
    assert.equal(isAlarmHandled('ledger-never', 1), false);
});

test('shouldPresentAlarm: reads the shared ledger, /alarm route presence gates too', () => {
    markAlarmHandled('w-1', 5_000);
    assert.equal(shouldPresentAlarm('w-1', 5_000, '/'), false); // 会话账已记
    assert.equal(shouldPresentAlarm('w-1', 6_000, '/'), true); // 重排可再呈
    assert.equal(shouldPresentAlarm('w-2', 6_000, '/alarm/w-2'), false); // 屏在场
    assert.equal(shouldPresentAlarm('w-2', 6_000, '/trip/t1/day/2026-11-26'), true);
    // 判定注入位（纯函数可测性保持：handled 谓参可替换）
    assert.equal(shouldPresentAlarm('w-3', 7_000, '/', () => true), false);
});

// v0.5.1 返工（CDP wheel4/5/6 web 实锤）：慢存储下「停止」点早于行程项 resolve，
// 旧出口写 Date.now() 即时指纹会**覆盖**页内检查先记的 dueAt 槽 → 回页判据失配
// → ≤15s 再跳全屏屏，连续劫持。新契约：**确认 = id 级出账**，与抢占标记分账、
// 优先于任何 at、跨平台单源（web 无注册表/门面 no-op 也闭环）。
test('confirm = unconditional settle-account, web loop regression (wheel4/5/6 repro)', () => {
    const dueAt = 1_700_000_000_000;
    // 页内检查：抢占标记 + 跳屏
    markAlarmHandled('loop-1', dueAt);
    // 行程项未 resolve 时点「停止」（item undefined 分支）——只出账，不写覆盖槽
    confirmAlarmSession('loop-1');
    // 回页下一拍：必须不再在场
    assert.equal(isAlarmHandled('loop-1', dueAt), true);
    assert.equal(shouldPresentAlarm('loop-1', dueAt, '/'), false);
    // 确认账对任何 at 优先（同会话重排也不自动呈现——用户刚亲手停过）
    assert.equal(shouldPresentAlarm('loop-1', dueAt + 60_000, '/'), false);
    assert.equal(isAlarmConfirmed('loop-1'), true);
    assert.equal(isAlarmConfirmed('loop-never'), false);
});

test('confirm and preempt marks live in separate ledgers (no overwrite both ways)', () => {
    confirmAlarmSession('loop-2');
    markAlarmHandled('loop-2', 42); // 后到的抢占标记不得洗掉确认账
    assert.equal(isAlarmHandled('loop-2', 999), true); // 仍按确认优先
    markAlarmHandled('loop-3', 7);
    assert.equal(isAlarmHandled('loop-3', 8), false); // 未确认项的 at 语义不回归
});

test('isAlarmSettled: entry present in registry = still ringing; gone = externally stopped', () => {
    const scheduled = [entry('a', 1), entry('b', 2)];
    assert.equal(isAlarmSettled('a', scheduled), false);
    assert.equal(isAlarmSettled('gone', scheduled), true);
    assert.equal(isAlarmSettled('a', []), true); // 停止后注册表出账（cancel/confirm 语义）
});

test('itemIdFromAlarmPath round-trips alarmRoutePath (notification tap contract)', () => {
    assert.equal(itemIdFromAlarmPath(alarmRoutePath('uuid-1')), 'uuid-1');
    assert.equal(itemIdFromAlarmPath(alarmRoutePath('a b')), 'a b'); // 编码逆运算
    assert.equal(itemIdFromAlarmPath('/trip/t1'), null);
    assert.equal(itemIdFromAlarmPath('/alarm/'), null);
    assert.equal(itemIdFromAlarmPath('/alarm/a/b'), null);
    assert.equal(itemIdFromAlarmPath('/alarm/%zz'), null); // 非法编码防御
});

test('alarmCardContent: time + title card copy, both platforms isomorphic (v0.5.1 令 2/3)', () => {
    assert.deepEqual(
        alarmCardContent({ time: '07:40', title: ' 赶渡轮 ', description: ' 码头 C 口 ' }),
        { title: '07:40 赶渡轮', body: '码头 C 口' },
    );
    // 空标题只报时刻——禁兜底词（卡面纪律同源）；body 退标题再退空
    assert.deepEqual(
        alarmCardContent({ time: '09:30', title: '', description: '' }),
        { title: '09:30', body: '' },
    );
    assert.deepEqual(
        alarmCardContent({ time: '09:30', title: '还书' }),
        { title: '09:30 还书', body: '还书' },
    );
});
