import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeWheelTime, wheelSnapIndex } from '../src/features/archive/trip-item-form-logic.ts';

/**
 * 时间选择与添加表单契约（v0.5.2 滚轮手势重建轮）。断言的是需求侧不变量：
 * - 滚轮 = **确定性自绘手势轮**（RNGH Gesture.Pan + Reanimated 共享值驱动
 *   translateY，UI 线程跑位移，JS 只在落档收一次 index）——v0.5.1 的原生
 *   ScrollView 吸附轮（snapToInterval + JS settle + 120ms 复检链）被用户
 *   真机+web 反馈证伪「任何方式都不可用」，本闸反向锁形：滚动容器属性、
 *   程序化滚动调用、滚动结束事件、setTimeout 复检、逐帧监听一律不得回潮；
 * - 手势域成立：屏层包 GestureHandlerRootView；「要点两下才可用」= 挂载后
 *   首帧才启用 Pan（armed 闸）；「此刻」重挂（epoch key）路径保持可用；
 * - 同轴嵌套根除：CenteredSheet 新增 scroll 开关（默认 true），快速态
 *   scroll=false 关外层滚动，第二步保持可滚；
 * - 落档语义（松手必落中线档 / 点非居中行滚到该行 / clamp 值域）由纯函数
 *   wheelSnapIndex 承接，node 直测；
 * - 快速态字段清单与动作行语言（直接创建/下一步 → 改时间/添加）沿用 v0.5.1；
 *   备注位差异化（v0.5.2 用户令）：multiline 大井（minHeight 110-128）+
 *   占位「补一句这一时刻」，与标题单行明显区分。
 * 预期来自指令与 animate-expo/mobile-native 口径，不复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const screenSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);
/** 键盘避让/居中卡原语（宽度定档闸跨文件读源）。 */
const sheetPrimitiveSource = await readFile(
    path.join(repoRoot, 'src/features/archive/ui/sheet.tsx'),
    'utf8',
);
/** 表单弹层段（TripItemSheet → TripDayScreen 屏体之间）。段尾锚点 = TripDayScreen
 *  之前的退场留痕注释行（v0.5.1 令 1 弹窗闹钟屏退场后口径不变）。 */
function formSection(): string {
    const start = screenSource.indexOf('function TripItemSheet(');
    const end = screenSource.indexOf('export function TripDayScreen(');
    assert.ok(start > 0 && end > start, 'TripItemSheet 段定位失败（结构变了口径同步）');
    return screenSource.slice(start, end);
}
/** 时间编辑段（自绘滚轮/「此刻」快捷 → TripItemSheet 之前）。 */
function timeSection(): string {
    const start = screenSource.indexOf('/* 时间编辑');
    const end = screenSource.indexOf('function TripItemSheet(');
    assert.ok(start > 0 && end > start, '时间编辑段定位失败');
    return screenSource.slice(start, end);
}

test('上一代表全部退役：步进钮阵、响铃/备注 chip、旧屏层滚轮仲裁', () => {
    assert.ok(!screenSource.includes('TimeStepButton'), '0.4.9/0.5.0 步进钮阵回潮');
    assert.ok(!screenSource.includes('AlarmToggleChip'), '响铃 chip 回潮');
    // 「到点响铃」UI 文案在渲染段（TripItemSheet 函数体起）内不得出现
    assert.ok(!formSection().includes('到点响铃'), '「到点响铃」文案残留（用户令删除）');
    assert.ok(!screenSource.includes('GhostChip'), '旧 GhostChip（加备注/此刻 36 高描边）回潮');
    assert.ok(!screenSource.includes('加备注'), '备注展开 chip 入口回潮（快速路径删备注）');
    assert.ok(!screenSource.includes('<Switch'), '整行 Switch 回潮');
    // 旧「逐帧换算时代」几何（偏移含垫行、屏层自仲裁）不得回流：屏层从
    // trip-item-form-logic 只取 normalizeWheelTime + wheelSnapIndex（end 单次裁决）
    assert.ok(!screenSource.includes('wheelIndexFromOffset'), '旧滚轮 JS 仲裁函数回潮屏层');
    assert.ok(!screenSource.includes('wheelOffsetForIndex'), '旧滚轮几何换算回潮屏层');
    const formLogicImport = screenSource.match(/import \{([^}]*)\} from '\.\/trip-item-form-logic'/);
    assert.ok(formLogicImport, 'trip-item-form-logic import 缺失');
    assert.deepEqual(
        formLogicImport[1].split(',').map((token) => token.trim()).filter(Boolean).sort(),
        ['normalizeWheelTime', 'wheelSnapIndex'],
        'trip-item-form-logic 消费面扩张（只许 normalizeWheelTime + wheelSnapIndex）',
    );
});

