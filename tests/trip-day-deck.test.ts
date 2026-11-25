import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DAY_DECK_MAX,
    DAY_DECK_MIN,
    DAY_FACE_PLAN_LIMIT,
    dayDeckHeight,
    dayFaceInvitation,
    dayFacePlanPreview,
    dayFaceTags,
    tripDayTarget,
} from '../src/features/archive/trip-day-deck-logic.ts';

/**
 * 日卡左右堆纯逻辑 + 点卡去向分流（v0.4.7 行程域重构令 1 的可测面）。
 * 旧「垂直日卡列表」形态的断言随形态退役，本文件按新形态（堆叠卡面摘要 +
 * 点前卡进当日）改写口径——用例只增不减。
 */

test('dayDeckHeight：视口比例夹紧到可读档，非法输入不塌', () => {
    assert.equal(dayDeckHeight(932), DAY_DECK_MAX); // 桌面 web：932−250=682 → 封顶 640
    assert.equal(dayDeckHeight(667), DAY_DECK_MIN); // 小屏：667−250=417 < 420 → 兜下限
    assert.equal(dayDeckHeight(844), 594); // 主流机：844−250 直接落档
    assert.equal(dayDeckHeight(1200), DAY_DECK_MAX); // 大屏封顶
    assert.equal(dayDeckHeight(0), DAY_DECK_MIN);
    assert.equal(dayDeckHeight(Number.NaN), DAY_DECK_MIN);
    assert.equal(dayDeckHeight(-5), DAY_DECK_MIN);
});

test('dayFaceTags：今天优先、出发=D1、返程=固定区间末日、最多两枚', () => {
    const today = '2026-11-25';
    // 今天恰好也是出发日：今天置首 + 出发 = 2 枚
    assert.deepEqual(dayFaceTags({ dayNo: 1, localDate: '2026-11-25', endDate: '2026-12-05', today }), [
        '今天',
        '出发',
    ]);
    // 中间日无徽章
    assert.deepEqual(dayFaceTags({ dayNo: 5, localDate: '2026-11-17', endDate: '2026-12-05', today }), []);
    // 返程日 = 固定行程末日
    assert.deepEqual(dayFaceTags({ dayNo: 23, localDate: '2026-12-05', endDate: '2026-12-05', today }), ['返程']);
    // 持续性行程（endDate null）不给假终点；今天+出发已占两枚时返程让位（≤2 闸）
    assert.deepEqual(dayFaceTags({ dayNo: 1, localDate: '2026-11-25', endDate: null, today }), ['今天', '出发']);
    // 今天 = 出发 = 返程 三重命中的单日行程：仍只出两枚（今天 + 出发）
    assert.deepEqual(dayFaceTags({ dayNo: 1, localDate: '2026-11-25', endDate: '2026-11-25', today }), ['今天', '出发']);
});

test('dayFacePlanPreview：3 行预览档 + 全量完成统计（含隐藏行）', () => {
    const plans = [
        { done: 1 },
        { done: 0 },
        { done: 0 },
        { done: 1 },
        { done: 0 },
    ];
    const preview = dayFacePlanPreview(plans);
    assert.equal(preview.visible.length, DAY_FACE_PLAN_LIMIT);
    assert.equal(preview.hidden, 2);
    assert.equal(preview.done, 2); // 统计含隐藏——「+2 项 · 当日完成 2/5」不说谎
    // 空日：零行零隐藏
    const empty = dayFacePlanPreview([]);
    assert.deepEqual(empty, { visible: [], hidden: 0, done: 0 });
});

test('dayFaceInvitation：未写才邀请（文案对 = 标题+去向提示）；锁定无写入口 → 邀请退空（提示不撒谎）', () => {
    assert.deepEqual(dayFaceInvitation(false, false), {
        title: '这一天还没写',
        hint: '点卡看当日行程，长按补一句',
    });
    assert.equal(dayFaceInvitation(false, true), null);
    assert.equal(dayFaceInvitation(true, false), null);
    assert.equal(dayFaceInvitation(true, true), null);
});

test('tripDayTarget：点卡去向分流（未锁定/锁定无日记=当日行程表；锁定有日记=只读日记）', () => {
    const journal = { id: 'j-1' };
    assert.deepEqual(tripDayTarget(false, null), { kind: 'day' });
    assert.deepEqual(tripDayTarget(false, journal), { kind: 'day' });
    assert.deepEqual(tripDayTarget(true, null), { kind: 'day' });
    assert.deepEqual(tripDayTarget(true, journal), { kind: 'journal', id: 'j-1' });
});
