import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 时间选择与添加表单契约（v0.5.1 快速路径 v2）。断言的是需求侧不变量：
 * - 时间 = 0.4.3 滚轮交互语义的简化版（滚动即选、跟手、居中吸附），**不是
 *   照搬实现**——0.4.3 原版带滑动 bug（当年「上下滑动特别卡」投诉即它）。
 *   性能闸：滚动物理全交原生 ScrollView（snapToInterval + decelerationRate），
 *   JS 只在滚动**结束**事件做一次换算 + 一次去重 scrollTo 归位（web RNW 不
 *   实现 snapToInterval 的吸附补齐）；结构上禁 onScroll 逐帧监听/逐帧
 *   setState/滚轮段 JS 动画。快速连滑不丢帧不死锁属真机/CDP scroll 门实测
 *   边界，源码闸只锁「没有能让它卡的机制」；
 * - 快速态字段退场清单：标题输入框（快速路径）/「到点响铃」及其容器/备注
 *   入口全部消失；步进钮阵（0.4.9/0.5.0 形态）退役；
 * - 动作行照新建事件语言：「直接创建」ghost（无标题即提交）+「下一步」
 *   近黑主钮 → 第二步补填标题+备注，「改时间」ghost +「添加」主钮；
 * - CenteredSheet/键盘避让原语不回归（几何面由 sheet-keyboard.test.ts 把关）。
 * 预期来自指令与 animate-expo/mobile-native 口径，不复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);
/** 表单弹层段（TripItemSheet → TripDayScreen 屏体之间）。v0.5.1 令 1：
 *  段尾锚点原为「应用内闹钟确认卡 TripItemAlarmCard」——该弹窗已整体退场
 *  （到点统一走全屏闹钟屏 /alarm/<id>），锚点随之改为 TripDayScreen 之前的
 *  退场留痕注释行；段内容与旧界仅差被删组件，契约口径不变。 */
function formSection(): string {
    const start = screenSource.indexOf('function TripItemSheet(');
    const end = screenSource.indexOf('export function TripDayScreen(');
    assert.ok(start > 0 && end > start, 'TripItemSheet 段定位失败（结构变了口径同步）');
    return screenSource.slice(start, end);
}
/** 时间编辑段（滚动列/「此刻」快捷 → TripItemSheet 之前）。 */
function timeSection(): string {
    const start = screenSource.indexOf('/* 时间编辑');
    const end = screenSource.indexOf('function TripItemSheet(');
    assert.ok(start > 0 && end > start, '时间编辑段定位失败');
    return screenSource.slice(start, end);
}

test('上一代表全部退役：步进钮阵、响铃 chip、备注 chip、旧滚轮仲裁助手', () => {
    assert.ok(!screenSource.includes('TimeStepButton'), '0.4.9/0.5.0 步进钮阵回潮');
    assert.ok(!screenSource.includes('AlarmToggleChip'), '响铃 chip 回潮');
    // 「到点响铃」UI 文案在渲染段（TripItemSheet 函数体起）内不得出现
    // （函数前 docstring/模块头注记录退场指令原文，不在本闸口径）
    assert.ok(!formSection().includes('到点响铃'), '「到点响铃」文案残留（用户令删除）');
    assert.ok(!screenSource.includes('GhostChip'), '旧 GhostChip（加备注/此刻 36 高描边）回潮');
    assert.ok(!screenSource.includes('加备注'), '备注展开 chip 入口回潮（快速路径删备注）');
    assert.ok(!/from 'react-native'[\s\S]*?FlatList/.test(screenSource.split("} from 'react-native'")[0] ?? ''), 'FlatList import 残留');
    assert.ok(!screenSource.includes('<Switch'), '整行 Switch 回潮');
    // 旧 0.4.4 滚轮仲裁（逐帧换算时代遗物）不得回流屏层：屏层只从
    // trip-item-form-logic 取 normalizeWheelTime 一个导出
    assert.ok(!screenSource.includes('wheelIndexFromOffset'), '旧滚轮 JS 仲裁函数回潮');
    assert.ok(!screenSource.includes('wheelOffsetForIndex'), '旧滚轮几何换算回潮');
    const formLogicImport = screenSource.match(/import \{([^}]*)\} from '\.\/trip-item-form-logic'/);
    assert.ok(formLogicImport, 'normalizeWheelTime import 缺失');
    assert.equal(formLogicImport[1].trim(), 'normalizeWheelTime', 'trip-item-form-logic 消费面扩张');
});

