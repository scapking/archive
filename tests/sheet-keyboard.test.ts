import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * 键盘避让契约闸（v0.5.0，用户真机反馈「输入法弹出来后，会覆盖卡片」——
 * web CDP 照不到移动端键盘交互是本轮点名的方法论缺陷，修复锁进源码级断言）。
 *
 * 根因定性（计划文档）：Expo SDK 58 默认 edge-to-edge，Android adjustResize
 * 失效，KeyboardAvoidingView 的 behavior 拿不到 resize 后的布局 → 键盘直接
 * 覆盖。所以本闸只认**事件驱动**：Keyboard 监听器直读 endCoordinates.height
 * 驱动居中卡几何；KAV 裸兜底 = FAIL。预期来自指令与 RN/Expo 实证口径，
 * 不复制实现细节。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sheetSource = await readFile(
    path.join(repoRoot, 'src/features/archive/ui/sheet.tsx'),
    'utf8',
);
const tripDaySource = await readFile(
    path.join(repoRoot, 'src/features/archive/trip-day-screen.tsx'),
    'utf8',
);
const datePickerSource = await readFile(
    path.join(repoRoot, 'src/features/archive/ui/date-picker.tsx'),
    'utf8',
);
const appConfig = JSON.parse(
    await readFile(path.join(repoRoot, 'src/app.json'), 'utf8'),
) as { expo?: { android?: { softwareKeyboardLayoutMode?: string } } };

