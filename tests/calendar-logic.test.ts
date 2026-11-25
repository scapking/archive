import assert from 'node:assert/strict';
import test from 'node:test';
import {
    formatDateFieldLabel,
    inDateRange,
    monthGrid,
    monthLabel,
    monthOf,
    shiftMonth,
} from '../src/features/archive/calendar-logic.ts';

/**
 * 日历纯逻辑（v0.4.7 行程日期选择重构）——DateField/DatePickerSheet/Calendar
 * 的共同事实源。预期结果按需求推导（中文周一开局、末行补齐防巨圆、跨年平移、
 * 闭区间闸、文案年份省写），不是实现复读。
 */

test('monthOf / monthLabel：月槽与月头文案', () => {
    assert.equal(monthOf('2026-11-13'), '2026-11');
    assert.equal(monthLabel('2026-11'), '2026年11月');
    assert.equal(monthLabel('2027-01'), '2027年1月');
});

test('shiftMonth：跨年双向平移（负 delta 回到上一年 12 月）', () => {
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2026-11', 0), '2026-11');
    assert.equal(shiftMonth('2026-02', -14), '2024-12');
});

test('monthGrid：周一开局 + 每行恒 7 格（跨行月份末行后置补齐——0.4.6 巨圆防回归）', () => {
    // 2026-11-01 是周日 → 前置空白 6 格；11 月 30 天 → 共 36 格 → 5+1 行
    const rows = monthGrid('2026-11');
    assert.equal(rows.length, 6);
    for (const row of rows) assert.equal(row.length, 7);
    // 首行：6 空 + 1 号落最后一列（周日）
    assert.deepEqual(rows[0].slice(0, 6), [null, null, null, null, null, null]);
    assert.equal(rows[0][6], '2026-11-01');
    // 末行只剩 30 号一格，但必须补齐 7 格（孤格不吞整行宽 → 不炸巨圆）
    assert.equal(rows[5][0], '2026-11-30');
    assert.deepEqual(rows[5].slice(1), [null, null, null, null, null, null]);
});

test('monthGrid：二月（28/29 天）月末日期正确', () => {
    const feb2026 = monthGrid('2026-02');
    const last = feb2026.flat().filter(Boolean).pop();
    assert.equal(last, '2026-02-28');
    const feb2028 = monthGrid('2028-02'); // 闰年
    assert.equal(feb2028.flat().filter(Boolean).pop(), '2028-02-29');
});

test('inDateRange：闭区间含端点，缺省侧不设限，空串恒不可选', () => {
    assert.equal(inDateRange('2026-11-13', '2026-11-13', '2026-12-05'), true);
    assert.equal(inDateRange('2026-12-05', '2026-11-13', '2026-12-05'), true);
    assert.equal(inDateRange('2026-11-12', '2026-11-13', null), false);
    assert.equal(inDateRange('2026-12-06', null, '2026-12-05'), false);
    assert.equal(inDateRange('2026-11-20', null, null), true);
    assert.equal(inDateRange('', '2026-11-13', null), false);
});

test('formatDateFieldLabel：同年省年份 / 跨年补年份 / 不完整与非法值返回 null', () => {
    assert.equal(formatDateFieldLabel('2026-11-13', 2026), '11月13日 周五');
    assert.equal(formatDateFieldLabel('2027-01-01', 2026), '2027年1月1日 周五');
    assert.equal(formatDateFieldLabel('2026-11-', 2026), null);
    assert.equal(formatDateFieldLabel('', 2026), null);
    assert.equal(formatDateFieldLabel('2026-13-40', 2026), null); // 伪日期不上文案
    assert.equal(formatDateFieldLabel('2026-02-29', 2026), null); // 非闰年 2/29 非法
});
