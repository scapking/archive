/**
 * 行程详情「日卡堆」纯逻辑（v0.4.7 行程域重构：日卡列表垂直 FlatList →
 * CardDeck 左右堆叠）。禁止 import react / react-native（node 单测直导）。
 *
 * 卡面是「那一天」的摘要而非全文：计划只带预览档（超出收进「+N」行），完整
 * 当日行程表在 /trip/[id]/day/[date]（点前卡进入）。本文件管四件可测的事：
 * ①堆高重分配（与首页/堆页同一「实测夹紧」构图口径）；②日头徽章词表
 * （出发/返程/今天，可叠合但最多两枚，卡面节奏优先）；③计划预览切分；
 * ④当日行程项卡堆的堆叠优先级（v0.5.2 令 7，见 orderTripItemsByDayDeckPriority
 * 与 tripDayDeckPriority 注）。
 */

import {
    tripItemDueAt,
    tripItemPhaseMap,
    type TripItemPhase,
    type TripItemPhaseInput,
} from './trip-item-logic.ts';

/** 日卡堆高度区间（dp）：下限 = 卡面「日期行+3 计划行+摘要+行动行」的最小
 *  可读体量；上限 = 高屏防卡面文字区无度撑大。 */
export const DAY_DECK_MIN = 420;
export const DAY_DECK_MAX = 640;

/** 头带预算（dp）：屏头两行 + eyebrow 行 + 上下安全垫——堆吃「视口减头带」
 *  的剩余，稀疏即罪的直接解法（v0.4.7 CDP 对照：比例档 0.56 在 932 视口下
 *  卡堆下面留下 ~240dp 死白，正是本轮令 3 要消灭的东西）。 */
const DAY_DECK_CHROME = 250;

/**
 * 堆高 = (视口 − 头带预算) 夹紧到 [420, 640]。口径说明：日卡堆是「单级短
 * 滚动页里的主节」——无视频/描述的行程堆直接铺满剩余视口；有封面带时短带
 * 自身可滚（位移 ≤ 一屏，卡顿主通道已随 FlatList 退役）。纯函数、零
 * onLayout 反馈环（v0.4.6 实测：反馈环 = 高度抖动的卡顿源之一，能不算就不
 * 算）。非法输入（0/NaN/负）落 MIN，渲染永不塌。
 */
export function dayDeckHeight(viewportHeight: number): number {
    if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return DAY_DECK_MIN;
    return Math.max(DAY_DECK_MIN, Math.min(DAY_DECK_MAX, Math.round(viewportHeight - DAY_DECK_CHROME)));
}

/** 日卡计划预览档：卡面最多直显 3 行（44dp 行 ×3 + 摘要 + 日期行 ≈ 420 卡高
 *  的预算上限），其余收进「+N 项」提示行，点卡进当日页看全。 */
export const DAY_FACE_PLAN_LIMIT = 3;

export interface DayFacePlanPreview<T> {
    visible: T[];
    /** 收进行数（>0 时卡面出现「+N 项」行）。 */
    hidden: number;
    /** 完成计数（卡面「完成 x/n」小字用，含隐藏行——统计是全量的）。 */
    done: number;
}

/** 计划预览切分（纯函数，泛化行类型便于测试注入）。 */
export function dayFacePlanPreview<T extends { done: number }>(
    plans: T[],
    limit = DAY_FACE_PLAN_LIMIT,
): DayFacePlanPreview<T> {
    return {
        visible: plans.slice(0, limit),
        hidden: Math.max(0, plans.length - limit),
        done: plans.reduce((sum, plan) => sum + (plan.done === 1 ? 1 : 0), 0),
    };
}

/**
 * 日头徽章词表（数据事实，不是装饰）：
 * - 「出发」= D1（固定区间与持续性行程都成立——出发日就是第一天）；
 * - 「返程」= 固定行程的最后一天（持续性无返程日，不给假终点）；
 * - 「今天」= localDate 命中今天（优先级最高，词表置首）。
 * 最多两枚（今天 + 出发/返程）；无徽章 = 中性卡头，accent 只上「今天」。
 */
export function dayFaceTags(input: {
    dayNo: number;
    localDate: string;
    /** 固定行程的结束日；open-ended 传 null。 */
    endDate: string | null;
    today: string;
}): string[] {
    const tags: string[] = [];
    if (input.localDate === input.today) tags.push('今天');
    if (input.dayNo === 1) tags.push('出发');
    if (input.endDate !== null && input.localDate === input.endDate) tags.push('返程');
    return tags.slice(0, 2);
}