/** 剥块注释/JSDoc 后取代码面（段头注记录旧形态根因原文，不在反回潮闸口径；
 *  同「退场指令原文只在留痕注释」的既有闸纪律）。 */
function codeOnly(section: string): string {
    return section.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('滚轮内核反回潮闸：无滚动容器/无吸附属性/无程序化滚动/无结束事件/无复检轮询', () => {
    const times = codeOnly(timeSection());
    // v0.5.1 形态指纹全部禁绝（用户「任何方式都不可用」的机制面根因）
    assert.ok(!times.includes('<ScrollView'), '滚动容器回潮（同轴嵌套吞手势主根因）');
    assert.ok(!times.includes('snapToInterval'), 'snapToInterval 回潮（RNW 静默忽略 + native 嵌套失灵）');
    assert.ok(!times.includes('decelerationRate'), 'decelerationRate 回潮');
    assert.ok(!times.includes('scrollTo('), '程序化滚动调用回潮');
    assert.ok(!times.includes('onMomentumScrollEnd'), '滚动结束事件通道回潮');
    assert.ok(!times.includes('onScrollEndDrag'), 'drag 结束事件通道回潮');
    assert.ok(!times.includes('getScrollableNode'), 'DOM 滚动节点直读复检回潮');
    assert.ok(!times.includes('scheduleRecheck'), '延迟复检链回潮');
    assert.ok(!times.includes('setTimeout'), 'setTimeout 轮询回潮（落档必须在手势 end 一次完成）');
    assert.ok(!times.includes('setInterval'), 'setInterval 周期回潮');
    assert.ok(!times.includes('onScroll'), 'onScroll 逐帧监听回潮（0.4.7 卡顿教训）');
    assert.ok(!times.includes('scrollY'), '逐帧滚动值回潮（性能红线）');
});

test('滚轮新内核：RNGH Pan + Reanimated UI 线程位移，JS 只在落档收一次 index', () => {
    const times = timeSection();
    assert.ok(times.includes('Gesture.Pan'), '未用 RNGH Pan 手势内核');
    assert.ok(times.includes('GestureDetector'), '滚轮未挂 GestureDetector');
    assert.ok(times.includes('useSharedValue'), '位移未走共享值（UI 线程通道）');
    assert.ok(times.includes('useAnimatedStyle'), '列内容未经动画样式驱动');
    assert.ok(times.includes('translateY: -offset.value'), '位移口径 = translateY（非布局属性动画）');
    assert.ok(times.includes('withTiming'), '松手吸附未用声明式动画（无逐帧 setState）');
    assert.ok(times.includes('runOnJS(emitSelect)'), '落档必须只在 end 时经 runOnJS 交付 JS 一次');
    // 点按穿透：Pan 仅在纵向位移超阈值后认领 → 非居中行可点击滚到该行
    assert.match(times, /activeOffsetY\(\[-WHEEL_PAN_ACTIVE_DY, WHEEL_PAN_ACTIVE_DY\]\)/, '缺 Pan 认领阈值（点击/拖动消歧）');
    assert.match(times, /onPress=\{\(\) => snapTo\(i\)\}/, '实体行缺点按落档通道');
    // 双击根因闸：挂载首帧后 armed 才启用 Pan（RNGH 域就绪 + epoch 重挂同通道）
    assert.match(times, /\.enabled\(armed\)/, 'Pan 缺挂载后启用闸（「要双击才可用」根因位）');
    assert.ok(times.includes("requestAnimationFrame(() => setArmed(true))"), 'armed 未挂 rAF 首帧通道');
    // 越界橡皮筋（拖动不顶死）与落档 clamp（松手必落合法档）都在
    assert.ok(times.includes('WHEEL_RUBBER'), '越界橡皮筋缺失');
    assert.ok(times.includes('wheelSnapIndex'), '落档裁决未收口 wheelSnapIndex 纯函数');
    // web 触摸仲裁关闭（拖动被浏览器判滚动 = touchcancel 夭折，deck.tsx 同教训）
    assert.ok(times.includes("Platform.OS === 'web'"), '缺 web 平台闸');
    assert.ok(times.includes('touchAction'), '滚轮面缺 touch-action 收口');
});

test('手势域与嵌套根除：GH 局部域包 sheet 覆盖层 + 快速态 scroll=false', () => {
    assert.ok(screenSource.includes('GestureHandlerRootView'), '滚轮缺 GestureHandlerRootView 手势域');
    const sheet = formSection();
    // 快速态（滚轮页）关外层滚动；第二步含输入框保持可滚
    assert.match(sheet, /scroll=\{step !== 'time'\}/, 'CenteredSheet 未按步态关外层滚动');
    // 原语侧契约：可选 prop、默认 true（既有宿主零改动）、两分支渲染
    assert.match(sheetPrimitiveSource, /scroll\?: boolean/, 'CenteredSheet 缺 scroll 可选 prop');
    assert.match(sheetPrimitiveSource, /scroll = true/, 'scroll 缺 true 默认（既有宿主兼容底线）');
    assert.match(sheetPrimitiveSource, /\{scroll \?/, '卡体未按 scroll 闸分叉内滚/静排');
    // 卡体 responder 认领保留（防误关）——深于卡体的滚轮 GestureDetector 先认领，
    // 不挡滚轮手势（v0.5.2 定档：认领不收窄，web 侧另有 touch-action 兜底）
    assert.ok(sheetPrimitiveSource.includes('onStartShouldSetResponder={() => true}'), '卡体 responder 认领回退');
});

test('双列轻量滚轮：时 0-23 × 分 5 分档、5 行 44dp 窗口、初值与「此刻」同派生', () => {
    const times = timeSection();
    const sheet = formSection();
    assert.match(times, /const WHEEL_ROW_H = 44;/, '行高必须 ≥44dp 触控下限');
    assert.match(times, /const WHEEL_VISIBLE_ROWS = 5;/, '窗口必须 5 行档（3 行不像滚轮）');
    assert.match(times, /const WHEEL_PAD_ROWS = 2;/, '垫行与 5 行窗口联动（渐隐遮罩同高）');
    assert.match(times, /HOUR_VALUES = Array\.from\(\{ length: 24 \}/, '时列值域 0-23');
    assert.match(times, /MINUTE_VALUES = Array\.from\(\{ length: 12 \}, \(_, i\) => i \* 5\)/, '分列 5 分量化（00-55）');
    assert.ok(times.includes('nextFiveMinuteSlot'), '初值/「此刻」必须共用 5 分钟档派生');
    assert.ok(sheet.includes('normalizeWheelTime(hour, minute)'), '时刻拼装唯一走 normalizeWheelTime');
    assert.ok(sheet.includes('此刻'), '「此刻」快捷保留（收小档）');
    // 外部跳变（此刻）以 key 重挂双列定位，列内不做受控回写
    assert.match(sheet, /key=\{`hour-\$\{wheelEpoch\}`\}/, '「此刻」缺重挂定位通道（时列）');
    assert.match(sheet, /key=\{`minute-\$\{wheelEpoch\}`\}/, '「此刻」缺重挂定位通道（分列）');
});

test('落档纯函数：速度+位移折算目标行、松手必落中线档、clamp 值域', () => {
    // 静态对位：位移 = i×44 ⇔ 第 i 行（无速度）
    assert.equal(wheelSnapIndex(2 * 44, 0, 44, 24), 2);
    assert.equal(wheelSnapIndex(30, 0, 44, 24), 1, '半档以上进位（四舍五入非向下取整）');
    // fling 方向：手指上行（velocityY<0）→ 位移增大 → 目标行更靠后
    assert.equal(wheelSnapIndex(88, -330, 44, 24), 3);
    // 手指下行（velocityY>0）→ 位移减小 → 目标行更靠前
    assert.equal(wheelSnapIndex(88, 330, 44, 24), 1);
    // 松手必落合法档：越界速度/越界位移一律 clamp
    assert.equal(wheelSnapIndex(0, 3000, 44, 12), 0);
    assert.equal(wheelSnapIndex(11 * 44, -3000, 44, 12), 11);
    assert.equal(normalizeWheelTime(9, 5), '09:05');
});

test('滚轮可达性：role/label 齐全、落档触感、禁用态诚实、零裸 TextInput', () => {
    const times = timeSection();
    assert.ok(times.includes('accessibilityLabel={accessibilityLabel}'), '滚轮缺可读标签');
    assert.ok(times.includes('haptics.selection()'), '落档缺选择触感（旧芯片触感口径保留）');
    assert.ok(times.includes('pointerEvents="none"'), '中带/遮罩必须不挡手势');
    assert.ok(times.includes('accessibilityRole'), '行内点按钮缺 role');
    assert.ok(times.includes('accessibilityState={{ disabled }}'), '「此刻」缺 disabled 态播报');
    assert.ok(times.includes('hitSlop'), '小目标缺命中外扩');
    assert.ok(!/<TextInput/.test(screenSource), 'trip-day-screen 出现裸 TextInput（IME 纪律）');
});

test('滚轮呈现态（定档解剖沿用）：渐隐遮罩 + 中带实体底板 + 落档驱动的异级字阶', () => {
    const times = timeSection();
    const sheet = formSection();
    // ① 上下缘渐隐遮罩：LinearGradient 双枚（顶 raised→透明 / 底反向），
    //    各 2 垫行高、pointerEvents none；色走 palette 档零散写 hex
    const maskCount = (times.match(/<LinearGradient/g) ?? []).length;
    assert.equal(maskCount, 2, '渐隐遮罩必须上下两枚');
    assert.ok(times.includes('`${palette.raised}00`'), '遮罩色未走 palette.raised 同色渐隐');
    assert.ok(/height: WHEEL_PAD_ROWS \* WHEEL_ROW_H/.test(times), '遮罩高度未随垫行联动');
    // ② 井底/中带实体分层：raised 井 + base 白条（肉眼可辨的「当前行」容器）
    assert.ok(times.includes('bg-ink-raised dark:bg-inkd-raised'), '滚轮井底未沉 raised 档');
    assert.ok(times.includes('bg-ink-base dark:bg-inkd-base'), '中带缺 base 实体底板');
    // ③ 字阶异级（WheelValueRow 收口）：active（=落档后的 index 命中行）
    //    20/600 text 档，其余与回绕垫行恒 15/400 secondary
    assert.match(times, /fontSize: active \? 20 : 15/, '缺中/邻行字号异级');
    assert.match(times, /fontWeight: active \? '600' : '400'/, '缺中/邻行字重异级');
    assert.match(times, /color: active \? palette\.text : palette\.secondary/, '缺中/邻行色阶异级');
    assert.match(times, /active=\{i === index\}/, '实体行 active 映射不得偏离落档 index');
    // ④ 端档回绕垫行（纯视觉环回）：上垫取值域末 PAD 值、下垫取首 PAD 值；
    //    垫行不挂 onPress（不是候选值）
    assert.match(times, /values\[values\.length - WHEEL_PAD_ROWS \+ i\]/, '缺上缘回绕垫行');
    assert.match(times, /key=\{`pad-bot-\$\{i\}`\}\s+value=\{values\[i\]\} active=\{false\} \/>/, '缺下缘回绕垫行（且必须不可点）');
    // ⑤ 动作行文案不折行（实拍「直接创/建」缺陷闸）
    assert.ok((sheet.match(/numberOfLines=\{1\}/g) ?? []).length >= 2, '动作行按钮缺 numberOfLines=1');
    // ⑥ 根因闸：CenteredSheet 宽度定档（Animated.View 全宽 + 卡体 maxWidth 档，
    //    防卡宽再塌缩到内容固有宽）
    assert.match(sheetPrimitiveSource, /width: '100%'/, 'sheet Animated.View 缺宽度定档（卡宽塌缩根因）');
    assert.match(sheetPrimitiveSource, /alignItems: 'center'/, 'sheet 全宽后缺水平居中档');
    // ⑦ 节奏：滚轮→动作行自带 pb-4 呼吸（footer pt-3 合计区块档）
    assert.ok(sheet.includes('mt-4 flex-row gap-3 pb-4'), '滚轮与动作行之间缺区块呼吸');
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

test('备注位差异化（v0.5.2 用户令）：multiline 大井 + 占位「补一句这一时刻」，标题保持单行', () => {
    const sheet = formSection();
    assert.match(sheet, /placeholder="补一句这一时刻"/, '备注缺差异化占位文案');
    assert.match(sheet, /minHeight: 11[0-8]/, '备注井未加大到 110-128px 档');
    assert.ok(!sheet.includes('留言或备注'), '旧备注占位文案回潮');
    // 标题输入保持单行（不带 multiline/minHeight 大井）
    const titleField = sheet.slice(sheet.indexOf('行程项标题') - 700, sheet.indexOf('行程项标题'));
    assert.ok(!titleField.includes('multiline'), '标题输入出现 multiline（应保持单行）');
    assert.ok(!titleField.includes('minHeight'), '标题输入出现大井 minHeight');
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
    assert.ok(sheet.indexOf("ghostBtn('直接创建'") > sheet.indexOf('footer='), '动作行不在 footer 槽内');
    // Android 返回键：创建态第二步先回滚轮，滚轮态关闭；打开即收键盘
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