test('sheet.tsx 消费 keyboardDidShow/keyboardDidHide 事件（Android endCoordinates 直读；iOS 加挂 will；web no-op）', () => {
    assert.match(sheetSource, /Keyboard\.addListener\('keyboardDidShow'/, '缺 keyboardDidShow 监听');
    assert.match(sheetSource, /Keyboard\.addListener\('keyboardDidHide'/, '缺 keyboardDidHide 监听');
    // Android 端键盘高度唯一可靠来源 = 事件 endCoordinates.height 直读
    assert.ok(sheetSource.includes('endCoordinates.height'), '键盘高度未直读 event.endCoordinates.height');
    // iOS 加挂 keyboardWillShow 提前一拍（Android 不派发 will 系列，条件挂载）
    assert.ok(sheetSource.includes("Keyboard.addListener('keyboardWillShow'"), 'iOS 缺 keyboardWillShow 提前响应');
    assert.ok(/Platform\.OS === 'ios'/.test(sheetSource), 'keyboardWillShow 未挂 iOS 平台条件');
    // web 端 no-op（浏览器视口自管，JS 不掺和）
    assert.ok(/Platform\.OS === 'web'/.test(sheetSource), 'web 端缺 no-op 短路');
    // 订阅必须在卸载时移除（泄漏闸）
    assert.ok(sheetSource.includes('.remove()'), 'keyboard 订阅缺卸载清理');
});

test('宿主不再依赖裸 KeyboardAvoidingView behavior 兜底；两宿主 import ui/sheet 并渲染 CenteredSheet', () => {
    // 居中卡的让位层 = 事件驱动几何；KAV 兜底在 SDK 58 edge-to-edge 下已被
    // 真机证伪（Android 拿不到 resize 布局），两宿主源码一律不得回潮
    for (const [name, source, importPath] of [
        ['trip-day-screen', tripDaySource, "from './ui/sheet'"],
        ['date-picker', datePickerSource, "from './sheet'"],
    ] as const) {
        assert.ok(!source.includes('KeyboardAvoidingView'), `${name} 残留 KeyboardAvoidingView（须走事件驱动让位层）`);
        assert.ok(source.includes(importPath), `${name} 未 import ui/sheet 原语`);
        assert.ok(source.includes('<CenteredSheet'), `${name} 未渲染 CenteredSheet`);
    }
});

test('居中几何：scrim justify-center（不再贴底），卡体 maxWidth 档', () => {
    assert.ok(sheetSource.includes('justify-center'), 'CenteredSheet 缺居中几何 justify-center');
    assert.ok(!sheetSource.includes('justify-end'), 'sheet 原语出现贴底指纹（0.4.9 旧语言回潮）');
    assert.ok(sheetSource.includes('maxWidth'), '卡体缺宽度上限档（max-w-sm 由宿主传值）');
});

test('maxHeight 让位键盘：卡高/键盘/安全区实测几何在场，超限走内部 ScrollView', () => {
    // 抬升公式：lift = max(0, 卡高/2 + occupied + 气口 − 屏高/2)（下缘退过键盘顶）
    assert.match(sheetSource, /cardHeight \/ 2 \+ occupied/, '缺下缘避让抬升表达式');
    assert.match(sheetSource, /Math\.max\(0, cardHeight \/ 2/, '抬升必须 clamp 到非负（无键盘不位移）');
    // maxHeight = 屏高 − 键盘/安全区占位 − 上下气口：超限内容进卡内滚动
    assert.match(sheetSource, /containerHeight - occupied/, '缺 maxHeight 让位键盘表达式');
    assert.ok(sheetSource.includes('maxHeight: maxCardHeight'), 'maxHeight 未接到卡体样式');
    assert.ok(sheetSource.includes('<ScrollView'), '超限内容缺内部 ScrollView 通道');
    // 几何读实测值（onLayout），Dimensions 只作首帧初值
    assert.ok(sheetSource.includes('onLayout'), '容器/卡高未走 onLayout 实测');
    assert.ok(sheetSource.includes('insets.bottom'), '底部安全区未参与占位计算');
});

test('scrollIntoView 二次保险在场（Android/iOS 都挂），主钮走 footer 槽', () => {
    // RN 官方滚动应答：把聚焦输入滚到键盘上沿之上（native-only，web no-op）
    assert.ok(sheetSource.includes('scrollResponderScrollNativeHandleToKeyboard'), '缺 scrollIntoView 二次保险');
    assert.ok(sheetSource.includes('TextInput.State.currentlyFocusedInput()'), '保险未瞄准当前聚焦输入');
    // keyboardDidShow 落定后自动补一刀（覆盖 autoFocus 字段 focus 早于键盘到位）
    assert.ok(/keyboardHeight <= 0/.test(sheetSource), '缺键盘弹起后的自动保险触发');
    // 宿主 focus 钩子（键盘已弹起时换字段不再触发键盘事件）
    assert.ok(sheetSource.includes('useSheetFieldFocusGuard'), '缺宿主 focus 钩子导出');
    assert.ok(tripDaySource.includes('useSheetFieldFocusGuard()'), 'trip-day 字段 focus 未接保险');
    // footer 槽：主钮钉卡底（在 ScrollView 之外），键盘弹起不被滚动吞掉
    assert.ok(sheetSource.includes('footer'), 'CenteredSheet 缺 footer 钉底槽');
    assert.ok(tripDaySource.includes('footer='), 'trip-day 主按钮未走 footer 槽');
    assert.ok(datePickerSource.includes('footer='), 'date-picker 手输确认钮未走 footer 槽');
});

test('动画红线：位移走 Animated + native driver（transform 白名单），零新依赖', () => {
    assert.ok(sheetSource.includes('useNativeDriver: true'), '避让位移未走 native driver');
    assert.ok(sheetSource.includes('translateY'), '位移未走 transform（不得动画布局属性）');
    // 依赖面闸：只允许 react / react-native / safe-area-context / 域内 paper-shadow
    const specifiers = [...sheetSource.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    const allowed = new Set(['react', 'react-native', 'react-native-safe-area-context', './paper-shadow']);
    for (const specifier of specifiers) {
        assert.ok(allowed.has(specifier), `sheet.tsx 引入计划外依赖：${specifier}`);
    }
});

test('卡体拦截冒泡：点卡空白不关层（0.4.9 误关缺陷收口）', () => {
    assert.ok(sheetSource.includes('onStartShouldSetResponder'), '卡体缺 responder 认领（点卡空白会冒泡误关）');
});

test('v0.5.2 scroll 开关：可选 prop 默认 true，含滚轮快速态关外层内滚（根除同轴嵌套）', () => {
    // 原语契约：scroll?: boolean 默认 true——date-picker 等既有宿主不传值，
    // 内滚通道逐字保持（上方 maxHeight 让位用例的 <ScrollView> 断言即此档）
    assert.match(sheetSource, /scroll\?: boolean/, 'CenteredSheet 缺 scroll 可选 prop');
    assert.match(sheetSource, /scroll = true/, 'scroll 缺 true 默认（既有宿主兼容底线）');
    assert.match(sheetSource, /\{scroll \?/, '卡体内容未按 scroll 闸分叉内滚/静排');
    // trip-day 快速态（滚轮页）关外层滚动；第二步保持可滚（键盘避让输入场）
    assert.match(tripDaySource, /scroll=\{step !== 'time'\}/, 'trip-day 未按步态关外层滚动（同轴嵌套回潮风险）');
    assert.ok(!datePickerSource.includes('scroll='), 'date-picker 显式传 scroll（默认档即内滚，多余分叉）');
});

test('app.json 键盘模式与实现口径一致（softwareKeyboardLayoutMode 在场则必为 pan）', () => {
    // 事件驱动几何按「系统不改布局、键盘悬浮」设计（pan 语义）。resize 模式在
    // SDK 54+ edge-to-edge 下失效即本案根因；键缺失 = 控制器尚未落配置
    // （本 agent 无 app.json 写权），在场但不符即 FAIL。
    const mode = appConfig.expo?.android?.softwareKeyboardLayoutMode;
    if (mode !== undefined) {
        assert.equal(mode, 'pan', 'softwareKeyboardLayoutMode 与事件驱动避让口径不符');
    }
});
