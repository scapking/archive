import { parseLocalDate, toLocalDate, WEEKDAY_LABELS } from './trip-logic.ts';

/**
 * 日历纯逻辑（v0.4.7 行程日期选择重构）：月份网格、月历头、日期区间判定、
 * 日期字段文案。禁止 import react / react-native（node 单测直导，同
 * trip-logic 纪律）；日期计算全部走 trip-logic 的 UTC 正午 Date（本地日期
 * 字符串为唯一事实源，禁止 UTC 时间戳判断「哪天」）。
 *
 * ui/calendar.tsx 与 features/archive/ui/date-picker.tsx 共用本文件——网格
 * 派生只有一份实现（v0.4.6 巨圆修复的末行补齐口径收进 monthGrid，任何消费
 * 面天然带上该修复）。
 */

/** 'YYYY-MM-DD' → 'YYYY-MM'（月历内部月槽）。 */
export function monthOf(date: string): string {
    return date.slice(0, 7);
}

/**
 * 月份平移（跨年安全）：入参/出参均为 'YYYY-MM'；day=1 探针无月末溢出问题
 * （UTC 正午 Date，同旧 calendar 内部实现）。
 */
export function shiftMonth(month: string, delta: number): string {
    const probe = parseLocalDate(`${month}-01`);
    probe.setUTCMonth(probe.getUTCMonth() + delta);
    return toLocalDate(probe).slice(0, 7);
}

/**
 * 月历网格（周一开局，中文日历惯例）：7 列 × N 行；前置空白补周一开局，
 * **末行后置 null 补齐 7 格**——列宽恒等，孤格不会把 aspect-square 撑成巨圆
 * （v0.4.6 CDP 实测修复的口径，收进纯逻辑由测试把关）。
 */
export function monthGrid(month: string): Array<Array<string | null>> {
    const first = parseLocalDate(`${month}-01`);
    const leading = (first.getUTCDay() + 6) % 7;
    // 当月天数：下月 0 号 = 本月最后一天（UTC 语义下天然正确）
    const dayCount = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const cells: Array<string | null> = [];
    for (let i = 0; i < leading; i += 1) cells.push(null);
    for (let day = 1; day <= dayCount; day += 1) {
        cells.push(`${month}-${String(day).padStart(2, '0')}`);
    }
    const rows: Array<Array<string | null>> = [];
    for (let i = 0; i < cells.length; i += 7) {
        const row = cells.slice(i, i + 7);
        while (row.length < 7) row.push(null);
        rows.push(row);
    }
    return rows;
}

/** 月历头的「2026年11月」文案（tabular 数字位由消费端处理）。 */
export function monthLabel(month: string): string {
    const [y, m] = month.split('-');
    return `${y}年${Number(m)}月`;
}

/**
 * 日期是否落在可选闭区间内（min/max 任一缺省 = 该侧不设限）。非法/空串恒
 * false——选择器的「不出错」由网格禁选承担：区间外日期不响应点按，不出现
 * 「选了返回日早于出发日」的表单态。字符串比较对 YYYY-MM-DD 天然有序。
 */
export function inDateRange(date: string, min?: string | null, max?: string | null): boolean {
    if (!date) return false;
    if (min && date < min) return false;
    if (max && date > max) return false;
    return true;
}

/**
 * 日期字段文案（DateField 消费）：同年省年份（「11月13日 周五」），跨年补
 * 「2027年…」——表单/卡面一眼定位且不啰嗦。不完整/非法值返回 null，调用方
 * 落「选择日期」占位文案。
 */
export function formatDateFieldLabel(value: string, todayYear: number): string | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return null;
    const [, y, m, d] = match;
    const year = Number(y);
    let weekday: string;
    try {
        weekday = WEEKDAY_LABELS[parseLocalDate(value).getUTCDay()];
    } catch {
        return null; // 形如 2026-13-40 的伪值：非法日期不上文案
    }
    const monthDay = `${Number(m)}月${Number(d)}日`;
    return year === todayYear ? `${monthDay} ${weekday}` : `${year}年${monthDay} ${weekday}`;
}
