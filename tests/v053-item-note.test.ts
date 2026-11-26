import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * v0.5.3 轮 A 闸（源文本契约）：行程项笔记编辑面三件套——
 * ① 新路由 /trip/[id]/item/[itemId]/note 存在且路径参数接线（web push 丢
 *    query 的登记偏差 → 跨屏参数必须走路径段）；
 * ② 笔记面解剖与冷启纪律（ScreenHeader 屏题=时刻、只读信息行、纸面大正文
 *    16/26 失焦即落库、底部动作行「表单编辑」+「完成」、storeReady 闸 +
 *    瞬态重试预算不锁死「找不到」、零渐变）；
 * ③ trip-day 接线口径：卡面时刻 hero 点按直达笔记面（≥44 命中）、长按菜单
 *    「删除行程」新词 + 「删除行程项」在本屏全域退场（两行制不变）、表单
 *    编辑回跳信号（导出 + focus 消费）；
 * ④ trip-detail 屏头 TripBadge 全域退场（right 槽只剩编辑铅笔）。
 * 跨文件读源纪律同 trip-day-deck.test.ts（屏源不可 import，只扫文本）。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const routePath = path.join(repoRoot, 'src/app/trip/[id]/item/[itemId]/note.tsx');
const routeSource = existsSync(routePath) ? readFileSync(routePath, 'utf8') : '';
const noteSource = readFileSync(
    path.join(repoRoot, 'src/features/archive/trip-item-note-screen.tsx'),
    'utf8',
);
const tripDaySource = readFileSync(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);
const detailSource = readFileSync(
    path.join(repoRoot, 'src/features/archive/trip-detail-screen.tsx'),
    'utf8',
);

test('路由存在且深路径直连：/trip/[id]/item/[itemId]/note（路径参数 id+itemId）', () => {
    assert.ok(existsSync(routePath), '缺 src/app/trip/[id]/item/[itemId]/note.tsx');
    assert.ok(routeSource.includes('useLocalSearchParams<{ id: string; itemId: string }>'), '路由未读路径参数');
    assert.ok(routeSource.includes('<TripItemNoteScreen'), '路由未挂笔记编辑屏');
    assert.ok(routeSource.includes('tripId={id}') && routeSource.includes('itemId={itemId}'), '路由参数→屏 props 接线缺失');
});

test('笔记面冷启纪律：storeReady 闸 + 瞬态重试预算（对齐 trip-day，不再「找不到」锁死）', () => {
    assert.ok(noteSource.includes('if (!storeReady) return;'), '缺 hydration 竞态闸');
    assert.ok(noteSource.includes('loadRetryRef.current < 3'), '缺瞬态重试预算');
    assert.ok(noteSource.includes('700') && noteSource.includes('1600') && noteSource.includes('2600'), '重试节拍档位漂移');
    assert.ok(noteSource.includes('db.getTripItem'), '未按 id 取行程项');
    // 路由参数成对校验：item 必须属于 URL 里的行程（防跨行程串数据）
    assert.ok(noteSource.includes('row.trip_id !== tripId'), '缺 trip_id 归属校验');
});

test('笔记面解剖：屏题=时刻、只读信息行、纸面大正文 16/26 失焦即落库、动作行双钮', () => {
    assert.ok(noteSource.includes('<ScreenHeader title={item.time}'), '屏头未走统一规格/屏题非时刻');
    assert.ok(noteSource.includes('tripItemDisplayTitle'), '标题回显未走唯一取题口');
    assert.ok(noteSource.includes('写下这一刻'), '缺正文占位文案');
    assert.ok(noteSource.includes('multiline'), '正文未多行');
    assert.ok(noteSource.includes('fontSize: 16, lineHeight: 26'), '正文未走日记字阶 16/舒适行高');
    assert.ok(noteSource.includes('flex: 1') && noteSource.includes("containerClassName=\"flex-1\""), '正文未吃满纸面（flex-1）');
    assert.ok(noteSource.includes('onBlur'), '缺失焦收笔通道');
    assert.ok(noteSource.includes('updateTripItemContent'), '落库未走 store 内容单源');
    assert.ok(noteSource.includes('表单编辑'), '缺「表单编辑」次级入口');
    assert.ok(noteSource.includes('完成'), '缺「完成」主钮');
    assert.ok(noteSource.includes('requestTripItemFormEdit'), '「表单编辑」未挂回跳信号');
    assert.ok(noteSource.includes('router.back()'), '「表单编辑」/「完成」未走返回');
    // 零渐变 + 禁旧文案（注释复述 = 回流温床，同 trip-day-deck 禁词纪律）
    assert.ok(!noteSource.includes('LinearGradient'), '笔记面出现渐变（0.4.9 禁令）');
    assert.ok(!noteSource.includes('删除行程项'), '笔记面残留旧菜单文案');
});

test('卡面时刻点按直达笔记编辑面（hero Pressable 接线，命中区 ≥44）', () => {
    const hero = tripDaySource.slice(
        tripDaySource.indexOf('const TripItemCardFace = memo('),
        tripDaySource.indexOf('/* 时间编辑'),
    );
    assert.ok(hero.length > 0, '卡面段定位失败');
    assert.ok(hero.includes("pathname: '/trip/[id]/item/[itemId]/note'"), '卡面时刻未接笔记面路由');
    assert.ok(hero.includes('hitSlop={8}'), '时刻命中区缺 hitSlop（30px 行盒 + 8×2 ≥44）');
});

test('长按菜单口径：「删除行程」在场且「删除行程项」在本屏全域退场；「进入编辑」改道笔记面', () => {
    assert.ok(tripDaySource.includes("title: '删除行程'"), '长按菜单缺「删除行程」');
    assert.ok(!tripDaySource.includes('删除行程项'), '「删除行程项」未全域退场（含注释）');
    assert.ok(tripDaySource.includes("title: '进入编辑'"), '长按菜单缺「进入编辑」');
    assert.ok(
        tripDaySource.includes('itemId: target.id'),
        '「进入编辑」未接笔记面 push（仍直通表单？）',
    );
    // 旧表单编辑形态保留：sheet 编辑态文案与内容通道仍在
    assert.ok(tripDaySource.includes('编辑行程项'), '表单编辑态整体流失（应保留为次级入口）');
});

test('表单编辑回跳机制：信号导出在 trip-day（消费端），focus 时消费即清', () => {
    assert.ok(tripDaySource.includes('export function requestTripItemFormEdit'), '缺回跳信号导出');
    assert.ok(tripDaySource.includes('useFocusEffect('), '信号未挂 focus 消费通道');
    assert.ok(tripDaySource.includes('pendingFormEditSeed = null'), '信号缺消费即清（防重放）');
    assert.ok(tripDaySource.includes('setEditItem(seed)'), '信号消费未打开编辑卡');
    assert.ok(tripDaySource.includes('items.some((row) => row.id === seed.id)'), '缺归属日校验（跨日错屏丢弃）');
});

test('trip-detail 屏头：TripBadge 全域退场（import+JSX 清零，right 槽只剩编辑钮）', () => {
    assert.ok(!detailSource.includes('TripBadge'), 'trip-detail 残留 TripBadge');
    assert.ok(detailSource.includes('accessibilityLabel="编辑行程"'), '编辑铅笔缺位（right 槽应有且仅有它）');
});