test('滚动选时性能闸：原生 ScrollView 物理 + 结束事件 settle，结构禁 JS 逐帧', () => {
    const times = timeSection();
    assert.ok(times.includes('<ScrollView'), '时间列未用原生 ScrollView（滚动物理不得 JS 手搓）');
    assert.ok(times.includes('snapToInterval={WHEEL_ROW_H}'), '缺 native 行吸附（snapToInterval = 行高）');
    assert.ok(times.includes('decelerationRate="fast"'), '缺抬手即定档惯性口径');
    // settle 双通道（Android 慢拖可能不发 momentum 事件，endDrag 兜底）
    assert.ok(times.includes('onMomentumScrollEnd'), '缺 momentum 结束 settle');
    assert.ok(times.includes('onScrollEndDrag'), '缺 drag 结束 settle（Android 慢拖兜底）');
    // 红线：无逐帧监听/逐帧 setState/滚轮段 JS 动画
    assert.ok(!times.includes('onScroll={'), 'onScroll 逐帧监听回潮（0.4.7 卡顿教训）');
    assert.ok(!times.includes("addListener('scroll'"), 'scroll 事件逐帧订阅回潮');
    assert.ok(!times.includes('Animated'), '滚轮段出现 JS 驱动动画（交原生物理）');
    // web 吸附补齐：RNW 0.21 忽略 snapToInterval——settle 内偏移 >1px 时
    // 一次平滑 scrollTo 归位（去重闸同 editor.tsx 口径，收敛不死循环）
    assert.match(times, /Math\.abs\(y - snapped\) > 1/, '缺去重阈值的 scrollTo 归位');
    assert.match(times, /scrollTo\(\{ y: snapped, animated: true \}\)/, '缺归位 scrollTo 调用');
    // 取模恒成立：settle 先 clamp 再选值（松手必落合法档位）
    assert.match(times, /Math\.max\(0, Math\.min\(values\.length - 1, Math\.round\(y \/ WHEEL_ROW_H\)\)\)/, 'settle 缺 clamp 取整');
});

