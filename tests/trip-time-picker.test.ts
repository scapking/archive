import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 时间选择与添加表单契约（v0.5.0 居中新形态；0.4.9 的「底部 sheet」指纹按
 * CenteredSheet 改写）。断言的是需求侧不变量：滚轮/双网格/贴底弹层全退场、
 * 表单走 ui/sheet 居中卡（键盘避让几何在 sheet-keyboard.test.ts 把关）、
 * 单行步进器（5 分量化 + 24h 环）、一步提交、触控与可达、色走 palette——
 * 预期来自指令与 animate-expo/mobile-native 口径，不复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);
/** 表单弹层段（TripItemSheet → TripItemAlarmCard 之间；闹钟确认卡维持
 *  静态居中 scrim 形态，不在键盘避让契约范围）。 */
function formSection(): string {
    const start = screenSource.indexOf('function TripItemSheet(');
    const end = screenSource.indexOf('function TripItemAlarmCard(');
    assert.ok(start > 0 && end > start, 'TripItemSheet 段定位失败（结构变了口径同步）');
    return screenSource.slice(start, end);
}
/** 时间编辑段（步进器/快捷 chip/开关 chip 组件群 → TripItemSheet 之前）。 */
function timeSection(): string {
    const start = screenSource.indexOf('/* 时间编辑');
    const end = screenSource.indexOf('function TripItemSheet(');
    assert.ok(start > 0 && end > start, '时间编辑段定位失败');
    return screenSource.slice(start, end);
}

test('旧代表全部退役：滚轮、24+12 芯片网格、贴底弹层、两步提交', () => {
    assert.ok(!screenSource.includes('TimeWheelColumn'), 'TimeWheelColumn 残留');
    assert.ok(!screenSource.includes('wheelIndexFromOffset'), '屏层不应再消费滚轮几何');
    assert.ok(!screenSource.includes('WHEEL_PAD_ROWS'), '屏层不应再消费滚轮垫行');
    assert.ok(!/from 'react-native'[\s\S]*?FlatList/.test(screenSource.split("} from 'react-native'")[0] ?? ''), 'FlatList import 残留');
    assert.ok(!screenSource.includes('HOUR_VALUES'), '24 格时芯片网格回潮');
    assert.ok(!screenSource.includes('MINUTE_VALUES'), '12 格分芯片网格回潮');
    assert.ok(!screenSource.includes('TimeChipGroup'), '双网格芯片组回潮');
    // v0.5.0 居中新形态：表单段不再出现贴底指纹（justify-end 属 0.4.9 旧语言）；
    // 居中几何本身由 ui/sheet 原语把关（sheet-keyboard.test.ts 契约闸）
    assert.ok(!formSection().includes('justify-end'), '表单仍是贴底弹层——v0.5.0 要求居中卡');
    assert.ok(!formSection().includes('下一步'), '两步「下一步→添加」回潮');
});

test('居中卡 sheet 语言：宿主走 ui/sheet 的 CenteredSheet，禁 KAV 裸兜底、禁 RN Modal', () => {
    const sheet = formSection();
    // 宿主契约：import ui/sheet 并渲染 CenteredSheet（避让几何在事件驱动层，
    // 不再靠 KeyboardAvoidingView behavior 赌系统——真机证伪：SDK 58 E2E 下
    // Android 拿不到 resize 布局，键盘盖卡）
    assert.ok(screenSource.includes("from './ui/sheet'"), '表单未迁 ui/sheet 原语');
    assert.ok(sheet.includes('<CenteredSheet'), '表单未渲染 CenteredSheet 居中卡');
    assert.ok(!screenSource.includes('KeyboardAvoidingView'), '屏层裸 KeyboardAvoidingView 兜底回潮（须走事件驱动让位层）');
    assert.ok(!screenSource.includes("import { Modal"), '禁止引入 RN Modal（条件渲染 + absolute 层范式保持）');
    assert.ok(!/\bModal\b/.test(screenSource.split("from 'react-native'")[0] ?? ''), 'react-native import 不得含 Modal');
    // 红线：Android 返回键关闭 + 打开即收键盘 + 主钮走 footer 槽（恒在键盘上方）
    assert.ok(sheet.includes('hardwareBackPress'), 'sheet 缺 Android 返回键闸');
    assert.ok(sheet.includes('Keyboard.dismiss()'), 'sheet 缺打开即收键盘');
    assert.ok(sheet.includes('footer='), '主按钮必须走 CenteredSheet footer 槽（键盘弹起不被吞）');
});

