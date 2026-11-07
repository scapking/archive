import { TRIP_OPEN_ENDED, type TripRow } from './db';

/**
 * 行程纯逻辑（R8）：日期工具、天骨架生成、行程状态派生、输入校验。
 * 禁止 import react / react-native（可独立单测）。
 */

export type TripStatus = 'planning' | 'ongoing' | 'finished';

/** 装饰后的行程：查询结果恒为未删除行，故不含 deleted_at。 */
export type Trip = Omit<TripRow, 'deleted_at'> & {
    status: TripStatus;
    /** 天数：持续性行程（end_date = 'open'）无固定结束，无法计日 → null。 */
    dayCount: number | null;
};

// ─── 本地日期（YYYY-MM-DD）───
// 铁律：日期归属用本地日期字符串，禁止用 UTC 时间戳判断"哪天"（README 产品规划）。

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Date → 本地日期字符串（取本地年月日，不走 toISOString 的 UTC 转换）。 */
export function toLocalDate(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** 本地日期字符串 → Date（固定 UTC 正午，消除时区/夏令时的加减日偏差）。 */
export function parseLocalDate(value: string): Date {
    if (!isValidLocalDate(value)) {
        throw new RangeError(`trip-logic.parseLocalDate: 非法本地日期 "${value}"（期望 YYYY-MM-DD）`);
    }
    const [y, m, d] = value.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12));
}

