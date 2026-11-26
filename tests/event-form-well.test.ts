import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 新建事件 / 新建行程 表单容器化契约（v0.5.1 令 4，纸×墨 2.1 设计契约）：
 * 断言的是需求侧不变量——字段进**容器井**（surface + rounded-card 16 +
 * PAPER_CARD 影，eyebrow 11 在井内，输入走 field-input canvas 档）、动作行
 * **移出容器钉屏底**、既有键盘通道复用不新造；语义零漂移（字段词表、标题
 * 必填闸、创建落库路径、A11y label、IME 纪律）。被否的旧指纹（裸排字段、
 * 按钮被井包裹、已填摘要卡）按新形态反向断言。预期来自指令原文与总纲契约，
 * 不复制实现。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eventSource = await readFile(
    path.join(repoRoot, 'src/features/archive/event-form-screen.tsx'),
    'utf8',
);
const tripSource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-form-screen.tsx'),
    'utf8',
);

/** 出现次数（指纹计数断言用）。 */
function count(source: string, needle: string): number {
    return source.split(needle).length - 1;
}

// ─── 事件向导：井解剖 ────────────────────────────────────────────────────────

test('事件井解剖：surface 纸卡井（rounded-card 16 + PAPER_CARD 影 + p-4），同井按揭示堆叠', () => {
    // 唯一井：容器包裹设计（用户令「最好都是容器包裹设计」）；井参数逐项对齐
    // 设计契约——bg-ink-surface / rounded-card(16) / p-4 / PAPER_CARD_SHADOW
    assert.ok(eventSource.includes('rounded-card bg-ink-surface p-4 dark:bg-inkd-surface'), '事件井缺契约解剖类');
    assert.ok(count(eventSource, 'style={PAPER_CARD_SHADOW}') >= 1, '井缺 PAPER_CARD 静止卡影');
    // 揭示推进：井内渲染 step+1 个字段块（不是只渲染当前一个）
    assert.ok(eventSource.includes('Array.from({ length: step + 1 })'), '井未按揭示堆叠字段');
    assert.ok(eventSource.includes('<View className="gap-4">'), '井内字段块缺统一间距');
    // 边距基线：屏 px-6（内容列 paddingHorizontal 24）、井内 p-4、区块 mb-4
    assert.ok(eventSource.includes('paddingHorizontal: 24'), '屏体边距未收 px-6 基线');
});

test('井内输入走 field-input canvas 档（井即容器，盒中盒退役），体感参数保持', () => {
    const inputCount = count(eventSource, '<FieldInput');
    assert.equal(inputCount, 6, '事件向导应恰有 6 个 FieldInput（5 单行 + 描述）');
    assert.equal(count(eventSource, 'tone="canvas"'), inputCount, '存在未走 canvas 档的井内输入');
    // IME 纪律：屏层零裸 TextInput，native 输入只走 field-input uncontrolled 通道
    assert.ok(!/<TextInput/.test(eventSource), '事件屏出现裸 TextInput（IME 纪律）');
    // 既有输入体感：标题 h-14 + 20/28；单行 h-14 命中带（canvas justify-center 居中）；
    // 描述 multiline minHeight 120
    assert.equal(count(eventSource, 'containerClassName="h-14 justify-center"'), 5, '单行输入缺 h-14 命中带');
    assert.ok(eventSource.includes('fontSize: 20, lineHeight: 28'), '标题输入字阶漂移');
    assert.ok(eventSource.includes('minHeight: 120'), '描述 minHeight 120 体感漂移');
});