test('时间步进器：5 分量化 + 24h 环取模 + 「此刻」/初值同派生', () => {
    const times = timeSection();
    const sheet = formSection();
    assert.match(times, /const TIME_STEP = 5;/);
    assert.ok(times.includes('shiftFiveMinuteSlot'), '步进偏移必须走单一环上取模函数');
    assert.match(times, /% 1440/, '总分钟必须环上取模（跨 0 点回卷）');
    assert.ok(times.includes('nextFiveMinuteSlot'), '「此刻」与初值必须共用同一 5 分钟档派生');
    assert.ok(sheet.includes('此刻'), '「此刻」快捷必须在 sheet 内');
    // ±5 与 ±1h 四钮齐（小时档 = TIME_HOUR 60）
    for (const [label, amount] of [['−1h', '-TIME_HOUR'], ['−${TIME_STEP}', '-TIME_STEP'], ['+${TIME_STEP}', 'TIME_STEP)'], ['+1h', 'TIME_HOUR)']] as const) {
        assert.ok(sheet.includes(label), `步进钮 ${label} 缺失`);
        assert.ok(sheet.includes(amount), `步进调用 ${amount} 缺失`);
    }
});

test('触控与可达：步进 40dp + hitSlop 2 = 44dp，role/label 齐全，开关走 switch 语义', () => {
    const times = timeSection();
    assert.match(times, /const STEP_BTN = 40;/);
    assert.match(times, /const STEP_BTN_SLOP = 2;/);
    assert.ok(times.includes('hitSlop={STEP_BTN_SLOP}'));
    const stepSrc = times.split('function TimeStepButton(')[1]?.split('function GhostChip(')[0] ?? '';
    assert.ok(stepSrc.includes('accessibilityRole="button"'), '步进钮缺 button 角色');
    assert.ok(stepSrc.includes('accessibilityLabel={a11yLabel}'), '步进钮缺可读标签');
    const ghostSrc = times.split('function GhostChip(')[1]?.split('function AlarmToggleChip(')[0] ?? '';
    assert.ok(ghostSrc.includes('accessibilityState={{ disabled }}'), '此刻快捷缺 disabled 态');
    const alarmSrc = times.split('function AlarmToggleChip(')[1] ?? '';
    assert.ok(alarmSrc.includes('accessibilityRole="switch"'), '响铃 chip 开关缺 switch 语义');
    assert.ok(alarmSrc.includes('accessibilityState={{ checked: value }}'), '响铃 chip 缺 checked 态播报');
    // 到点响铃收进行内 chip：整行 Switch 井退场
    assert.ok(!screenSource.includes('<Switch'), '整行 Switch 回潮');
});

test('一步提交：主按钮恒在、空标题闸、done 键直发、IME 纪律（FieldInput uncontrolled 通道）', () => {
    const sheet = formSection();
    assert.match(sheet, /<PrimaryButton\s+label="添加"/, '「添加」主按钮必须恒在');
    assert.ok(sheet.includes('disabled={!canSubmit}') || sheet.includes('disabled={title.trim().length === 0}'), '空标题必须闸住提交');
    assert.ok(sheet.includes('returnKeyType="done"') && sheet.includes('onSubmitEditing'), '标题 done 键必须直发提交（路径最短）');
    assert.ok(sheet.includes('onSubmit({'), '提交通道保持 {time,title,description,withAlarm}');
    assert.ok(sheet.includes('time: timeLabel') && sheet.includes('withAlarm,'), 'store 契约字段不得改形');
    // 聚焦保险：FieldInput focus 挂 sheet 的 scrollIntoView 钩子（键盘已弹起时换字段）
    assert.ok(sheet.includes('useSheetFieldFocusGuard()') && sheet.includes('onFocus='), '输入聚焦缺 scrollIntoView 二次保险接线');
    // 屏层零裸 TextInput（native 输入只走 field-input 的 uncontrolled 通道）
    assert.ok(!/<TextInput/.test(screenSource), 'trip-day-screen 出现裸 TextInput（IME 纪律）');
    assert.ok(sheet.includes('<FieldInput'), '表单输入必须走 FieldInput');
});

test('色走 palette 零散写；弹层色阶走 ink/inkd className 成对', () => {
    const section = timeSection() + formSection();
    assert.ok(section.includes('palette.raised'), '步进钮未走 raised 纸面档');
    assert.ok(section.includes('palette.secondary'), '步进字色未走 secondary');
    assert.ok(section.includes('palette.accent'), '快捷/开关未走 accent 数据色');
    assert.ok(
        !/["']#[0-9A-Fa-f]{3,8}["']/.test(section),
        '时间编辑/表单段出现硬编码 hex 字面量',
    );
    // 响铃 chip 的 accent 淡底必须双主题成对（css-interop 条件类铁律）
    for (const cls of [
        'bg-ink-accent-bg',
        'dark:bg-inkd-accent-bg',
        'border-ink-accent',
        'dark:border-inkd-accent',
        'bg-ink-raised',
        'dark:bg-inkd-raised',
    ]) {
        assert.ok(section.includes(cls), `响铃 chip 缺双主题成对类 ${cls}`);
    }
});
