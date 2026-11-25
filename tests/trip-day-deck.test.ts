import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as dayDeckLogic from '../src/features/archive/trip-day-deck-logic.ts';
import {
    DAY_DECK_MAX,
    DAY_DECK_MIN,
    DAY_FACE_PLAN_LIMIT,
    dayDeckHeight,
    dayFacePlanPreview,
    dayFaceTags,
    tripDayTarget,
} from '../src/features/archive/trip-day-deck-logic.ts';

/**
 * 日卡左右堆纯逻辑 + 点卡去向分流（v0.4.7 行程域重构令 1 的可测面）。
 * 旧「垂直日卡列表」形态的断言随形态退役，本文件按新形态（堆叠卡面摘要 +
 * 点前卡进当日）改写口径——用例只增不减。v0.4.9 令 2：空日卡占位文案工厂
 * 退场，原 dayFaceInvitation 用例改为「文案块不存在 + 卡面禁词清单」契约
 * （同 deck-stack-colors 先例的跨文件读源把关；屏源不可 import，只扫文本）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logicSource = readFileSync(
    path.join(repoRoot, 'src/features/archive/trip-day-deck-logic.ts'),
    'utf8',
);
const detailSource = readFileSync(
    path.join(repoRoot, 'src/features/archive/trip-detail-screen.tsx'),
    'utf8',
);

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

test('空日卡占位文案块退场（v0.4.9 令 2）：文案工厂移除、raised 井容器退场、卡面禁词清单零出现', () => {
    // ① 逻辑契约：dayFaceInvitation 占位文案工厂从导出面彻底消失——
    //    空日卡不再有 title/hint 文案源（新契约：卡面无占位文案块）
    assert.equal('dayFaceInvitation' in dayDeckLogic, false);
    // ② 渲染契约：未写日（可写态）的「raised 井」占位容器退场；锁定态与
    //    已写态分支不受影响（分流由屏层按 locked / hasJournal 直判，
    //    tripDayTarget / dayFaceTags 用例继续把关节奏面）
    assert.ok(
        !detailSource.includes('bg-ink-raised px-4 py-4'),
        'trip-detail-screen.tsx 仍挂着空日卡 raised 井容器',
    );
    // ③ 卡面禁词清单（用户点名）：兜底行程名与占位文案不得出现在日堆
    //    逻辑与日堆屏任一源文件中（含注释——注释复述即是文案回流的温床）
    const banned = ['未命名行程', '这一天还没写', '点卡看当日行程', '长按补一句'];
    for (const phrase of banned) {
        assert.ok(!logicSource.includes(phrase), `trip-day-deck-logic.ts 残留「${phrase}」`);
        assert.ok(!detailSource.includes(phrase), `trip-detail-screen.tsx 残留「${phrase}」`);
    }
    // ④ 「未写」状态事实词仍允许（锁定只读行），不属于禁词占位文案
    assert.ok(detailSource.includes('未写'), '锁定只读态的「未写」状态行应在屏源保留');
});

test('tripDayTarget：点卡去向分流（未锁定/锁定无日记=当日行程表；锁定有日记=只读日记）', () => {
    const journal = { id: 'j-1' };
    assert.deepEqual(tripDayTarget(false, null), { kind: 'day' });
    assert.deepEqual(tripDayTarget(false, journal), { kind: 'day' });
    assert.deepEqual(tripDayTarget(true, null), { kind: 'day' });
    assert.deepEqual(tripDayTarget(true, journal), { kind: 'journal', id: 'j-1' });
});