test('eyebrow 11 在井内字段顶部，字段词表与 A11y label 零漂移', () => {
    for (const label of ['标题', '位置', '处理人', '对象', '手机号', '邮箱', '描述']) {
        assert.ok(eventSource.includes(label), `字段词表缺「${label}」`);
    }
    assert.ok(eventSource.includes('text-[11px] font-medium'), '井内 label 未走 eyebrow 11 档');
    for (const a11y of ['事件标题', '处理人', '对象', '手机号', '邮箱', '事件描述']) {
        assert.ok(eventSource.includes(`accessibilityLabel="${a11y}"`), `缺 A11y label「${a11y}」`);
    }
    for (const btn of ['直接创建', '继续填写', '创建事件']) {
        assert.ok(eventSource.includes(btn), `缺按钮文案「${btn}」`);
    }
    assert.ok(eventSource.includes("accessibilityLabel={isLastStep ? '创建事件' : '继续填写'}"), '主钮动态 label 漂移');
    // 占位词表仍从 event-logic 取（展示词表单一事实源）
    assert.ok(eventSource.includes('EVENT_TITLE_PLACEHOLDER') && eventSource.includes('EVENT_DESCRIPTION_PLACEHOLDER'), '占位词表旁路');
});

// ─── 事件向导：动作行钉屏底 ──────────────────────────────────────────────────

test('动作行移出容器钉屏底：直接创建/继续填写在 ScrollView 之外、屏底带内', () => {
    // 结构指纹取按钮本体（doc 注释里也出现「直接创建」字样，文案串不算锚点）
    const ghostAt = eventSource.indexOf('accessibilityLabel="直接创建"');
    const primaryAt = eventSource.indexOf("accessibilityLabel={isLastStep ? '创建事件' : '继续填写'}");
    const scrollEnd = eventSource.indexOf('</ScrollView>');
    assert.ok(ghostAt > scrollEnd && primaryAt > scrollEnd, '按钮仍在 ScrollView（容器）内——旧指纹回潮');
    assert.ok(eventSource.indexOf('</KeyboardAvoidingView>') > ghostAt, '钮行须留在 KeyboardAvoidingView 内随键盘抬升');
    // ScrollView 段内不得出现按钮本体（被否旧形态：动作行被井/滚动体包裹）
    const scrollSection = eventSource.slice(eventSource.indexOf('<ScrollView'), scrollEnd);
    assert.ok(!scrollSection.includes('accessibilityLabel="直接创建"'), '「直接创建」钮残留在滚动体内');
    assert.ok(!scrollSection.includes("'继续填写'}"), '「继续填写」钮残留在滚动体内');
    // 屏底带几何：px-6 基线 + safe-area 收口 + 与滚动列同轴 maxWidth 560
    const footer = eventSource.slice(scrollEnd);
    assert.ok(footer.includes('insets.bottom'), '屏底带缺 safe-area 收口');
    assert.ok(footer.includes('maxWidth: 560'), '钮行与内容列不同轴');
});

test('键盘通道复用既有 KeyboardAvoidingView，不新造避让层', () => {
    assert.ok(eventSource.includes('<KeyboardAvoidingView'), '既有键盘通道被拆');
    assert.ok(eventSource.includes("Platform.OS === 'ios' ? 'padding' : undefined"), 'iOS padding 行为漂移');
    assert.ok(!eventSource.includes("from './ui/sheet'"), '事件向导不新引入 sheet 避让层（沿用既有通道）');
});

test('分步语义零漂移：X/7 指示 + 进度轨 + 标题必填闸 + 创建落库路径 + 换步滑入', () => {
    assert.ok(eventSource.includes('const STEP_TOTAL = 7;'), '步骤分母漂移');
    assert.ok(eventSource.includes('${step + 1} / ${STEP_TOTAL}'), '屏头步骤指示退场');
    assert.ok(eventSource.includes('h-[3px] flex-1 rounded-full'), '7 格进度轨退场');
    // 标题必填：前进与两钮同闸（store 校验同源）
    assert.ok(eventSource.includes('if (!titleValid) return;'), 'goNext 标题闸漂移');
    assert.equal(count(eventSource, 'disabled={!titleValid || submitting}'), 2, '两钮禁用闸漂移');
    // 创建落库路径不动
    assert.ok(eventSource.includes('createEvent({') && eventSource.includes('normalizeEventSubject('), '落库通道漂移');
    assert.ok(eventSource.includes('router.replace(`/events/${row.id}` as never)'), '成功后 replace 语义漂移');
    // 换步滑入保持（每字段稳定 pane，仅最新 animate；动画层只挂内联 style）
    assert.ok(eventSource.includes('animate={index === step && step > 0}'), '滑入只作用最新字段（旧 pane 重挂即丢焦点）');
    assert.ok(eventSource.includes('useNativeDriver: true') && eventSource.includes('translateX'), '滑入动画面漂移');
    // 疏密复核（令 2）：垂直居中死白段与已填摘要卡随井退役（井即实时回执）
    assert.ok(!eventSource.includes('flex-1 justify-center'), '单字段垂直居中死白节奏回潮');
    assert.ok(!eventSource.includes('filledSummary'), '已填摘要卡实现回潮（与井同屏双份）');
});

