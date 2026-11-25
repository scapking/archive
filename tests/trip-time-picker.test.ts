import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 时间选择重做契约（v0.4.7 用户追加令「时间轮丑、要重构」）：滚轮退役、
 * 点选网格上岗。断言的是需求侧不变量（键盘可达 / 命中尺寸 / 值域完整 /
 * 双主题走 palette），预期来自指令与 animate-expo 触控口径，不复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);

test('滚轮整轨退役：无 FlatList/wheel 几何消费', () => {
    assert.ok(!screenSource.includes('TimeWheelColumn'), 'TimeWheelColumn 未删除');
    assert.ok(!/from 'react-native'[\s\S]*?FlatList/.test(screenSource.split("} from 'react-native'")[0] ?? ''), 'FlatList import 残留');
    assert.ok(!screenSource.includes('wheelIndexFromOffset'), '屏层不应再消费滚轮几何');
    assert.ok(!screenSource.includes('WHEEL_PAD_ROWS'), '屏层不应再消费滚轮垫行');
});

test('值域完整：24 时 × 12 个 5 分步进 + 「此刻」快捷', () => {
    assert.match(screenSource, /const HOUR_VALUES = Array\.from\(\{ length: 24 \}/);
    assert.match(screenSource, /const MINUTE_VALUES = Array\.from\(\{ length: 12 \}, \(_, i\) => i \* 5\)/);
    assert.ok(screenSource.includes('nextFiveMinuteSlot'), '「此刻」与初值必须共用同一 5 分钟档派生');
    assert.match(screenSource, /此刻/);
});

test('触控与可达：视觉 40 + hitSlop 2 = 44dp，role/state 齐全', () => {
    assert.match(screenSource, /const TIME_CHIP = 40;/);
    assert.match(screenSource, /const TIME_CHIP_SLOP = 2;/);
    // 芯片与快捷钮都声明 button 语义 + selected/disabled 状态（读屏与键盘路径）
    const chipSrc = screenSource.split('function TimeChip({')[1]?.split('/**\n * 「此刻」快捷')[0] ?? '';
    assert.ok(chipSrc.includes("accessibilityRole=\"button\""), 'TimeChip 缺 button 角色');
    assert.ok(chipSrc.includes('accessibilityState={{ selected }}'), 'TimeChip 缺选中态播报');
    assert.ok(chipSrc.includes('hitSlop={TIME_CHIP_SLOP}'), 'TimeChip 缺命中外扩');
    const ghostSrc = screenSource.split('function TimeGhostChip({')[1]?.split('/** 芯片组')[0] ?? '';
    assert.ok(ghostSrc.includes('accessibilityState={{ disabled }}'), '此刻快捷缺 disabled 态');
});

test('色走 palette 零散写：选中 accent + onPrimaryBtn，禁用走 border/secondary', () => {
    const pickSrc =
        screenSource.split('function TimeChip({')[1]?.split('function TripItemAlarmCard')[0] ?? '';
    assert.ok(pickSrc.includes('palette.accent'), '选中态须走 accent 数据色');
    assert.ok(pickSrc.includes('palette.onPrimaryBtn'), '选中白字须走 palette（禁 hex，trip 屏零散写 hex 铁律）');
    assert.ok(pickSrc.includes('palette.raised'), '未选须走 raised 纸面档');
    assert.ok(
        !/["']#[0-9A-Fa-f]{3,8}["']/.test(pickSrc),
        '时间选择出现硬编码 hex 字面量',
    );
});
