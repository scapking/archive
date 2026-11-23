/**
 * 行程项表单纯函数（v0.4.4）：时间滚轮的几何换算与时刻格式化。屏层
 * （trip-day-screen TripItemFormCard）消费，node 测试直接 import 验证——
 * 滚轮手感的「吸附正确性」收口在这三个纯函数，不散在组件里。
 */

/** 滚轮上下填充行数：把首末项滚到中线（5 行窗口上下各 2 行）。 */
export const WHEEL_PAD_ROWS = 2;

/**
 * 滚轮行 index → 偏移量（px）：填充行计入（第 index 行的顶缘在
 * (index + WHEEL_PAD_ROWS) × itemHeight）。
 */
export function wheelOffsetForIndex(index: number, itemHeight: number): number {
    return (index + WHEEL_PAD_ROWS) * itemHeight;
}

/**
 * 滚轮偏移量 → 最近行 index：四舍五入到行（不是向下取整），并夹取到
 * [0, count-1] 值域——越界拖拽/回弹落在合法项上。
 */
export function wheelIndexFromOffset(offset: number, itemHeight: number, count: number): number {
    const raw = Math.round(offset / itemHeight) - WHEEL_PAD_ROWS;
    return Math.max(0, Math.min(count - 1, raw));
}

/** 时/分 → 'HH:mm'（补零；store 层时刻口径的唯一拼装点）。 */
export function normalizeWheelTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}