/**
 * 折线图几何（纯逻辑，R8 可单测）：坐标映射、取整刻度、路径生成。
 * 纪律（app-screens §6）：2px 直线段、面积 accent→透明渐变收口、
 * 3-5 条横网格、顶刻度高于最大值、无图例无数据点标记。
 */

export interface ChartPoint {
    date: string;
    value: number;
}

export interface PlotBox {
    width: number;
    height: number;
    lane: number; // 左侧留白（刻度文字）
    foot: number; // 底部 x 标签
    head: number; // 顶部留白
}

export interface PlotMetrics {
    left: number;
    top: number;
    plotW: number;
    plotH: number;
    y(v: number): number;
    x(i: number): number;
}

/** 取整刻度：1/2/5×10^n 步进，top ≥ max。 */
export function niceTicks(max: number): { ticks: number[]; top: number } {
    if (max <= 0) return { ticks: [0], top: 1 };
    const rough = max / 3;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? pow * 10;
    const top = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    for (let v = 0; v <= top; v += step) ticks.push(v);
    return { ticks, top };
}

export function plotMetrics(points: ChartPoint[], top: number, box: PlotBox): PlotMetrics {
    const left = box.lane;
    const topY = box.head;
    const plotW = Math.max(box.width - box.lane - 4, 1);
    const plotH = Math.max(box.height - box.head - box.foot, 1);
    const n = Math.max(points.length - 1, 1);
    return {
        left,
        top: topY,
        plotW,
        plotH,
        y: (v: number) => topY + plotH - (v / top) * plotH,
        x: (i: number) => left + (i / n) * plotW,
    };
}

export function linePath(points: ChartPoint[], m: PlotMetrics): string {
    if (points.length === 0) return '';
    return points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${m.x(i).toFixed(1)},${m.y(p.value).toFixed(1)}`)
        .join(' ');
}

export function areaPath(points: ChartPoint[], m: PlotMetrics): string {
    if (points.length < 2) return '';
    const line = linePath(points, m);
    const lastX = m.x(points.length - 1).toFixed(1);
    const firstX = m.x(0).toFixed(1);
    const baseY = m.y(0).toFixed(1);
    return `${line} L${lastX},${baseY} L${firstX},${baseY} Z`;
}

/** x 轴日期标签取样（首/尾 + 均分中点）。 */
export function xLabelPoints(points: ChartPoint[], count = 3): Array<{ index: number; label: string }> {
    if (points.length === 0) return [];
    const indices = new Set<number>([0, points.length - 1]);
    const middle = Math.floor((points.length - 1) / 2);
    if (count >= 3 && middle > 0 && middle < points.length - 1) indices.add(middle);
    return [...indices]
        .sort((a, b) => a - b)
        .map((index) => ({
            index,
            label: points[index].date.slice(5).replace('-', '/'),
        }));
}
