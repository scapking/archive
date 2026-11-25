/**
 * 桌面 widget 快照整形（v0.4.7 用户指令 #1）——纯函数模块。
 *
 * 「自动选最新进行中行程 + 其行程项列表」的编排从 store.pushWidgetSnapshot
 * 内联逻辑收口到本文件（store.ts 是主控文件不可动，接线清单已列：store 侧改为
 * 调用 buildWidgetSnapshot）。双端（Android RemoteViews / iOS WidgetKit）渲染
 * 同一 JSON，字段即显示契约：
 *
 * - tripTitle：行程名（tripDisplayTitle 兜底）；
 * - items[].time：当日项 `HH:mm`，跨日项 `MM-DD HH:mm`（widget 呈现的是
 *   「当日行程表」语义，未来日期带日头）；
 * - items[].phase：阶段中文标签（待进行/进行中/完成/收尾/已结束）；
 * - items[].status：阶段机 key（双端按它做堆叠视觉层次：ongoing 高亮、
 *   done/wrap 弱化、terminal 最弱、pending 常规）。
 *
 * 本文件可被 node 单测直导：链上只允许纯函数（trip-logic / trip-item-logic /
 * db/schema），运行时 import 一律显式 `.ts` 扩展名（node ESM 解析要求，
 * tsconfig 开 allowImportingTsExtensions，Metro 原生支持；`@/core/widget` 只取
 * 类型面——import type 被擦除，不会把 expo 运行时带进测试进程）。
 */
import {
    TRIP_ITEM_PHASE_LABEL,
    tripItemPhaseMap,
    tripItemDueAt,
    type TripItemPhaseInput,
} from './trip-item-logic.ts';
import { isTripLocked, tripDisplayTitle } from './trip-logic.ts';
import type { WidgetSnapshot } from '@/core/widget';

export type { WidgetSnapshot, WidgetSnapshotItem } from '@/core/widget';

/** 快照条目（在 core 契约字段外多带 status/dueAt 渲染提示；旧端忽略未知字段）。 */
export interface WidgetSnapshotRow {
    /** 显示时间：当日 'HH:mm'，跨日 'MM-DD HH:mm'。 */
    time: string;
    title: string;
    /** 阶段中文标签（待进行/进行中/…）。 */
    phase: string;
    /** 阶段机 key（双端视觉分档用）。 */
    status: 'pending' | 'ongoing' | 'done' | 'wrap' | 'terminal';
    /** 到点时刻 epoch ms：双端在 push 间隙按本地时钟重推导时间派生档。 */
    dueAt: number;
}

/** 行程行的结构化子集（db.TripRow 天然满足）。 */
export interface WidgetTripInput {
    id: string;
    title: string;
    start_date: string;
    end_date: string;
}

/** 行程项行的结构化子集（TripItemPhaseInput + 卡面字段；db.TripItemRow 天然满足）。 */
export interface WidgetItemInput extends TripItemPhaseInput {
    trip_id: string;
    title: string;
}

/** 快照行数上限（Android 静态 4 行 / iOS 小卡 4 行为宜，超出截断）。 */
export const WIDGET_ROW_LIMIT = 4;

/** 'YYYY-MM-DD' → 'MM-DD'（widget 跨日项的日头）。 */
function monthDay(localDate: string): string {
    const parts = localDate.split('-');
    return parts.length === 3 ? `${parts[1]}-${parts[2]}` : localDate;
}

/**
 * 快照编排（与 core/widget 契约一致，纯派生零副作用）：
 * 进行中/计划中行程取 start_date 最新的一趟（锁定=已结束行程跳过）；该项行程
 * 「今天及未来」的行程项按（日期,时间）升序取 ≤4 条；阶段用全量项推导
 * （doneAt 依赖邻项时刻，截断后推导会漂移）。无可用行程 = 空快照。
 */
export function buildWidgetSnapshot(
    trips: WidgetTripInput[],
    items: WidgetItemInput[],
    now: number = Date.now(),
): WidgetSnapshot {
    const today = new Date(now);
    const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const active = trips
        .filter((trip) => !isTripLocked(trip, todayDate))
        .sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
    if (!active) return { tripId: '', tripTitle: '', items: [] };

    const mine = items.filter((item) => item.trip_id === active.id);
    const phases = tripItemPhaseMap(mine, now);
    const upcoming = mine
        .filter((item) => item.local_date >= todayDate)
        .sort((a, b) => {
            if (a.local_date !== b.local_date) return a.local_date < b.local_date ? -1 : 1;
            if (a.time !== b.time) return a.time < b.time ? -1 : 1;
            return tripItemDueAt(a.local_date, a.time) - tripItemDueAt(b.local_date, b.time);
        })
        .slice(0, WIDGET_ROW_LIMIT);

    return {
        tripId: active.id,
        tripTitle: tripDisplayTitle(active.title),
        items: upcoming.map((item) => {
            const phase = phases.get(item.id) ?? 'pending';
            return {
                time: item.local_date === todayDate ? item.time : `${monthDay(item.local_date)} ${item.time}`,
                title: item.title,
                phase: TRIP_ITEM_PHASE_LABEL[phase],
                status: phase,
                dueAt: tripItemDueAt(item.local_date, item.time),
            } satisfies WidgetSnapshotRow;
        }),
    };
}
