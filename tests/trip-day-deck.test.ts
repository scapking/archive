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
 * v0.5.0（用户点名）：可写空日卡残存的「+」细边邀请整体删除，契约加锁
 * 「LucidePlus 不入日堆卡面」+ 0.4.9 邀请节点串不复现；中腹纯留白。
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

test('空日卡纯留白（v0.4.9 令 2 + v0.5.0 删「+」邀请）：文案工厂/raised 井/' +
    '邀请「+」全部退场，卡面禁词清单零出现，锁定态状态词按现状收一行', () => {
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
    // ②b v0.5.0 用户点名：可写空日卡中央的「+」细边邀请整体删除，锁形——
    //    LucidePlus 不入日堆卡面（屏源 import 与 JSX 全数消失；日堆「+」
    //    在 insert-menu / 编辑器媒体行 / 首页 FAB 等处的用法不在本闸口径，
    //    各由其宿主文件契约把关）；且 0.4.9 邀请节点串（h-10 w-10 细边圆盒）
    //    不得以改头换面形式复现
    assert.ok(
        !detailSource.includes('LucidePlus'),
        'trip-detail-screen.tsx 仍在日堆卡面消费 LucidePlus「+」邀请',
    );
    assert.ok(
        !detailSource.includes(
            'h-10 w-10 items-center justify-center rounded-full border border-ink-border',
        ),
        'trip-detail-screen.tsx 仍挂着 0.4.9 空日卡「+」邀请的细边圆盒节点',
    );
    // ③ 卡面禁词清单（用户点名）：兜底行程名与占位文案不得出现在日堆
    //    逻辑与日堆屏任一源文件中（含注释——注释复述即是文案回流的温床）；
    //    「+」邀请删除后不留替代占位文案，本闸继续封死回流通道
    const banned = ['未命名行程', '这一天还没写', '点卡看当日行程', '长按补一句'];
    for (const phrase of banned) {
        assert.ok(!logicSource.includes(phrase), `trip-day-deck-logic.ts 残留「${phrase}」`);
        assert.ok(!detailSource.includes(phrase), `trip-detail-screen.tsx 残留「${phrase}」`);
    }
    // ④ 「只写一行状态词」按现状收：「未写」状态事实词仍是锁定只读态独有的
    //    一行 Text 节点（可写空日卡中腹纯留白、零文案——它不属于禁词占位文案）
    assert.ok(detailSource.includes('未写'), '锁定只读态的「未写」状态行应在屏源保留');
    assert.equal(
        (detailSource.match(/>未写</g) || []).length,
        1,
        '「未写」状态词应恰为锁定只读态一行 Text 节点，不得回流成可写态占位文案',
    );
});

test('tripDayTarget：点卡去向分流（未锁定/锁定无日记=当日行程表；锁定有日记=只读日记）', () => {
    const journal = { id: 'j-1' };
    assert.deepEqual(tripDayTarget(false, null), { kind: 'day' });
    assert.deepEqual(tripDayTarget(false, journal), { kind: 'day' });
    assert.deepEqual(tripDayTarget(true, null), { kind: 'day' });
    assert.deepEqual(tripDayTarget(true, journal), { kind: 'journal', id: 'j-1' });
});

/* ------------------------------------------------------------------ */
/* v0.5.2 令 7：当日行程项卡堆——未到点优先排序 + 长按菜单两行制          */
/* ------------------------------------------------------------------ */

/** 当日屏源（长按菜单文案与排序消费的跨文件读源闸）。 */
const tripDaySource = readFileSync(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);

const due = (time: string): number => {
    const [h, m] = time.split(':').map(Number);
    return new Date(2026, 10, 24, h, m, 0, 0).getTime();
};
const mkItem = (id: string, time: string, status: 'pending' | 'failed' = 'pending') => ({
    id,
    status,
    local_date: '2026-11-24',
    time,
    completed_at: null,
    wrap_closed_at: null,
});

test('tripDayDeckPriority：未到点组权重最前，段序 pending→ongoing→done→wrap→terminal', () => {
    const { tripDayDeckPriority } = dayDeckLogic;
    assert.ok(
        tripDayDeckPriority('pending') < tripDayDeckPriority('ongoing') &&
        tripDayDeckPriority('ongoing') < tripDayDeckPriority('done') &&
        tripDayDeckPriority('done') < tripDayDeckPriority('wrap') &&
        tripDayDeckPriority('wrap') < tripDayDeckPriority('terminal'),
        '组优先级必须严格 pending < ongoing < done < wrap < terminal',
    );
});