export function isValidLocalDate(value: string): boolean {
    if (!LOCAL_DATE_PATTERN.test(value)) return false;
    const [y, m, d] = value.split('-').map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function todayLocal(): string {
    return toLocalDate(new Date());
}

/** 本地日期加 n 天（n 可为负）。 */
export function addDaysLocal(value: string, n: number): string {
    const date = parseLocalDate(value);
    date.setUTCDate(date.getUTCDate() + n);
    return toLocalDateFromUtcNoon(date);
}

function toLocalDateFromUtcNoon(date: Date): string {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, '0');
    const d = String(date.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** [start, end] 闭区间逐日列表；跨度超 366 天视为非法（RangeError，R5 参数校验）。 */
export function daysInclusiveRange(start: string, end: string): string[] {
    const count = dayDiff(start, end);
    if (count < 0) {
        throw new RangeError(`trip-logic.daysInclusiveRange: start(${start}) 晚于 end(${end})`);
    }
    if (count > 365) {
        throw new RangeError(`trip-logic.daysInclusiveRange: 跨度 ${count + 1} 天超过上限 366 天`);
    }
    const days: string[] = [];
    for (let i = 0; i <= count; i++) days.push(addDaysLocal(start, i));
    return days;
}

/**
 * 行程逐日骨架（详情页 D1…Dn 数据源）：持续性行程无法枚举未来日，返回 null，
 * 调用方（行程 UI 组）应改走「进行中天数」口径（如出发日到今天的枚举）而非抛错。
 */
export function tripDayList(row: Pick<TripRow, 'start_date' | 'end_date'>): string[] | null {
    if (isTripOpenEnded(row)) return null;
    return daysInclusiveRange(row.start_date, row.end_date);
}

/** end - start 的天数差（start==end → 0）。 */
export function dayDiff(start: string, end: string): number {
    return Math.round((parseLocalDate(end).getTime() - parseLocalDate(start).getTime()) / 86_400_000);
}

// ─── 天骨架 ──────────────────────────────────────────────────────────────────

/** 建行程时自动生成逐日骨架（"行程是骨架"的产品核心）。 */
export function generateDaySkeleton(start: string, end: string): string[] {
    return daysInclusiveRange(start, end);
}

// ─── 行程状态 ────────────────────────────────────────────────────────────────

/** 是否持续性行程（无固定结束日，DEV.md #4）：判断唯一入口，禁止散落 'open' 字面量比较。 */
export function isTripOpenEnded(row: Pick<TripRow, 'end_date'>): boolean {
    return row.end_date === TRIP_OPEN_ENDED;
}

/**
 * 状态由日期派生（单一事实源，不落库）：
 * 出发前 planning / 途中 ongoing / 结束后 finished。
 * 持续性行程（end_date = 'open'）出发后恒为 ongoing——它没有「结束」，
 * 除非用户后续补上固定结束日（届时按普通行程派生）。
 */
export function deriveTripStatus(
    row: Pick<TripRow, 'start_date' | 'end_date'>,
    today = todayLocal(),
): TripStatus {
    if (today < row.start_date) return 'planning';
    if (!isTripOpenEnded(row) && today > row.end_date) return 'finished';
    return 'ongoing';
}

/**
 * 行程是否已锁定（DEV.md #7「行程完成后不可以修改」）：
 * 已结束（finished）的行程只读；进行中/计划中/持续性（未设结束日）均可改。
 */
export function isTripLocked(
    row: Pick<TripRow, 'start_date' | 'end_date'>,
    today = todayLocal(),
): boolean {
    return deriveTripStatus(row, today) === 'finished';
}

export function decorateTrip(row: Omit<TripRow, 'deleted_at'>, today = todayLocal()): Trip {
    return {
        ...row,
        status: deriveTripStatus(row, today),
        dayCount: isTripOpenEnded(row) ? null : dayDiff(row.start_date, row.end_date) + 1,
    };
}

/** archive 页行程卡选卡：进行中 > 最近的计划中 > 刚结束的。 */
export function pickDeckTrip<T extends Trip>(trips: T[]): T | null {
    const ongoing = trips.filter((trip) => trip.status === 'ongoing').sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    if (ongoing.length > 0) return ongoing[0];
    const planning = trips.filter((trip) => trip.status === 'planning').sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
    if (planning.length > 0) return planning[0];
    const finished = trips.filter((trip) => trip.status === 'finished').sort((a, b) => (a.end_date > b.end_date ? -1 : 1));
    return finished[0] ?? null;
}

// ─── 输入校验 ────────────────────────────────────────────────────────────────

export interface TripInput {
    title: string;
    startDate: string;
    /** 结束日：null = 持续性行程（不设固定结束，DEV.md #4），跳过结束日相关校验。 */
    endDate: string | null;
}

/** 建行程表单校验：返回错误文案；null = 通过（日期部分另见 isValidLocalDate）。 */
export function validateTripInput(input: TripInput): string | null {
    if (input.title.trim().length === 0) return '给行程起个名字';
    if (input.title.trim().length > 40) return '行程名最多 40 个字';
    if (!isValidLocalDate(input.startDate)) return '出发日期不完整';
    if (input.endDate !== null) {
        if (!isValidLocalDate(input.endDate)) return '返回日期不完整';
        if (input.endDate < input.startDate) return '返回日期不能早于出发日期';
        if (dayDiff(input.startDate, input.endDate) > 365) return '行程不能超过 366 天';
    }
    return null;
}

// ─── 展示格式化（纯字符串，无 UI 依赖）──────────────────────────────────────

export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

/** '2026-11-05' → { monthDay: '11月5日', weekday: '周四' }。 */
export function formatDateParts(value: string): { monthDay: string; weekday: string } {
    const [y, m, d] = value.split('-').map(Number);
    const weekday = WEEKDAY_LABELS[parseLocalDate(value).getUTCDay()];
    return { monthDay: `${m}月${d}日`, weekday };
}

/** 行程区间 → '11月1日 – 11月7日'（跨年补年份）。 */
export function formatTripRange(start: string, end: string): string {
    const from = formatDateParts(start).monthDay;
    const to = formatDateParts(end).monthDay;
    if (start.slice(0, 4) === end.slice(0, 4)) return `${from} – ${to}`;
    return `${start.slice(0, 4)}年${from} – ${end.slice(0, 4)}年${to}`;
}

/** 区间文案的持续性感知入口：open 端无日期可格式化（formatTripRange 对 'open' 会抛错）。 */
export function formatTripSpan(row: Pick<TripRow, 'start_date' | 'end_date'>): string {
    if (isTripOpenEnded(row)) {
        return `${formatDateParts(row.start_date).monthDay} 出发 · 持续中`;
    }
    return formatTripRange(row.start_date, row.end_date);
}
