import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tripItemDisplayTitle } from '../src/features/archive/trip-item-logic.ts';

/**
 * 空标题行程项契约（v0.5.1 令 1：快速路径删标题输入框）：
 * - store.createTripItem 的 title 校验放开——trim 后空串合法直接入库，
 *   「给行程项起个名字」拒绝路径整体退场；
 * - 展示层唯一取题口 tripItemDisplayTitle：空标题 → 空串，调用方据此
 *   **不渲染任何文字**（时刻即主角）；兜底词全域禁用（同 trip-day-deck
 *   「卡面禁词」纪律）；
 * - 屏→sheet 的 onSubmit 契约形状不变（title 语义放宽为空串合法），
 *   runCreateTripItem 直通 store，_layout/其他调用点零改动。
 * 预期来自需求与计划文档，不复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeSource = await readFile(
    path.join(repoRoot, 'src/features/archive/store.ts'),
    'utf8',
);
const screenSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);
const logicSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-item-logic.ts'),
    'utf8',
);
/** createTripItem 函数体（到下一个 action 为止）。 */
function createTripItemSection(): string {
    const start = storeSource.indexOf('async createTripItem({');
    const end = storeSource.indexOf('async startTripItemWrap', start);
    assert.ok(start > 0 && end > start, 'createTripItem 段定位失败（结构变了口径同步）');
    return storeSource.slice(start, end);
}

test('tripItemDisplayTitle：trim 透传，空标题返回空串，无兜底词', () => {
    assert.equal(tripItemDisplayTitle('逛集市'), '逛集市');
    assert.equal(tripItemDisplayTitle('  逛集市  '), '逛集市');
    assert.equal(tripItemDisplayTitle(''), '');
    assert.equal(tripItemDisplayTitle('   '), '');
    // 兜底词禁入逻辑模块（含注释——注释复述是文案回流的温床；「行程项」
    // 是域名词不在禁列）
    for (const banned of ['未命名行程', '未命名项', '未命名', '无标题']) {
        assert.ok(!logicSource.includes(banned), `trip-item-logic.ts 残留兜底文案「${banned}」`);
    }
});

test('store.createTripItem：空标题不再拒绝、trim 入库；时间与日期校验照旧', () => {
    const section = createTripItemSection();
    assert.ok(!section.includes('给行程项起个名字'), '空标题拒绝路径残留');
    assert.ok(!section.includes('trimmedTitle.length === 0'), '空标题长度闸残留');
    // trim 语义保留：入库的是 trimmedTitle（空 trim 后 = 空串）
    assert.ok(section.includes('const trimmedTitle = title.trim();'), '标题 trim 语义丢失');
    assert.ok(section.includes('title: trimmedTitle,'), '入库字段未走 trim 结果');
    // 其余校验冻结：时间/日期闸原样在场
    assert.ok(section.includes('if (!isValidTripItemTime(time))'), '时间校验闸丢失');
    assert.ok(section.includes('if (!isValidLocalDate(date))'), '日期校验闸丢失');
});

test('卡面/闹钟卡/无障碍标签：空标题只显时刻，join 通道无兜底词、无空串残留', () => {
    // 卡面：条件渲染 displayTitle（空 → 不渲染标题 Text 节点）
    assert.ok(screenSource.includes('tripItemDisplayTitle'), '屏层未走唯一取题口');
    assert.ok(screenSource.includes("displayTitle !== ''"), '卡面缺空标题条件渲染闸');
    assert.ok(!screenSource.includes('{item.title}'), '卡面直出 item.title 回潮（空标题会渲染空 Text）');
    // 闹钟卡与 a11y 播报：[time, title].filter(Boolean).join(' ') ——
    // 空标题不留尾随空格/undefined 字样
    assert.ok(screenSource.includes("filter(Boolean).join(' ')"), '缺 filter+join 拼装通道');
    assert.ok(!screenSource.includes('${item.time} ${item.title}'), '旧模板串直拼回潮');
    // 兜底词禁入屏源（含注释）
    for (const banned of ['未命名行程', '未命名项']) {
        assert.ok(!screenSource.includes(banned), `trip-day-screen 残留兜底文案「${banned}」`);
    }
});

test('onSubmit 契约形状不变：屏→sheet 四字段直通 store（调用点零改动底线）', () => {
    const typeLiteral = 'input: { time: string; title: string; description: string; withAlarm: boolean }';
    // sheet 入参类型 + 屏层 runCreateTripItem 形参同型（形状演化仅语义：title 可空串）
    assert.equal(
        screenSource.split(typeLiteral).length - 1,
        2,
        'onSubmit 契约形状改动——屏↔sheet 两处必须同型（_layout/其他调用点零改动为底线）',
    );
    // 直通通道字段齐（无中间加工改名）
    for (const field of ['time: input.time', 'title: input.title', 'description: input.description', 'withAlarm: input.withAlarm']) {
        assert.ok(screenSource.includes(field), `runCreateTripItem 直通缺 ${field}`);
    }
});
