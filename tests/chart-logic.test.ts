import assert from 'node:assert/strict';
import test from 'node:test';
import {
    areaPath,
    linePath,
    niceTicks,
    plotMetrics,
    xLabelPoints,
    type ChartPoint,
    type PlotBox,
} from '../src/features/archive/chart-logic.ts';

/** 连续 n 天的定长序列（日期从 start 起逐日 +1）。 */
function series(n: number, values?: number[]): ChartPoint[] {
    const start = Date.UTC(2026, 10, 1);
    return Array.from({ length: n }, (_, i) => {
        const d = new Date(start + i * 86_400_000);
        const date = d.toISOString().slice(0, 10);
        return { date, value: values ? values[i] : i };
    });
}

const BOX: PlotBox = { width: 300, height: 120, head: 18, foot: 18, inset: 5 };

test('niceTicks: zero/negative/NaN degrades to a bare baseline (no invented scale)', () => {
    for (const max of [0, -5, Number.NaN]) {
        assert.deepEqual(niceTicks(max), { ticks: [0], top: 1 });
    }
});

test('niceTicks: top strictly above max, so the line never touches the plot ceiling', () => {
    // max 恰为步长整数倍（旧实现让它相等，线贴顶）
    assert.equal(niceTicks(1000).top, 1500);
    assert.equal(niceTicks(500).top > 500, true);
    assert.equal(niceTicks(5).top > 5, true);
    // 非整数倍也严格大于
    for (const max of [850, 420, 980, 250]) {
        assert.ok(niceTicks(max).top > max, `top must exceed max=${max}`);
    }
});

test('niceTicks: steps are 1/2/2.5/5x10^n, always integers for counting charts', () => {
    assert.deepEqual(niceTicks(1000).ticks, [0, 500, 1000, 1500]);
    assert.deepEqual(niceTicks(850).ticks, [0, 500, 1000]);
    assert.deepEqual(niceTicks(480).ticks, [0, 250, 500]);
    assert.deepEqual(niceTicks(3).ticks, [0, 2, 4]);
    assert.deepEqual(niceTicks(1).ticks, [0, 1, 2]);
    assert.deepEqual(niceTicks(5).ticks, [0, 5, 10]);
    for (const max of [1, 3, 5, 26, 100, 480, 850, 1000, 24_000]) {
        for (const tick of niceTicks(max).ticks) {
            assert.ok(Number.isInteger(tick), `tick ${tick} (max=${max}) must be an integer`);
        }
    }
});

test('niceTicks: ticks start at 0, run to top with a uniform step', () => {
    for (const max of [1, 3, 5, 26, 100, 480, 850, 1000, 24_000]) {
        const { ticks, top } = niceTicks(max);
        assert.equal(ticks[0], 0);
        assert.equal(ticks[ticks.length - 1], top);
        const step = ticks[1] - ticks[0];
        for (let i = 1; i < ticks.length; i++) assert.equal(ticks[i] - ticks[i - 1], step);
    }
});

test('plotMetrics: maps the full range onto the box, no left label lane', () => {
    const points = series(30);
    const m = plotMetrics(points, 1000, BOX);
    assert.equal(m.left, 5);
    assert.equal(m.top, 18);
    assert.equal(m.plotW, 290);
    assert.equal(m.plotH, 84);
    assert.equal(m.y(0), 102);
    assert.equal(m.y(1000), 18);
    assert.equal(m.y(500), 60);
    assert.equal(m.x(0), 5);
    assert.equal(m.x(29), 295);
});

test('plotMetrics: degenerate inputs stay finite', () => {
    for (const pts of [[], series(1)]) {
        const m = plotMetrics(pts, 1000, { ...BOX, width: 0, height: 10 });
        assert.ok(Number.isFinite(m.x(0)));
        assert.ok(Number.isFinite(m.y(0)));
        assert.ok(m.plotW >= 1 && m.plotH >= 1);
    }
});

test('linePath: M-then-L per point, one decimal, empty for no points', () => {
    assert.equal(linePath([], plotMetrics([], 1000, BOX)), '');
    const points = [
        { date: '2026-11-01', value: 500 },
        { date: '2026-11-02', value: 1000 },
        { date: '2026-11-03', value: 0 },
    ];
    const d = linePath(points, plotMetrics(points, 1000, BOX));
    assert.equal(d, 'M5.0,60.0 L150.0,18.0 L295.0,102.0');
});

test('areaPath: closes down to the y=0 baseline; single points make no area', () => {
    const points = series(3, [0, 500, 0]);
    const m = plotMetrics(points, 1000, BOX);
    const d = areaPath(points, m);
    assert.match(d, /^M/);
    assert.match(d, /L295\.0,102\.0 L5\.0,102\.0 Z$/);
    assert.equal(areaPath(points.slice(0, 1), m), '');
});

test('xLabelPoints: 30-day window steps weekly and lands on the last day', () => {
    const labels = xLabelPoints(series(30), 7, 5);
    assert.deepEqual(
        labels.map((l) => l.index),
        [1, 8, 15, 22, 29],
    );
    // uniform step all the way, end included
    for (let i = 1; i < labels.length; i++) assert.equal(labels[i].index - labels[i - 1].index, 7);
    assert.equal(labels[labels.length - 1].index, 29);
});

test('xLabelPoints: labels are MM/DD', () => {
    const labels = xLabelPoints(series(30), 7, 5);
    for (const l of labels) assert.match(l.label, /^\d{2}\/\d{2}$/);
    assert.equal(labels[0].label, '11/02');
    assert.equal(labels[labels.length - 1].label, '11/30');
});

test('xLabelPoints: long windows double the step instead of crowding (still uniform)', () => {
    const labels = xLabelPoints(series(60), 7, 5);
    assert.ok(labels.length <= 5);
    assert.equal(labels[labels.length - 1].index, 59);
    const step = labels[1].index - labels[0].index;
    for (let i = 1; i < labels.length; i++) assert.equal(labels[i].index - labels[i - 1].index, step);
});

test('xLabelPoints: short series label every day; empty and single stay safe', () => {
    assert.deepEqual(
        xLabelPoints(series(4)).map((l) => l.index),
        [0, 1, 2, 3],
    );
    assert.deepEqual(xLabelPoints([]), []);
    assert.deepEqual(
        xLabelPoints(series(1)).map((l) => l.index),
        [0],
    );
});