// 卡面点按可达性（锁定语义在词表层收口，展示端直接用）：锁定行程仍可点卡
// 浏览（只读路径）。v0.4.9 令 2：未写日的占位文案工厂 dayFaceInvitation（标题
// + 去向提示）整体退场；v0.5.0（用户点名）：屏层残存的「+」细边视觉邀请也整体
// 删除——可写空日卡中腹纯留白（无文案、无图标、无空井），锁定态只留一行状态
// 事实（写入口不存在，邀请即谎言——方向令 §18 接口名实一致在文案面的延伸）。
// 空态呈现分流由屏层按 locked / hasJournal 直判。

/**
 * 点前卡去向（锁定语义分流，纯函数供屏层与单测共用）：未锁定 / 锁定但无
 * 日记 → 当日行程表页（day）；锁定且已有日记 → 只读日记页（journal，保持
 * 只读内容原访问路径——v0.4.7 堆形态迁移自旧 DayCard.open 的分支决策）。
 */
export function tripDayTarget(
    locked: boolean,
    journal: { id: string } | null,
): { kind: 'day' } | { kind: 'journal'; id: string } {
    if (locked && journal) return { kind: 'journal', id: journal.id };
    return { kind: 'day' };
}

/** 卡堆组优先级（v0.5.2 令 7，用户点名「逻辑错误」的改正）：pending=0
 *  （未到点优先前排）/ ongoing=1 / done=2 / wrap=3 / terminal=4。数值即排序
 *  权重，越小越靠前排。阶段推导不在这里重写——tripItemPhaseMap 单源。 */
export function tripDayDeckPriority(phase: TripItemPhase): number {
    switch (phase) {
        case 'pending':
            return 0;
        case 'ongoing':
            return 1;
        case 'done':
            return 2;
        case 'wrap':
            return 3;
        case 'terminal':
            return 4;
    }
}

/** 到点时间升序比较（local_date + time 换算 epoch ms；同刻恒等序稳定）。 */
function compareByDueAsc<T extends TripItemPhaseInput>(a: T, b: T): number {
    const dueA = tripItemDueAt(a.local_date, a.time);
    const dueB = tripItemDueAt(b.local_date, b.time);
    if (dueA !== dueB) return dueA < dueB ? -1 : 1;
    return 0;
}

/** 阶段表里是否仍有未到点/进行中项（决定 settled 段的组内方向）。 */
function hasUpcomingOrOngoing(phases: Map<string, TripItemPhase>): boolean {
    for (const phase of phases.values()) {
        if (phase === 'pending' || phase === 'ongoing') return true;
    }
    return false;
}

/**
 * 两两比较（纯函数，供排序与单测共用）：先组优先级；同组时
 * pending/ongoing 按到点时间升序；settled（done/wrap/terminal）在「仍有
 * 未到点/进行中项」时倒序（最新在前，旧卡垫底），全部过点后回到时序升序。
 */
export function compareDayDeckPriority<T extends TripItemPhaseInput>(
    a: T,
    b: T,
    phases: Map<string, TripItemPhase>,
): number {
    const priorityA = tripDayDeckPriority(phases.get(a.id) ?? 'pending');
    const priorityB = tripDayDeckPriority(phases.get(b.id) ?? 'pending');
    if (priorityA !== priorityB) return priorityA - priorityB;
    const byDue = compareByDueAsc(a, b);
    // settled 组且当日还有活口（未到点/进行中）→ 保持旧口径：新在前、旧垫底
    if (priorityA >= 2 && !hasUpcomingOrOngoing(phases)) return byDue;
    if (priorityA >= 2) return byDue === 0 ? 0 : -byDue;
    return byDue;
}

/**
 * 当日卡堆排序（trip-day-screen 消费）：未到点项优先占前排展示位——例：
 * 14:30 闹钟已过（ongoing/done），新增 16:00 未到点行程 → 16:00 卡排在前排；
 * 全部过点后回到默认时序。Array.prototype.sort 稳定，同刻同组保持输入序。
 */
export function orderTripItemsByDayDeckPriority<T extends TripItemPhaseInput>(
    items: T[],
    now: number,
): T[] {
    const phases = tripItemPhaseMap(items, now);
    return [...items].sort((a, b) => compareDayDeckPriority(a, b, phases));
}