test('orderTripItemsByDayDeckPriority：未到点（pending）项占前排展示位（用户点名「逻辑错误」改正）', () => {
    const order = dayDeckLogic.orderTripItemsByDayDeckPriority;
    // 指令原例：14:30 已过闹钟（ongoing，doneAt=min(15:00, 16:00)=15:00），
    // 还有 16:00 未到点行程 → 16:00 的卡必须排在前排
    const now = due('14:45');
    const items = [mkItem('a', '14:30'), mkItem('b', '16:00')];
    assert.deepEqual(order(items, now).map((i) => i.id), ['b', 'a']);
    // 多枚未到点：组内按到点时间升序（越临近越靠前 =「接下来做什么」）
    const many = [mkItem('a', '14:30'), mkItem('b', '16:00'), mkItem('c', '20:00')];
    assert.deepEqual(order(many, now).map((i) => i.id), ['b', 'c', 'a']);
    // settled 段在「当日还有未到点/进行中项」时沿用旧口径：最新在前、最旧垫底
    const mixed = [mkItem('d', '09:00'), mkItem('e', '10:00'), mkItem('f', '16:00')];
    assert.deepEqual(
        order(mixed, due('10:45')).map((i) => i.id),
        ['f', 'e', 'd'],
    );
});

test('orderTripItemsByDayDeckPriority：全部过点后回到默认时序（合并按到点升序）', () => {
    const order = dayDeckLogic.orderTripItemsByDayDeckPriority;
    // 双双 done（pending 与 ongoing 皆空）→ 时序正序：早到点在前
    const allPast = [mkItem('a', '09:30'), mkItem('b', '10:00')];
    assert.deepEqual(
        order(allPast, due('10:40')).map((i) => i.id),
        ['a', 'b'],
        '全部过点后 settled 段回到默认时序（到点升序）',
    );
    // ongoing 在场且无 pending：ongoing 仍在 terminal 之前
    const mid = due('09:45');
    const ongoingFirst = [mkItem('t', '08:00', 'failed'), mkItem('o', '09:30')];
    assert.deepEqual(order(ongoingFirst, mid).map((i) => i.id), ['o', 't']);
});

test('v0.5.2 长按菜单两行制：进入编辑/删除行程项；旧动作梯与错误文案全域退场（含注释）', () => {
    // 新词在场
    assert.ok(tripDaySource.includes('进入编辑'), '长按菜单缺「进入编辑」');
    assert.ok(tripDaySource.includes('删除行程项'), '长按菜单缺「删除行程项」');
    // 编辑通道唯一走 store 内容 API（trim/闹钟重挂/锁定拒绝单源）
    assert.ok(tripDaySource.includes('updateTripItemContent'), '编辑/笔记落库未走 updateTripItemContent');
    // 旧「砍掉」语义与名实不符文案：源码全域禁（注释复述 = 文案回流温床，
    // 同 trip-day-deck 禁词纪律口径）
    for (const banned of ['砍掉', '删除此行程', '进入收尾', '结束收尾', '添加图片', '添加视频']) {
        assert.ok(!tripDaySource.includes(banned), `trip-day-screen 残留旧菜单文案「${banned}」`);
    }
    // 排序消费面：当日屏改吃优先级函数，通用时刻排序不再进本屏
    //（\b 界定：orderTripItemsByDayDeckPriority 不得误判为 orderTripItems）
    assert.ok(
        tripDaySource.includes('orderTripItemsByDayDeckPriority'),
        '当日屏未消费 orderTripItemsByDayDeckPriority',
    );
    assert.ok(!/\borderTripItems\b/.test(tripDaySource), '通用排序回潮当日屏（优先级口径漂移风险）');
});

/* ------------------------------------------------------------------ */
/* v0.5.2 令 7 卡面增量：常驻笔记位（就地编辑、无时间闸）+ 屏头统一规格   */
/* （原 v052-day-cards 闸组并入本文件；该文件按主控测试面收口删除）      */
/* ------------------------------------------------------------------ */

/** 卡面段（TripItemCardFace 起 → 时间编辑段锚止）。 */
function cardFaceSection(): string {
    const start = tripDaySource.indexOf('const TripItemCardFace = memo(');
    const end = tripDaySource.indexOf('/* 时间编辑');
    assert.ok(start > 0 && end > start, '卡面段定位失败（结构变了口径同步）');
    return tripDaySource.slice(start, end);
}

test('卡面笔记位：常驻可点、就地 multiline 编辑、失焦即 updateTripItemContent 落库', () => {
    const face = cardFaceSection();
    assert.ok(face.includes('<FieldInput'), '卡面笔记编辑位未用 FieldInput（IME 纪律）');
    assert.ok(face.includes('multiline'), '卡面笔记编辑位必须多行');
    assert.ok(face.includes('onBlur'), '缺失焦收笔通道');
    assert.ok(face.includes('updateTripItemContent'), '笔记落库未走 store 内容单源');
    assert.ok(face.includes('补一句这一时刻'), '缺差异化占位文案');
    assert.ok(face.includes('startNoteEdit'), '缺点进就地编辑入口');
    assert.ok(face.includes('min-h-6'), '空描述的笔记点击区缺最小命中高');
});

