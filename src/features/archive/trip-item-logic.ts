import type { TripItemStatus } from './db';

/**
 * 行程项阶段与排序（v0.4.4，用户指令 #5/#8）——**阶段是派生态**：库里的
 * status 列只承载 pending（含历史 done/failed 兼容值），运行时阶段由时刻
 * 推导，不依赖后台写库（JS 上下文不常驻，定时翻转状态不可靠）。
 *
 * 阶段机（用户裁决）：pending（默认，未到点）→ ongoing（时间到，系统自动
 * 进入，配合系统闹钟提醒）→ done（doneAt = 时刻+30min 与下一项时刻取早，
 * 自动完成，无手动入口）→ wrap（收尾 = 补图补视频阶段，completed_at 落库
 * 后进入；done 与 wrap 都可加媒体）→ terminal（wrap_closed_at 落库 = 终态；
 * 历史.failed 行直接映射 terminal）。
 *
 * 排序（用户裁决 #5）：进行中（最早到点在前）→ 未来 pending 按时间**倒序**
 * （最新时间恒在最前）→ 已完成/收尾按时间**倒序**（旧的卡片在最后面，最旧
 * 的垫底）→ terminal 收尾段（同样倒序）。
 *
 * 本文件是 node 测试直接 import 的纯函数模块（不引 store/db 运行时）——
 * 时刻换算的唯一实现在这里，store.ts 重导出保持既有消费面不变。
 */

/** 运行时阶段（库里不持久化；见头注）。 */
export type TripItemPhase = 'pending' | 'ongoing' | 'done' | 'wrap' | 'terminal';

export const TRIP_ITEM_PHASE_LABEL: Record<TripItemPhase, string> = {
    pending: '待进行',
    ongoing: '进行中',
    done: '完成',
    wrap: '收尾',
    terminal: '已结束',
};

/** 完成窗口：到点后 30 分钟自动完成。 */
const DONE_WINDOW_MS = 30 * 60_000;

/**
 * 阶段推导的输入（结构化子集）：completed_at / wrap_closed_at 列落库之前，
 * 本模块的测试与排序先以可选字段运行；TripItemRow 结构天然满足。
 */
export interface TripItemPhaseInput {
    /** 行 id（阶段表按 id 键控；TripItemRow 天然满足）。 */
    id: string;
    status: TripItemStatus;
    local_date: string;
    time: string;
    /** 进入收尾的时刻（null = 未收尾）。 */
    completed_at?: number | null;
    /** 结束收尾的时刻（null = 收尾未结束）。 */
    wrap_closed_at?: number | null;
}

/**
 * 行程项触发时刻（local_date + 'HH:mm' → epoch ms，本地时区）：本地日期口径
 * 铁律同 trip-logic（禁 UTC 组合判断「哪天」）。通知调度、时间闸、阶段推导、
 * deck 排序共用本单一事实源，禁止屏层另写时刻组合。
 */
export function tripItemDueAt(localDate: string, time: string): number {
    const [year, month, day] = localDate.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

/**
 * 自动完成时刻：`dueAt + 30min` 与下一项时刻取早（下一项开始时，上一项不该
 * 还挂着「进行中」）。nextDueAt 缺省 = 当天最后一项，窗口走满 30 分钟。
 */
export function tripItemDoneAt(dueAt: number, nextDueAt?: number): number {
    const byWindow = dueAt + DONE_WINDOW_MS;
    return nextDueAt == null ? byWindow : Math.min(byWindow, nextDueAt);
}

/**
 * 阶段推导（见头注阶段机）。判断顺序 = 终态优先（历史 failed 与已结束收尾
 * 恒终态），再收尾（completed_at 已落库），再按时刻走 pending/ongoing/done。
 */
export function tripItemPhase(
    item: TripItemPhaseInput,
    now: number,
    nextDueAt?: number,
): TripItemPhase {
    if (item.status === 'failed' || (item.wrap_closed_at ?? null) != null) return 'terminal';
    if (item.status === 'done' || (item.completed_at ?? null) != null) return 'wrap';
    const dueAt = tripItemDueAt(item.local_date, item.time);
    if (now < dueAt) return 'pending';
    if (now < tripItemDoneAt(dueAt, nextDueAt)) return 'ongoing';
    return 'done';
}

/** 时间比较（升序；同刻保持输入序——Array.prototype.sort 稳定）。 */
function compareByTimeAsc(a: TripItemPhaseInput, b: TripItemPhaseInput): number {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    return 0;
}

/**
 * 逐项阶段表（id → phase）：排序与屏层卡面标签共用同一推导——doneAt 依赖
 * 「下一项时刻」（同日时间升序的邻项），两处各自推导必然漂移，收口在这里。
 */
export function tripItemPhaseMap<T extends TripItemPhaseInput>(
    items: T[],
    now: number,
): Map<string, TripItemPhase> {
    const asc = [...items].sort(compareByTimeAsc);
    const map = new Map<string, TripItemPhase>();
    asc.forEach((item, index) => {
        const next = asc[index + 1];
        const nextDueAt = next ? tripItemDueAt(next.local_date, next.time) : undefined;
        map.set(item.id, tripItemPhase(item, now, nextDueAt));
    });
    return map;
}

/**
 * deck 排序（排序即优先级，见头注）：先取逐项阶段表（doneAt 需要下一项
 * 时刻），再按阶段分段拼装——ongoing 升序（最早到点在前）、future/settled/
 * terminal 各自倒序（最新在前，最旧垫底）。
 */
export function orderTripItems<T extends TripItemPhaseInput>(items: T[], now: number): T[] {
    const phases = tripItemPhaseMap(items, now);
    const pick = (...wanted: TripItemPhase[]) =>
        items.filter((item) => wanted.includes(phases.get(item.id ?? '') ?? 'pending'));
    const ongoing = pick('ongoing').sort(compareByTimeAsc);
    const future = pick('pending').sort(compareByTimeAsc).reverse();
    const settled = pick('done', 'wrap').sort(compareByTimeAsc).reverse();
    const terminal = pick('terminal').sort(compareByTimeAsc).reverse();
    return [...ongoing, ...future, ...settled, ...terminal];
}