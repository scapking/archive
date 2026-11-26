/**
 * 行程项表单纯函数（v0.4.4 立项；v0.5.2 滚轮手势重建改写）：滚轮的几何
 * 换算与时刻格式化。屏层（trip-day-screen TimeWheelColumn）消费，node 测试
 * 直接 import 验证——滚轮的「落档正确性」收口在本文件，不散在组件里。
 *
 * 位移口径（与 v0.5.1 ScrollView 版 scrollTo 语义严格一致，行居中公式不变）：
 * offset ≡ 内容上移的位移量（「等效 scrollTop」），第 index 行居中 ⇔
 * offset = index × rowHeight；上下渐隐垫行是纯视觉回绕，不参与映射。
 * wheelSnapIndex 带 'worklet' 指令：RNGH Pan onEnd（UI 线程）直接调用，
 * 同时是 node 测试的验证对象——手势吸附只有一个事实源。
 */

/** 滚轮上下填充行数：把首末项滚到中线（5 行窗口上下各 2 行，纯视觉）。 */
export const WHEEL_PAD_ROWS = 2;

/**
 * 惯性折算时长（s）：松手速度按 0.12s 投影进位移——粗略 fling 档，
 * 目的是「轻扫滚一档、猛扫滚数档」的手感，不追求物理精确。
 */
export const WHEEL_FLING_PROJECTION_S = 0.12;

/**
 * 滚轮行 index → 位移量（px）：第 index 行居中时内容需要上移的量。
 * 垫行不计（offset 基准 = 首个实体行居中位）。
 */
export function wheelOffsetForIndex(index: number, itemHeight: number): number {
    return index * itemHeight;
}

/**
 * 滚轮位移量 → 最近行 index：四舍五入到行（不是向下取整），并夹取到
 * [0, count-1] 值域——越界拖拽/回弹落在合法项上（「松手必落合法档」）。
 */
export function wheelIndexFromOffset(offset: number, itemHeight: number, count: number): number {
    const raw = Math.round(offset / itemHeight);
    return Math.max(0, Math.min(count - 1, raw));
}

/**
 * 松手落档仲裁（手势内核的唯一决策函数）：当前位移 + 纵向速度折算出投影
 * 位置，取最近档位。速度口径：velocityY > 0 = 手指下行（值向早处走，位移
 * 减小）。'worklet' 指令使 RNGH onEnd（UI 线程）可直接调用；纯算术，
 * node 测试同函数直测。
 */
export function wheelSnapIndex(
    offset: number,
    velocityY: number,
    itemHeight: number,
    count: number,
): number {
    'worklet';
    const projected = offset - velocityY * WHEEL_FLING_PROJECTION_S;
    const raw = Math.round(projected / itemHeight);
    return Math.max(0, Math.min(count - 1, raw));
}

/** 时/分 → 'HH:mm'（补零；store 层时刻口径的唯一拼装点）。 */
export function normalizeWheelTime(hour: number, minute: number): string {
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