test('笔记位无时间闸：卡面零时刻判据（闹钟已过、done/settled 相照编）；锁定只读与时刻无关', () => {
    const face = cardFaceSection();
    // 「还能找到就一直在」= 卡面段结构上不存在时刻/到点判断
    assert.ok(!face.includes('tripItemDueAt'), '卡面出现时刻换算（时间闸回潮）');
    assert.ok(!face.includes('Date.now()'), '卡面出现自取时钟（时间闸回潮）');
    assert.ok(!face.includes('dueAt'), '卡面出现到点判据（时间闸回潮）');
    // 编辑入口唯一闸门 = editable（行程锁定态），与阶段/时刻无关
    assert.match(tripDaySource, /if \(!editable\) return;/, 'startNoteEdit 未以 editable 单闸收口');
    assert.ok(tripDaySource.includes('editable={!locked}'), '屏层未把锁定态喂给笔记位（只读语义缺接线）');
});

test('长按「进入编辑」= 创建卡同款编辑态：同组件复用、保存走内容通道、时刻只读', () => {
    const sheetStart = tripDaySource.indexOf('function TripItemSheet(');
    const sheetEnd = tripDaySource.indexOf('export function TripDayScreen(');
    assert.ok(sheetStart > 0 && sheetEnd > sheetStart, 'TripItemSheet 段定位失败');
    const sheet = tripDaySource.slice(sheetStart, sheetEnd);
    assert.ok(sheet.includes('editItem'), 'sheet 缺编辑态入参');
    assert.ok(sheet.includes('编辑行程项'), '缺编辑态卡头文案');
    assert.ok(sheet.includes('updateTripItemContent'), '编辑保存未走 store 内容单源');
    assert.ok(sheet.includes("useState<'time' | 'detail'>(isEdit ? 'detail' : 'time')"), '编辑态缺默认直达表单步');
    assert.ok(sheet.includes('editItem.time'), '编辑态缺只读时刻回显');
    assert.ok(sheet.includes("if (!isEdit && step === 'detail')"), '返回键缺编辑态直出口');
    // 屏层接线：菜单 edit → setEditItem，编辑卡按项重挂
    assert.ok(tripDaySource.includes("key={`trip-item-edit-${editItem.id}`}"), '编辑卡缺按项重挂 key');
    assert.ok(tripDaySource.includes('setEditItem(actionItem)'), '长按菜单缺进入编辑接线');
    // 应用内闹钟在任一覆盖层（含编辑卡）展开期顺延
    assert.ok(tripDaySource.includes('createOpen || actionItem || editItem'), '闹钟顺延缺编辑态分支');
});

test('屏头统一规格（轮 B 口径）：屏题 24px semibold、副标题描述行退场', () => {
    assert.ok(tripDaySource.includes('text-[24px] font-semibold'), 'trip-day 屏题未升 24px semibold');
    assert.ok(!tripDaySource.includes('text-[20px] font-semibold'), 'trip-day 屏题残留 20px 档');
    // 13px 行程名副行按「多余介绍」删除（含 tripDisplayTitle 消费面清零）
    assert.ok(!tripDaySource.includes('tripDisplayTitle'), 'trip-day 残留行程名副行（屏头无副题口径）');
});

test('trip-detail 屏头增量（轮 B 移交）：编辑钮 44 圆底 raised、TripBadge 无题侧卡位', () => {
    assert.ok(
        detailSource.includes('h-11 w-11 items-center justify-center rounded-full bg-ink-raised dark:bg-inkd-raised'),
        'trip-detail 编辑钮未升 44 圆形 raised 底盒（event-detail 同款解剖）',
    );
    assert.ok(
        !detailSource.includes('h-9 w-9 items-center justify-center rounded-control border'),
        'trip-detail 36 描边方盒回潮',
    );
    // 徽章无卡位：必须在标题 flex-1 之后（right 槽带），不再挂返回钮侧
    const headerRow = detailSource.slice(
        detailSource.indexOf('屏头（v0.5.2 轮 B 统一规格'),
        detailSource.indexOf('核心内容主体行'),
    );
    assert.ok(headerRow.length > 0, 'trip-detail 屏头段定位失败');
    assert.ok(
        headerRow.indexOf('flex-1 text-[24px]') < headerRow.indexOf('<TripBadge'),
        'trip-detail 徽章仍挂题侧（应收进行尾 right 槽）',
    );
});