test('双列轻量滚轮：时 0-23 × 分 5 分档、3 行 44dp 窗口、初值与「此刻」同派生', () => {
    const times = timeSection();
    const sheet = formSection();
    assert.match(times, /const WHEEL_ROW_H = 44;/, '行高必须 ≥44dp 触控下限');
    assert.match(times, /const WHEEL_VISIBLE_ROWS = 3;/, '窗口收小到 3 行（0.4.3 的 5 行是「重」）');
    assert.match(times, /const WHEEL_PAD_ROWS = 1;/, '垫行与 3 行窗口联动');
    assert.match(times, /HOUR_VALUES = Array\.from\(\{ length: 24 \}/, '时列值域 0-23');
    assert.match(times, /MINUTE_VALUES = Array\.from\(\{ length: 12 \}, \(_, i\) => i \* 5\)/, '分列 5 分量化（00-55）');
    assert.ok(times.includes('nextFiveMinuteSlot'), '初值/「此刻」必须共用 5 分钟档派生');
    assert.ok(sheet.includes('normalizeWheelTime(hour, minute)'), '时刻拼装唯一走 normalizeWheelTime');
    assert.ok(sheet.includes('此刻'), '「此刻」快捷保留（收小档）');
    // 外部跳变（此刻）以 key 重挂双列定位，列内不做受控回写
    assert.match(sheet, /key=\{`hour-\$\{wheelEpoch\}`\}/, '「此刻」缺重挂定位通道（时列）');
    assert.match(sheet, /key=\{`minute-\$\{wheelEpoch\}`\}/, '「此刻」缺重挂定位通道（分列）');
});

test('滚动列可达性：role/label 齐全、settle 触感、禁用态诚实、零裸 TextInput', () => {
    const times = timeSection();
    assert.ok(times.includes('accessibilityLabel={accessibilityLabel}'), '滚动列缺可读标签');
    assert.ok(times.includes('haptics.selection()'), 'settle 缺选择触感（旧芯片触感口径保留）');
    assert.ok(times.includes('pointerEvents="none"'), '中带高亮必须不挡滚动');
    assert.ok(times.includes('accessibilityState={{ disabled }}'), '「此刻」缺 disabled 态播报');
    assert.ok(times.includes('hitSlop'), '小目标缺命中外扩');
    assert.ok(!/<TextInput/.test(screenSource), 'trip-day-screen 出现裸 TextInput（IME 纪律）');
});

test('快速路径字段退场 + 渐进动作：直接创建/下一步 → 改时间/添加，withAlarm 恒 true', () => {
    const sheet = formSection();
    // 快速态就剩时刻 + 动作行：无标题输入/备注入口/响铃容器
    const quickSlice = sheet.slice(0, sheet.indexOf("step === 'time' ?"));
    assert.ok(!quickSlice.includes('FieldInput'), '快速态默认区出现输入框（标题应在第二步才展开）');
    assert.ok(sheet.includes('标题（选填）'), '第二步缺标题补填（渐进交互学新建事件）');
    assert.ok(sheet.includes('备注（选填）'), '第二步缺备注补填');
    // 动作行四枚语义齐全（ghost 次级 + 近黑主钮，等分单行）
    for (const label of ['直接创建', '下一步', '改时间', '添加']) {
        assert.ok(sheet.includes(label), `动作行缺「${label}」`);
    }
    assert.ok(sheet.includes('palette.primaryBtn') && sheet.includes('palette.onPrimaryBtn'), '主钮未走近黑 primary-btn 语言');
    assert.ok(sheet.includes('bg-ink-surface'), 'ghost 次级钮未走 surface 语言');
    // 标题可空：无 canSubmit 闸（v0.5.0「空标题闸住」契约随输入框退场）
    assert.ok(!sheet.includes('canSubmit'), '空标题提交闸回潮（title 已放开可空）');
    // 提交形状 = store 契约不变；withAlarm UI 删但链路恒 true
    assert.ok(sheet.includes('time: timeLabel'), '提交缺 time 字段');
    assert.ok(sheet.includes('title: title.trim()'), '提交缺 title 字段');
    assert.ok(sheet.includes('description: note.trim()'), '提交缺 description 字段');
    assert.ok(sheet.includes('withAlarm: true'), 'withAlarm 必须恒 true（链路语义保留）');
    assert.ok(!sheet.includes('setWithAlarm'), '响铃开关状态回潮');
    // 第二步 done 键直发提交；标题走 FieldInput uncontrolled 通道
    assert.ok(sheet.includes('returnKeyType="done"') && sheet.includes('onSubmitEditing'), '标题 done 键必须直发提交');
    assert.ok(sheet.includes('<FieldInput'), '补填输入必须走 FieldInput');
    assert.ok(sheet.includes('useSheetFieldFocusGuard()') && sheet.includes('onFocus='), '输入聚焦缺 scrollIntoView 二次保险接线');
});

test('居中卡 sheet 语言保持：ui/sheet 原语 + footer 钉底动作行 + 返回键两段退出，禁 KAV/Modal', () => {
    const sheet = formSection();
    assert.ok(screenSource.includes("from './ui/sheet'"), '表单未迁 ui/sheet 原语');
    assert.ok(sheet.includes('<CenteredSheet'), '表单未渲染 CenteredSheet 居中卡');
    assert.ok(!screenSource.includes('KeyboardAvoidingView'), '屏层裸 KeyboardAvoidingView 兜底回潮（须走事件驱动让位层）');
    assert.ok(!screenSource.includes('import { Modal'), '禁止引入 RN Modal（条件渲染 + absolute 层范式保持）');
    assert.ok(!/\bModal\b/.test(screenSource.split("from 'react-native'")[0] ?? ''), 'react-native import 不得含 Modal');
    assert.ok(!sheet.includes('justify-end'), '表单仍是贴底弹层（居中卡契约）');
    // 动作行走 footer 槽（= 契约「容器外底部单行」且键盘弹起不被吞）
    assert.ok(sheet.includes('footer='), '动作行必须走 CenteredSheet footer 槽');
    assert.ok(sheet.indexOf('直接创建') > sheet.indexOf('footer='), '动作行不在 footer 槽内');
    // Android 返回键：第二步先回滚轮，滚轮态关闭；打开即收键盘
    assert.ok(sheet.includes('hardwareBackPress'), 'sheet 缺 Android 返回键闸');
    assert.ok(sheet.includes("step === 'detail'"), '返回键缺两步退出语义');
    assert.ok(sheet.includes('Keyboard.dismiss()'), 'sheet 缺打开即收键盘');
});

test('色走 palette 零散写；滚动列/动作行类走 ink/inkd 成对（双主题）', () => {
    const section = timeSection() + formSection();
    assert.ok(section.includes('palette.accent'), '「此刻」快捷未走 accent 数据色');
    assert.ok(section.includes('palette.primaryBtn'), '主钮未走 palette 主色档');
    assert.ok(
        !/["']#[0-9A-Fa-f]{3,8}["']/.test(section),
        '时间编辑/表单段出现硬编码 hex 字面量',
    );
    // css-interop 条件类铁律：surface/raised/muted/text 三对必须成对出现
    for (const cls of [
        'bg-ink-surface',
        'dark:bg-inkd-surface',
        'bg-ink-raised',
        'dark:bg-inkd-raised',
        'text-ink-muted',
        'dark:text-inkd-muted',
        'text-ink-text',
        'dark:text-inkd-text',
        'text-ink-secondary',
        'dark:text-inkd-secondary',
    ]) {
        assert.ok(section.includes(cls), `滚动列/动作行缺双主题成对类 ${cls}`);
    }
});
