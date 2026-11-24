/**
 * 折线图几何（纯逻辑，可单测）：取整刻度、坐标映射、路径生成、x 轴取样。
 *
 * 纪律（app-screens §6；2026-11-25 Me 页图表评审后的重写口径）：
 * - 刻度 1/2/5×10^n 步进、恒为整数（字数是计数，出现 0.5 刻度即错）、
 *   **顶刻度严格高于最大值**（等于最大值会让线贴住画区顶边，§6.3 点名问题）；
 * - 紧凑卡（120px 级）网格 3 条（含顶刻度线），刻度文字画在网格线内侧上方
 *   而非左侧——省掉刻度栏，画区占满卡宽；
 * - x 标签按周节奏取样且**步进从末尾（今天）起算**，保证落点包含最后一天、
 *   全线等步距（§6.3：强制收尾标签打断步距是点名问题；首/中/尾三点取样
 *   给出的两个随机日期没有任何锚定意义）；
 * - 直线段，不平滑插值（逐日字数是离散量，样条会在日间凭空造值，§6.4）；
 *   无图例、无数据点标记。
 */

export interface ChartPoint {
    date: string;
    value: number;
}

export interface PlotBox {
    width: number;
    height: number;
    /** 顶部留白：最高一条刻度文字（约 11px）画在顶网格线上方，落在这段里。 */
    head: number;
    /** 底部留白：x 标签区。 */
    foot: number;
    /** 左右内缩：线端点与标签锚点不贴画布边缘。 */
    inset: number;
}

export interface PlotMetrics {
    left: number;
    top: number;
    plotW: number;
    plotH: number;
    y(v: number): number;
    x(i: number): number;
}

/**
 * 取整刻度：1/2/5×10^n 步进（≥1，计数图不产小数刻度），intervals 为目标
 * 分段数（紧凑卡取 2），top 严格大于 max，ticks 自 0 步进到 top。
 * max ≤ 0（全零/空数据）退化为 { ticks: [0], top: 1 }——只留基线，不编刻度。
 */
export function niceTicks(max: number, intervals = 2): { ticks: number[]; top: number } {
    if (!Number.isFinite(max) || max <= 0) return { ticks: [0], top: 1 };
    const rough = max / Math.max(Math.floor(intervals), 1);
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    // 2.5×10^n 让 top 更贴最大值（少一截空顶），但只在整数档生效——计数图
    // 不产 0.5 刻度（§6.3「a 0.5 tick on a count」点名问题）
    const step = Math.max(
        [1, 2, 2.5, 5, 10]
            .map((m) => m * pow)
            .filter(Number.isInteger)
            .find((s) => s >= rough) ??
            pow * 10,
        1,
    );
    let top = Math.ceil(max / step) * step;
    if (top <= max) top += step;
    const ticks: number[] = [];
    for (let v = 0; v <= top; v += step) ticks.push(Math.round(v));
    return { ticks, top };
}

/** 坐标映射：画区 = [inset, width-inset] × [head, height-foot]；y 线性 0..top。 */
export function plotMetrics(points: ChartPoint[], top: number, box: PlotBox): PlotMetrics {
    const left = box.inset;
    const topY = box.head;
    const plotW = Math.max(box.width - box.inset * 2, 1);
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

/** 面积路径：折线 + 落回 y(0) 基线闭合。少于 2 点不构成面积。 */
export function areaPath(points: ChartPoint[], m: PlotMetrics): string {
    if (points.length < 2) return '';
    const line = linePath(points, m);
    const lastX = m.x(points.length - 1).toFixed(1);
    const firstX = m.x(0).toFixed(1);
    const baseY = m.y(0).toFixed(1);
    return `${line} L${lastX},${baseY} L${firstX},${baseY} Z`;
}

/**
 * x 轴标签取样：从最后一天（今天）起按 stepDays 等距倒退，序列必然落在末尾；
 * 数量超过 maxCount 时步距翻倍（仍等距）。短序列（≤maxCount 天）逐日全标。
 * 返回的 label 为 MM/DD；「今天」的字面替换属视图层措辞，不在几何层。
 */
export function xLabelPoints(
    points: ChartPoint[],
    stepDays = 7,
    maxCount = 5,
): Array<{ index: number; label: string }> {
    const n = points.length;
    if (n === 0) return [];
    const label = (index: number) => points[index].date.slice(5).replace('-', '/');
    let indices: number[];
    if (n <= maxCount) {
        indices = points.map((_, i) => i);
    } else {
        let step = Math.max(Math.floor(stepDays), 1);
        for (;;) {
            indices = [];
            for (let i = n - 1; i >= 0; i -= step) indices.unshift(i);
            if (indices.length <= maxCount) break;
            step *= 2;
        }
    }
    return indices.map((index) => ({ index, label: label(index) }));
}