// ─── 行程表单：同一套井 + 底部钮语言 ────────────────────────────────────────

test('trip-form 主钮出容器钉屏底，flex-1 撑住钉底几何', () => {
    const scrollEnd = tripSource.indexOf('</ScrollView>');
    const buttonAt = tripSource.indexOf('<PrimaryButton');
    assert.ok(scrollEnd > 0 && buttonAt > scrollEnd, '创建行程钮仍在 ScrollView 内——旧指纹回潮');
    assert.ok(buttonAt < tripSource.indexOf('</KeyboardAvoidingView>'), '钮行须随既有键盘通道抬升');
    assert.match(tripSource, /<ScrollView\s+className="flex-1"/, '滚动体缺 flex-1（短表单钮钉不住底）');
    // 错误可见性与动作同屏配对：横幅上移到钉底钮上方（滚动段内不再有它）
    assert.ok(tripSource.slice(scrollEnd).includes('validation ?? storeError'), '错误横幅未与屏底钮配对');
    assert.ok(!tripSource.slice(tripSource.indexOf('<ScrollView'), scrollEnd).includes('validation ?? storeError'), '错误横幅残留在滚动体内（双份或错位）');
});

test('trip-form 井对齐 canvas 档（盒中盒 raised 退役），日期保持日历面板语言', () => {
    assert.equal(count(tripSource, 'tone="canvas"'), 2, '行程井内两个输入（名称/描述）必须走 canvas');
    assert.ok(!tripSource.includes('tone="raised"'), 'raised 盒中盒回潮');
    assert.ok(!/<TextInput/.test(tripSource), '行程屏出现裸 TextInput（IME 纪律）');
    assert.ok(tripSource.includes('containerClassName="h-14 justify-center"'), '名称输入缺 h-14 命中带');
    assert.ok(tripSource.includes('minHeight: 88'), '描述 minHeight 88 体感漂移');
    // /trip/new 出发/返回 = DateField + DatePickerSheet 日历面板（用户未否，不滚轮化）
    assert.equal(count(tripSource, '<DateField'), 2, '日期 DateField 面漂移');
    assert.ok(tripSource.includes('<DatePickerSheet'), '日历面板浮层退场（用户没否它）');
    assert.ok(!/[Ww]heel/.test(tripSource), '行程表单被滚轮化——越出「日期面板保持」边界');
});

test('trip-form 语义零漂移：字段词表 / 提交闸 / 落库路径 / A11y', () => {
    for (const label of ['行程名称', '出发日期', '返回日期', '行程描述', '持续进行', '设定结束', '创建行程', '保存修改', '删除行程']) {
        assert.ok(tripSource.includes(label), `词表缺「${label}」`);
    }
    // 提交闸（canSubmit = 校验 + 日期完备）与统一提交出口不动
    assert.ok(tripSource.includes('disabled={!canSubmit}'), '主钮提交闸漂移');
    assert.ok(tripSource.includes('runTripSubmit({') && tripSource.includes('endDate: endDateValue'), '落库通道/持续进行哨兵语义漂移');
    assert.ok(tripSource.includes("accessibilityLabel=\"出发日期\"") && tripSource.includes("accessibilityLabel=\"返回日期\""), '日期 A11y 漂移');
});
