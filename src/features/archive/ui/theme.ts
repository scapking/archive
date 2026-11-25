import { useCallback, useEffect } from 'react';
import { Platform, TurboModuleRegistry, type TurboModule, type ViewStyle } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorScheme, useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { archiveConfig } from '@/config/archive';

/**
 * 主题偏好（灰白浅色 / 深色 / 跟随系统）：
 * 偏好持久在 archive.config（ui.theme），生效走 css-interop 的 colorScheme.set
 * （darkMode: 'class' 下合法）。set 只能在 effect / 事件回调里调（web 渲染期
 * 无 window 会抛错，见 css-interop color-scheme.js）；web 初始值恒为 'light'，
 * 「跟随系统」由启动时显式 set('system') 恢复。
 *
 * 值收口：className 走 tailwind 的 ink/inkd token；**非 CSS 场景**（SVG icon 的
 * color、ActivityIndicator、tabBar 原生 props 等 className 够不到的地方）一律从
 * getPalette 取语义色，禁止再散写 hex。
 */
export type ThemePref = 'system' | 'light' | 'dark';

/** 堆叠投影单档参数（front/back 共用结构，语义见 Palette.deckShadow 注）。 */
export interface DeckShadowSpec {
    /** 投影色（light = 墨色 text 档；dark = 纯黑——夜读纸面上黑影最实）。 */
    color: string;
    /** 投影浓度（iOS shadowOpacity / web rgba alpha；Android 忽略靠 elevation）。 */
    opacity: number;
    /** 模糊半径（dp）。 */
    radius: number;
    /** 右下偏移（光源左上 → 影落右下）。 */
    offsetX: number;
    offsetY: number;
    /** Android elevation（dp，近似档，系统按它派生影形）。 */
    elevation: number;
}

/** 非 CSS 场景的语义色（值与 tailwind.config.js 的 ink/inkd 严格成对）。 */
export interface Palette {
    /** 数据强调（进度/进行中/连续天数）；禁上 chrome。v0.4.9 收窄口径：蓝只做
        控件级小面积（开关轨道、选中芯片描边/底、卡面细边/圆点），禁大场底色。 */
    accent: string;
    onAccent: string;
    text: string;
    secondary: string;
    muted: string;
    faint: string;
    negative: string;
    /** 主行动底（近黑/反白近白）与其上文字。 */
    primaryBtn: string;
    onPrimaryBtn: string;
    /** 主按钮按压底。 */
    primaryBtnPress: string;
    surface: string;
    raised: string;
    border: string;
    /** 图表网格线（SVG 场景）。 */
    grid: string;
    /**
     * 行程项卡面三态**纸面档位色**（v0.4.9 梯度退场：「纸 × 墨 2.0」→ 2.1。
     * 用户判「渐变深蓝什么的太丑」——整面渐变底（含 ongoing 蓝坠墨黑）全域
     * 退役，纵深只靠档位差 + deckShadow 投影，状态只靠档位 + 细边 + 小面积
     * accent 点，无一格渐变色场）。三档 = 壳色 surface 的上下各一档，两主题
     * 方向严格一致（ongoing 亮于 surface、settled 沉于 surface）：
     * - ongoingFace：当前项 = 受光最足的一张纸（light 纯白 base 档 / dark
     *   夜面 raised 档），再配 faceAccentEdge 细边 + eyebrow accent 圆点；
     * - pendingFace：待进行 = 与卡壳同档 surface（素面白纸，不抢当前项）；
     * - settledFace：已完成/收尾/终态 = 从纸面沉一档向夜底收（完成的卡还是
     *   纸，只是光弱一档；禁灰板实色回潮）。
     * 卡面文字（eyebrow/标题/描述）在以上三档上双主题对比度必须 AA（≥4.5:1，
     * tests/deck-stack-colors 把关），accent 只上 edge/圆点（控件级小面积）。
     */
    ongoingFace: string;
    pendingFace: string;
    settledFace: string;
    /** 当前项卡面细边描色（= accent 档，1.5px 周线，非大场；禁散落第三蓝）。 */
    faceAccentEdge: string;
    /**
     * 堆叠 deck 投影档（「纸 × 墨 2.0」层次语言：卡面一律纸色 surface，分层 =
     * 柔和投影 + 位移 + 轻缩放，deckEdge 实色灰板壳色退役——用户否「灰色相进」
     * 但要求「可以区分」）。光源恒定左上，影落右下：
     * - front：前卡（栈顶），影投在背卡露条与页面上，形成「咬合」边界；
     * - back：背卡（贴地浅影），只需与页面底色离地。
     * 消费面 = deckShadowStyle()：iOS shadow* 键 / Android elevation /
     * web box-shadow 三端同源一份参数（见 deck.tsx 壳层注）。
     */
    deckShadow: { front: DeckShadowSpec; back: DeckShadowSpec };
    /** tabBar：激活按亮度（不上彩）、 bar 底带透明度、上缘细线、场景底。 */
    tabActive: string;
    tabInactive: string;
    barBg: string;
    barBorder: string;
    sceneBg: string;
    /** ActivityIndicator 等进行中指示。 */
    spinner: string;
}

/** 浅色（与 tailwind ink 组成对；改动必须同步 tailwind.config.js）。 */
const LIGHT: Palette = {
    accent: '#2563EB',
    onAccent: '#FFFFFF',
    text: '#171A1E',
    secondary: '#5A626B',
    muted: '#8B939C',
    faint: '#B4BAC2',
    negative: '#DC4A5E',
    primaryBtn: '#171A1E',
    onPrimaryBtn: '#FFFFFF',
    primaryBtnPress: '#3A3F46',
    surface: '#F7F8FA',
    raised: '#F0F2F5',
    border: '#E5E8EC',
    grid: '#ECEEF1',
    tabActive: '#171A1E',
    tabInactive: '#8B939C',
    barBg: '#FFFFFFF5',
    barBorder: '#E5E8EC',
    sceneBg: '#FFFFFF',
    spinner: '#2563EB',
    // 堆叠 deck 色阶（「纸 × 墨 2.1」v0.4.9：整面渐变退场，三态改纸面档位差 +
    // deckShadow 光影分层；档位值全部复用 ink 家族既有档——deckEdge 灰板与
    // ongoing 深蓝渐变端点同批退役，见 Palette.ongoingFace 注）
    ongoingFace: '#FFFFFF',
    pendingFace: '#F7F8FA',
    // 完成的卡 = 纸面沉一档（raised 档向墨收），不沉成灰板实色
    settledFace: '#F0F2F5',
    faceAccentEdge: '#2563EB',
    // 影色 = 墨色 text 档（ink 家族的投影不是新色，是同族加深）
    deckShadow: {
        front: { color: '#171A1E', opacity: 0.18, radius: 24, offsetX: 12, offsetY: 14, elevation: 10 },
        back: { color: '#171A1E', opacity: 0.12, radius: 14, offsetX: 6, offsetY: 8, elevation: 4 },
    },
};

/** 深色（与 tailwind inkd 组成对；改动必须同步 tailwind.config.js）。 */
const DARK: Palette = {
    accent: '#5B9DFF',
    onAccent: '#080A0A',
    text: '#E7EAE9',
    secondary: '#9CA3A1',
    muted: '#7A827F',
    faint: '#525A57',
    negative: '#E5566F',
    primaryBtn: '#E7EAE9',
    onPrimaryBtn: '#101314',
    primaryBtnPress: '#C9CFCE',
    surface: '#0E1111',
    raised: '#161B1A',
    border: '#1E2422',
    grid: '#1B211F',
    tabActive: '#E7EAE9',
    tabInactive: '#7A827F',
    barBg: '#0B0E0DF2',
    barBorder: '#1E2422',
    sceneBg: '#080A0A',
    spinner: '#5B9DFF',
    // 堆叠 deck 色阶（深色向：夜读纸面，档位方向与浅色严格同构——ongoing =
    // 夜面上受光的 raised 档、settled 向夜底沉一档；夜面投影比浅色更浓才咬得
    // 住边界——opacity 翻倍档见 deckShadow）
    ongoingFace: '#161B1A',
    pendingFace: '#0E1111',
    settledFace: '#0A0D0D',
    faceAccentEdge: '#5B9DFF',
    // 影色纯黑（夜面唯一有效的「更深一档」）
    deckShadow: {
        front: { color: '#000000', opacity: 0.62, radius: 28, offsetX: 12, offsetY: 14, elevation: 14 },
        back: { color: '#000000', opacity: 0.45, radius: 16, offsetX: 6, offsetY: 8, elevation: 6 },
    },
};

export function getPalette(theme: 'light' | 'dark'): Palette {
    return theme === 'dark' ? DARK : LIGHT;
}

/** 当前生效主题下的语义色（组件里取 icon color / 原生 props 用）。 */
export function usePalette(): Palette {
    return getPalette(useEffectiveTheme());
}

/** '#RRGGBB' + alpha → rgba() 串（web box-shadow 用；hex 必为 token 常量，
 *  解析失败回 0 通道由调用方保证输入合法）。 */
function hexAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 堆叠投影档 → 平台样式（「纸 × 墨 2.0」分层语言的落地点，deck.tsx 壳层消费；
 * 结果恒为**静态 style**，不进 Animated 样式图——native driver 白名单只有
 * transform/opacity，投影键挂在与动画层同 transform 的卡壳 View 上即可随层
 * 移动）。三端同源一份参数：
 * - web：box-shadow 合成串（expo web 预览 = CDP 截图管线走这条）；
 * - iOS：shadowColor/shadowOpacity/shadowRadius/shadowOffset（Fabric 下按
 *   圆角层生成 shadowPath）；
 * - Android：elevation 近似档（系统派生影形，opacity/radius 无对应物——
 *   档位取 spec 的 elevation 字段，与 RN 社区「elevation ≈ 影深」口径一致）。
 */
export function deckShadowStyle(spec: DeckShadowSpec): ViewStyle {
    if (Platform.OS === 'web') {
        return {
            boxShadow: `${spec.offsetX}px ${spec.offsetY}px ${spec.radius}px ${hexAlpha(spec.color, spec.opacity)}`,
        };
    }
    if (Platform.OS === 'android') {
        return { elevation: spec.elevation, shadowColor: spec.color };
    }
    return {
        shadowColor: spec.color,
        shadowOpacity: spec.opacity,
        shadowRadius: spec.radius,
        shadowOffset: { width: spec.offsetX, height: spec.offsetY },
    };
}

export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
    const pref = archiveConfig.use((state) => state['ui.theme']) as ThemePref;
    const setPref = useCallback((next: ThemePref) => {
        archiveConfig.update({ 'ui.theme': next });
        applyThemePref(next);
    }, []);
    return [pref, setPref];
}

/**
 * 计划媒体块对齐偏好（单张与堆叠共用，日记/事件编辑器同源消费）：
 * left（靠左，默认）/ center（居中）/ right（靠右）。纯展示偏好，无生效副作用
 * （区别于 useThemePref 的 colorScheme.set）——消费方在渲染处直接读值。
 */
export type MediaAlign = 'left' | 'center' | 'right';

export function useMediaAlignPref(): [MediaAlign, (align: MediaAlign) => void] {
    const align = archiveConfig.use((state) => state['ui.mediaAlign']) as MediaAlign;
    const setAlign = useCallback((next: MediaAlign) => {
        archiveConfig.update({ 'ui.mediaAlign': next });
    }, []);
    return [align, setAlign];
}

/** 应用主题偏好（启动与切换共用；'system' 交还系统媒体查询）。 */
export function applyThemePref(pref: ThemePref): void {
    colorScheme.set(pref);
}

/** 生效主题（nativewind 的 useColorScheme 认 set 覆盖，react-native 自带的不认）。 */
export function useEffectiveTheme(): 'light' | 'dark' {
    const pref = archiveConfig.use((state) => state['ui.theme']) as ThemePref;
    const schemeApi = useColorScheme();
    return schemeApi.colorScheme === 'dark' ? 'dark' : 'light';
}

// ---------------------------------------------------------------------------
// Android edge-to-edge 自愈（2026-11-09 第二轮 API 面审计修订）。
//
// 生效域分两种宿主，机理完全不同（本轮穷举结论，全部 file:line 实证）：
//
// 【dev build / prebuild（expo-dev-client）】react-native-edge-to-edge 原生
// 模块真实存在（package.json 依赖参与了原生编译）。onColorSchemeChange() 的
// 原生实现 = EdgeToEdgeModuleImpl.applyEdgeToEdge（setDecorFitsSystemWindows
// (false) + 透明系统栏 + contrast + cutout mode，EdgeToEdgeModuleImpl.kt）。
// 插件模块 onHostResume 派发（newarch EdgeToEdgeModule.kt），冷启错过派发即
// 补调本函数等价恢复。app.json 两个插件（react-native-edge-to-edge 的
// enforceNavigationBarContrast:false + expo-navigation-bar 的
// enforceContrast:false）此时也会真正写入 styles.xml（Theme.EdgeToEdge 平台
// attr 链），全链路自洽。
//
// 【Expo Go（用户当前跑 npx expo start 的环境）】本函数是静默 no-op：
// Expo Go 未捆绑 react-native-edge-to-edge 原生模块（expo 58 的
// bundledNativeModules.json 22 个 react-native-* 无此包；expo/expo main
// apps/expo-go/package.json 亦无该依赖）→ TurboModuleRegistry.get 返回 null
// → 直调无效。此前「直调无效 ≠ applyEdgeToEdge 不是缺的那块」，而是模块根本
// 不存在。Expo Go 的真实窗口链路（expo/expo main 源码）：
//   ① ExperienceActivity.onCreate → androidx enableEdgeToEdge()（窗口 E2E，
//      Q+ 上 isNavigationBarContrastEnforced=true 系统对比度 scrim，androidx
//      activity EdgeToEdge.kt:310-316）；
//   ② RN 核心 updateEdgeToEdgeFeatureFlag 从不执行：项目宿主
//      ReactNativeActivity extends AppCompatActivity（非 ReactActivity，
//      无 ReactActivityDelegate.onCreate 派发），expo-modules-core 的
//      EdgeToEdgePackage（反射调 updateEdgeToEdgeFeatureFlag 的桥）也不在
//      Expo Go 的 ExperiencePackagePicker.EXPO_MODULES_PACKAGES 白名单内
//      → RN 静态 flag isEdgeToEdgeFeatureFlagOn 恒 false → DeviceInfoModule
//      的 window 尺寸扣除系统栏 → Dimensions.get('window') 不含导航栏高度
//      =「部分功能不 E2E」的机制面（JS 侧 Expo Go 天花板，无法从 JS 置位）；
//   ③ 每次 onWindowFocusChanged(hasFocus, manifest!=null) →
//      ExperienceActivityUtils.setNavigationBar(manifest) 读 manifest
//      extra['expo-navigation-bar']（= app.json 里 expo-navigation-bar 插件
//      提升的 props）→ enforceContrast:false 写 isNavigationBarContrastEnforced
//      =false——这是 Expo Go 里唯一从项目配置到导航栏状态的通道，已在
//      app.json 接通，勿删。
//
// 保留本函数：dev build 下是冷启自愈正解；Expo Go 下 no-op 无副作用。
//
// 已排除路线（上轮审计，勿再试）：NavigationBar.setStyle（Q+ 上
// isContrastEnforced 读平台 attr 默认 true，setNavigationBarContrastEnforced
// 恒被打开，重开 scrim）；SystemUI.setBackgroundColorAsync 三拍补刷（只改
// decorView 底色，不穿 contrast/布局语义）。
//
// 【2026-11-09 政策修订：Expo Go 冷启自动双翻】上轮排除的「模拟主题切换」现已
// 作为 Expo Go 的指定修复启用——用户在 Me 页手动切主题验证过重建链路有效
// （applyThemePref → Appearance.setColorScheme → AppCompatDelegate 真实 uiMode
// 变化 → Activity 重建 → E2E 生效）并同意自动化。上轮排除的语境是「同值
// no-op 翻了没用 / 无谓闪屏」，本轮双翻（对档→原档）每翻都是真实变化且落点
// 回到用户原档，闪屏为冷启一次性可接受代价。实现与 guardrail 见文件尾段
// useAndroidE2eSelfRepair。dev build 仍走本函数 + _layout 探测 effect；双翻
// 不依赖 RNEdgeToEdge 原生模块，两类宿主通用（dev build 下 bottom>0 不会触发）。
/** RNEdgeToEdge TurboModule 最小 spec（严格对齐 react-native-edge-to-edge
    src/specs/NativeEdgeToEdgeModule.ts；只声明我们要调的方法，codegen 不参与）。 */
export interface RNEdgeToEdgeSpec extends TurboModule {
    onColorSchemeChange(): void;
}

/** 重设 Android edge-to-edge 窗口 flag（等价插件 onHostResume 的原生动作，
    幂等可重入；仅 Android 生效，其余平台 no-op）。 */
export function reapplyAndroidEdgeToEdge(): void {
    if (Platform.OS !== 'android') return;
    try {
        const mod = TurboModuleRegistry.get<RNEdgeToEdgeSpec>('RNEdgeToEdge');
        // 原生 applyEdgeToEdge 要求 currentActivity 非 null（EdgeToEdgeModuleImpl.kt:65-66
        // 为 null 仅 warn 跳过）：调用点在根组件挂载后——JS 本就挂在宿主 Activity 上
        // 渲染，此刻 Activity 必已 attach，无 null 风险。
        mod?.onColorSchemeChange();
    } catch (e) {
        console.warn('[theme] reapply android edge-to-edge failed:', e);
    }
}

// ---------------------------------------------------------------------------
// Android Expo Go 冷启 E2E 自动修复 v3（持久化守卫驱动的跨上下文状态机，
// 2026-11-10 可靠性加固轮：双采样检测 / restore 轮询自证 / 同 boot 一次重试；
// v3.1 2026-11-11 修复 'system' 原档归位反转——守卫归位基准改具体档
// originalResolved + 轮询镜像判据 + 收口重臂跟随系统，见下方 v3.1 注）。
//
// 【问题】Expo Go 58 未捆绑 react-native-edge-to-edge 原生模块（机理见上方
// reapplyAndroidEdgeToEdge 注），冷启窗口非 E2E（decorFitsSystemWindows=true，
// 内容止步导航栏上方）。检测口径（用户实证）：Android 上首帧稳定后读
// useSafeAreaInsets().bottom——E2E 时三键/手势导航的 bottom inset 必 >0，
// 非 E2E（insets 被窗口布局消费）恒 =0。
//
// 【v1/v2 教训 → v3 架构】v1「同上下文双翻」被真机证伪：Expo Go 的
// ExperienceActivity 重建是**新 JS 上下文**（bundle 重新求值），上下文内
// 定时器随重建丢失且与模块求值竞态崩溃，故每一步落盘为持久化守卫状态
// （AsyncStorage），每次挂载从守卫续跑恰好一步。v2 的单次判定与单点自证被
// 真机反馈证伪出四个概率性可靠性面，v3 逐项加固：
//
//   ① 检测防瞬态误判（双采样）：v2 挂载 400ms 单次读 bottom——健康设备的
//      insets 晚测量（单拍瞬时 0）会误入修复（无谓双翻重建）；反之瞬时 >0
//      （上次会话收尾/系统时序残留）会误判健康提前收口 → boot 页一闪而过且
//      修复没跑。v3 改 T1=400ms、T2=1000ms 各读一拍：**两拍全 0 才判定非
//      E2E 进入修复；任一拍 >0 即健康收口**（保守方向：宁可不修、不可误翻；
//      T1 即 >0 的健康冷启保持 ~400ms 快路径不回退）。
//   ② restore 自证改观察窗轮询：v2 restore 重建后单点读数，insets 事件晚到
//      时把「实际已生效」误判为失败。v3 在 restore 步后最长 1.5s 内以 100ms
//      间隔轮询 bottom，任一 >0 即成功，超时全 0 才判失败（消除时序误判面）。
//   ③ 同 boot 内一次重试：v2 restore 判失败即计败收口（本 boot 放弃）。v3
//      失败后同 boot 重开一轮 flip→restore（守卫 rounds 记账，至多 2 轮），
//      两轮仍 0 才计败收口（落 flip 守卫，下次冷启重试）；重试全程 boot 页
//      盖住（链内任何一步都不提前收口）。
//   ④ 计败口径：failedRuns = restore 轮询判失败的跨 boot 累计次数（每轮失败
//      +1，成功清守卫即清零）。v2 在第 3 次失败时清守卫收口，「守卫保留短路」
//      实际不持久（每 4 个冷启循环重来）；v3 达 3 次时守卫以 flip 态保留，
//      后续冷启在检测步持续短路放弃，出口 = 手动切主题（Me 页）或 dev build。
//
// 每上下文至多一次检测/一步（e2eStepRanInThisContext 在收口处置位，重挂
// 短路；同 boot 多轮跨越多个上下文，轮次由守卫 rounds 字段跨上下文记账）。
// 翻转与归位的 Activity 重建全部被 boot 页盖住（见文件尾 boot gate 段）。
//
// 【guardrail】1. 失败计数落盘 + 3 次放弃（守卫保留持续短路；E2E 健康冷启
// 自动清零重置）；2. 双翻窗口用户竞态：盘上 'ui.theme' 被用户改过 → 中止
// 尊重用户；3. 注水超时不动（宁缺毋滥——用默认档误当原档会翻错用户主题；
// 下次冷启重试，不计失败）；4. 误判面：全屏隐藏导航栏设备（E2E 但
// bottom=0）→ 走一轮翻转后原档归位，可接受；insets 镜像未测得（null）沿用
// -1 口径进入修复路径（实测不可达，防御性兜底）。
//
// 【v3.1 2026-11-11 修复：pref='system' 每次冷启反转（用户实证「本来是深色的，
// 跟随系统反转了；只有跟随系统会反转」）】根因 = 修复链出/回两个方向对
// 'system' 的语义不对称：
//
//   出（翻转）用具体档：applyThemePref('light'/'dark') → css-interop
//   appearance-observables set() → Appearance.setColorScheme(具体值) →
//   AppearanceModule.kt:85-95 AppCompatDelegate.setDefaultNightMode
//   (MODE_NIGHT_NO/YES)——具体档无歧义，必是真实 uiMode 变化 → Activity 重建
//   （E2E 修复点）。
//
//   回（归位）却用 applyThemePref('system')：set('system') 在 RN≥0.82 传
//   'unspecified'（appearance-observables.ts:24-33）→ setDefaultNightMode
//   (MODE_NIGHT_FOLLOW_SYSTEM)。FOLLOW_SYSTEM 的落地**不读系统设置**：
//   AppCompatDelegateImpl.createOverrideAppConfiguration（androidx-main 源码
//   2564-2571 行）从 applicationContext resources configuration 重解析 uiMode，
//   而该配置在本进程已钉过具体档后与真实系统档脱钩 → 重解析结果 = 翻转档，
//   与 currentNightMode 相同 → updateAppConfiguration 零 configChanges →
//   不重建不更新、静默 no-op → 归位永远不发生，app 停在对档。翻转重建本身
//   已修好 E2E → restore 轮询按 bottom>0 判「成功」清守卫 → 反转固化，每个
//   冷启重复（新进程起步恒跟随系统、先对后错）。light/dark 原档的归位本来
//   就是具体档 → 不受影响——与「只有跟随系统会反转」精确吻合。另：开轮
//   shortcut 判「生效档 !== originalPref」对 'system' 恒真 → 第 1 轮从不真正
//   翻转（白耗轮询还计败），实际修复全靠第 2 轮重试。
//
//   修复（phase 状态机复用，不回退 E2E 自愈）：
//   a. 守卫新增 originalResolved（修复起点解析出的具体档，翻转前采集）：归位
//      目标从 'system' 改为该具体档——setDefaultNightMode(MODE_NIGHT_*) 无任何
//      配置重解析歧义，归位必是真实 uiMode 变化（机理面 a）。
//   b. 开轮 shortcut 改用解析后具体档比较；fresh detect（新进程、delegate 尚
//      未钉档）时 'system' 解析 = 当前生效档 = 真实系统档 → 'system' 原档与
//      light/dark 走同一条「真翻转」主路径（机理面 b）。
//   c. restore 自证轮询加第二判据「镜像已到归位目标」：只看 bottom 会在归位
//      已排队、重建未落地的窗口提前收口（此刻 JS 镜像仍是对档 → app 内容以
//      对档抢跑一拍再翻回）。bottom>0 且镜像 === originalResolved 才算成功
//      （机理面 c；镜像未到的重建窗口由新上下文按同守卫续跑自证，v3 既有口径）。
//   d. 收口前重臂跟随系统（仅原档 'system'）：链内两次具体档翻转把 delegate
//      钉在具体档上，须交还 FOLLOW_SYSTEM（否则运行中系统深浅切换不再实时
//      跟随）。此刻镜像已证 === 归位目标，重解析无论读真实系统还是已收敛的
//      app 配置都 === 当前档，无翻转歧义；若修复期间系统深浅被改，重解析到
//      新值 → 重建跟随新值 = 正确的跟随语义。_layout 每上下文挂载 effect 也会
//      按盘上 pref 重放 applyThemePref（'system' → FOLLOW_SYSTEM），双保险
//      （_layout 不在本次允许改动清单，无需改）。
//   e. v3 残留守卫（无 originalResolved 且原档 'system'）在 restore 续跑上下文
//      无法可靠归位（生效档 = 翻转档 ≠ 真实系统档，JS 侧无真实系统档读取通道）
//      → 放弃本次（清守卫收口，下次冷启新进程生效档 = 真实系统档，重新检测
//      拿正确基准；宁缺毋滥，同注水守卫哲学）。
// ---------------------------------------------------------------------------

/** 修复守卫持久化键（AsyncStorage 直连：archive.config 是用户配置域文档，
    修复状态属运行时自愈流程，混入会污染配置语义）。 */
const E2E_REPAIR_GUARD_KEY = 'archive.e2e-repair-guard';

/** restore 轮询判失败累计上限：跨 boot 累计第 3 次后放弃自动修复（防死循环
    骚扰，出口转人工/dev build；守卫保留使后续冷启持续短路）。 */
const E2E_REPAIR_MAX_FAILED_RUNS = 3;

/** 单 boot 内 flip→restore 最大轮数：第 1 轮判失败后同 boot 重试 1 次，两轮
    仍非 E2E 才计败收口放弃本 boot（下次冷启重试）。 */
const E2E_REPAIR_MAX_ROUNDS_PER_BOOT = 2;

/** 检测第一拍 = 各步动作前的稳定等待（挂载/重建后的布局与 insets 沉淀）。 */
const E2E_REPAIR_STEP_DELAY_MS = 400;

/** 检测第二拍：与第一拍两拍全 0 才判定非 E2E（双采样防瞬态误判，见段头注①）。 */
const E2E_REPAIR_DETECT_SECOND_SAMPLE_MS = 1000;

/** restore 自证观察窗上限：轮询时长（bottom>0 且镜像已到归位目标即成功；
    超时判失败）。 */
const E2E_REPAIR_RESTORE_POLL_WINDOW_MS = 1500;

/** restore 自证轮询间隔。 */
const E2E_REPAIR_RESTORE_POLL_INTERVAL_MS = 100;

/** 配置注水等待上限：超时放弃本次修复（宁缺毋滥——用默认档误当原档会翻错
    用户主题；下次冷启重试，不计失败）。 */
const E2E_REPAIR_HYDRATION_TIMEOUT_MS = 1500;

/** 修复守卫持久化结构（跨上下文/跨冷启续跑的唯一记账载体）：
    phase=下一步动作（flip=开新一轮：翻一入对档 / restore=归位 + 轮询自证）；
    originalPref=用户原档（用户竞态比对基准，'system' 合法——只做盘上比对，
    不做归位翻转目标）；originalResolved=修复起点解析出的**具体档**（翻转前
    采集，v3.1 归位翻转的唯一目标——'system' 的 FOLLOW_SYSTEM 重解析在钉过
    具体档的进程里不可靠，见段头注 v3.1 反转机理；null=v3 旧守卫且原档为
    'system'，读取时归一：具体档补 = originalPref，'system' 由调用方分流）；
    failedRuns=restore 判失败跨 boot 累计（每轮 +1，成功清零，3 次放弃）；
    rounds=当前 boot 内已进行的轮数（1..2；flip 态落盘时恒 1 = 下次冷启重开）。 */
type E2eRepairPhase = 'flip' | 'restore';

interface E2eRepairGuard {
    phase: E2eRepairPhase;
    originalPref: ThemePref;
    originalResolved: 'light' | 'dark' | null;
    failedRuns: number;
    rounds: number;
}

/** 每上下文一次守卫：本 JS 上下文已收口（含修复链内任何收口点）→ 同上下文的
    重挂全部短路；Activity 重建若产生新 JS 上下文（Expo Go 实测行为，v1 同
    上下文双翻被证伪的根因）则变量重置、由持久化守卫续跑——两种宿主模型
    通用。链内多步/多轮不置位本标记（仅收口置位），重挂竞态由各步幂等性 +
    守卫状态兜底。 */
let e2eStepRanInThisContext = false;

/** 最新一次渲染的 bottom inset / 生效主题（渲染期镜像，跨重挂存活的「最新
    快照」）：双采样检测、restore 轮询与各步判定统一读这里；树重挂后由新树
    渲染持续刷新。v3.1 附注：**新进程首个上下文**里该镜像 = 真实系统档
    （delegate 默认 FOLLOW_SYSTEM 且未钉具体档，Activity 配置即系统配置）——
    'system' 原档在 fresh detect 时解析归位基准正是读它（e2eStartRepairRound）。 */
let e2eLatestInsetsBottom: number | null = null;
let e2eLatestEffectiveTheme: 'light' | 'dark' = 'light';

/** 读修复守卫（存储层失败降级为 null：守卫缺失的后果只是多一次修复尝试，
    有 3 次上限兜底，不会死循环）。v2 旧守卫无 rounds 字段，读取时归一为 1
    （旧链按第 1 轮续跑，重试与放弃上限语义不受影响）。v3.1：旧守卫无
    originalResolved——具体档原档可直接补（= originalPref，语义同 v3）；
    'system' 原档在读取时无法确定（续跑上下文的生效档是翻转档），置 null 交
    调用方分流（fresh detect 用生效档解析 / restore 续跑放弃，见段头注 e）。 */
function e2eReadGuard(): Promise<E2eRepairGuard | null> {
    return AsyncStorage.getItem(E2E_REPAIR_GUARD_KEY)
        .then((raw) => {
            if (!raw) return null;
            const guard = JSON.parse(raw) as E2eRepairGuard;
            return {
                ...guard,
                rounds: typeof guard.rounds === 'number' ? guard.rounds : 1,
                originalResolved:
                    guard.originalResolved === 'light' || guard.originalResolved === 'dark'
                        ? guard.originalResolved
                        : guard.originalPref === 'system'
                          ? null
                          : guard.originalPref,
            };
        })
        .catch((e: unknown) => {
            console.warn('[theme] e2e repair guard read failed:', e);
            return null;
        });
}

/** 写修复守卫（fire-and-forget + 上报：计数丢失的后果同上，可自愈）。 */
function e2eWriteGuard(guard: E2eRepairGuard): void {
    AsyncStorage.setItem(E2E_REPAIR_GUARD_KEY, JSON.stringify(guard)).catch((e: unknown) => {
        console.warn('[theme] e2e repair guard write failed:', e);
    });
}

/** 清修复守卫（fire-and-forget + 上报；removeItem 对不存在的键为 no-op）。 */
function e2eClearGuard(): void {
    AsyncStorage.removeItem(E2E_REPAIR_GUARD_KEY).catch((e: unknown) => {
        console.warn('[theme] e2e repair guard clear failed:', e);
    });
}

/** 等 archiveConfig 注水完成（zustand persist 异步 getItem）：未注水时 get()
    返回默认档，会把用户原档认错。超时返回 false（放弃本次修复）。 */
function e2eWaitConfigHydrated(): Promise<boolean> {
    const persistApi = archiveConfig.use.persist;
    if (persistApi.hasHydrated()) return Promise.resolve(true);
    return new Promise((resolve) => {
        let unsub: () => void = () => {};
        const timer = setTimeout(() => {
            unsub();
            resolve(false);
        }, E2E_REPAIR_HYDRATION_TIMEOUT_MS);
        unsub = persistApi.onFinishHydration(() => {
            unsub();
            clearTimeout(timer);
            resolve(true);
        });
    });
}

/** 有界延时（async 步内的重试节奏；Promise 永不 reject，上下文随重建终止时
    其定时器随之销毁，悬挂的 await 由 GC 回收，无泄漏面）。 */
function e2eDelay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** restore 自证观察窗轮询（段头注②）：最长 E2E_REPAIR_RESTORE_POLL_WINDOW_MS
    内每 E2E_REPAIR_RESTORE_POLL_INTERVAL_MS 读一次渲染期镜像 bottom，任一 >0
    即成功；超时判失败。单点读数会被重建后的 insets 事件晚到误判（「实际
    已生效」读成 0），轮询窗消除该时序误判面。
    v3.1 第二判据（段头注 c）：传 expected 时还须渲染期生效主题镜像 === 归位
    目标才算成功——bottom>0 只证明 E2E 生效（翻转重建即可满足），镜像未到目标
    说明归位翻转的重建尚未落地，此刻收口会让 app 内容以对档渲染一拍再翻回。 */
function e2ePollBottomUntilPositive(expected?: 'light' | 'dark'): Promise<boolean> {
    return new Promise((resolve) => {
        const deadline = Date.now() + E2E_REPAIR_RESTORE_POLL_WINDOW_MS;
        const timer = setInterval(() => {
            if (
                (e2eLatestInsetsBottom ?? -1) > 0 &&
                (expected === undefined || e2eLatestEffectiveTheme === expected)
            ) {
                clearInterval(timer);
                resolve(true);
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(timer);
                resolve(false);
            }
        }, E2E_REPAIR_RESTORE_POLL_INTERVAL_MS);
    });
}

/** 健康收口（双采样任一拍 >0 / restore 轮询自证成功共用）：E2E 已生效 → 清
    守卫（含 failedRuns 清零重置，guardrail 1 的健康重置出口）并收口。不依赖
    配置注水（不动配置域）。 */
function e2eConcludeHealthy(): void {
    e2eClearGuard();
    e2eConcludeBoot();
}

/** 开轮动作（无守卫或 phase='flip'，双采样两拍全 0 后进入）：解析归位基准
    （具体档）→ 落盘 restore 守卫并翻一入对档（真实 uiMode 变化触发 Activity
    重建），重建后的新上下文由 restore 步续跑；本上下文不收口（boot 页继续盖住
    重建）。若挂载时生效档已不在归位基准档（kill 残留 / 跨版本守卫残留），翻一
    会成同值 no-op 使链卡死——此时跳过翻一，直接走 restore 步归位 + 轮询。 */
async function e2eStartRepairRound(guard: E2eRepairGuard | null): Promise<void> {
    const originalPref = guard?.originalPref ?? (archiveConfig.get()['ui.theme'] as ThemePref);
    const failedRuns = guard?.failedRuns ?? 0;
    // v3.1 归位基准解析（段头注 a/b）：归位与 shortcut 比较一律用**具体档**，
    // 不再用 originalPref 本身（'system' 不能做翻转/归位目标——FOLLOW_SYSTEM
    // 重解析在钉过具体档的进程里不可靠，反转根因）。解析口径：
    // - 守卫已带 originalResolved（本版本写入）→ 直接用（跨上下文恒定）；
    // - fresh detect（无守卫或 v3 flip 残留）且原档 'system'：新进程 delegate
    //   默认 FOLLOW_SYSTEM、未钉任何具体档，当前生效档 = 真实系统档，即基准；
    // - 具体档原档：基准 = originalPref 本身（与 v3 行为一致）。
    const resolvedOriginal: 'light' | 'dark' =
        guard?.originalResolved ?? (originalPref === 'system' ? e2eLatestEffectiveTheme : originalPref);
    if (e2eLatestEffectiveTheme !== resolvedOriginal) {
        // 对档已在位：视为翻一已完成，直接归位 + 轮询自证（rounds 从 1 记起）
        const resumed: E2eRepairGuard & { originalResolved: 'light' | 'dark' } = {
            phase: 'restore',
            originalPref,
            originalResolved: resolvedOriginal,
            failedRuns,
            rounds: 1,
        };
        e2eWriteGuard(resumed);
        await e2eRestoreAndJudge(resumed);
        return;
    }
    e2eWriteGuard({
        phase: 'restore',
        originalPref,
        originalResolved: resolvedOriginal,
        failedRuns,
        rounds: 1,
    });
    try {
        // 翻一：真实 uiMode 变化 → Activity 重建（E2E 生效点）。不落盘
        // 'ui.theme'（持久化终态核对见段头注）。双采样已等待 1000ms，布局与
        // insets 沉淀充分，直接翻转（步延时语义已由 T1/T2 承担）。
        applyThemePref(e2eLatestEffectiveTheme === 'dark' ? 'light' : 'dark');
    } catch (e) {
        console.warn('[theme] e2e repair flip failed:', e);
        e2eClearGuard();
        e2eConcludeBoot();
        return;
    }
    // 不收口：翻一的重建/重挂后由 restore 步续跑（boot 页全程盖住）。
}

/** restore 步（phase='restore'：翻一重建后的续跑上下文）：归位到守卫落盘的
    具体档（生效档已在目标档则免翻转，直接进入自证）→ 观察窗轮询 → 成功清守卫
    收口；判失败计败 +1 后分流：同 boot 重试一轮（rounds<2，重新翻一，boot 页
    继续盖住）/ 两轮用尽计败收口放弃本 boot（下次冷启重试）/ 累计达 3 次守卫
    保留短路放弃（段头注③④）。翻转触发的重建若先于轮询落地，本上下文随重建
    终止，由新上下文的 restore 步重新自证（无双判面）。 */
async function e2eRestoreAndJudge(guard: E2eRepairGuard & { originalResolved: 'light' | 'dark' }): Promise<void> {
    // 用户竞态守卫：盘上主题被用户改过（≠ 修复起点原档）→ 中止尊重用户
    // （比对用 originalPref——'system' 合法，这里只核对用户意图未被改写）
    const diskPref = archiveConfig.get()['ui.theme'] as ThemePref;
    if (diskPref !== guard.originalPref) {
        e2eClearGuard();
        e2eConcludeBoot();
        return;
    }
    // v3.1 翻二：归位目标 = originalResolved（具体档，守卫落盘的修复起点解析
    // 值），不再用 originalPref——具体档的 setDefaultNightMode(MODE_NIGHT_*)
    // 无任何配置重解析歧义，生效档未到位时必是真实 uiMode 变化 → Activity 重建
    // （v3 用 'system' 归位在钉过具体档的进程里是静默 no-op = 反转根因，段头注）。
    if (e2eLatestEffectiveTheme !== guard.originalResolved) {
        try {
            applyThemePref(guard.originalResolved);
        } catch (e) {
            console.warn('[theme] e2e repair restore failed:', e);
            e2eConcludeBoot();
            return;
        }
    }
    // 观察窗轮询自证（bottom>0 且镜像已到归位目标，段头注 c）：同时覆盖「翻转
    // 未触发重建」时本上下文继续存活的兜底面——无重建则配置变更事件会刷新镜像，
    // 就地出判定，不依赖重建续跑。
    const restored = await e2ePollBottomUntilPositive(guard.originalResolved);
    if (restored) {
        // v3.1 跟随系统重臂（段头注 d，仅原档 'system'）：链内两次具体档翻转把
        // AppCompatDelegate 钉在具体档上，交还 FOLLOW_SYSTEM 恢复运行中系统深浅
        // 的实时跟随。此刻镜像已证 === 归位目标，重解析无翻转歧义（系统深浅在
        // 修复期间被改的场景会重解析到新值 → 重建跟随新值 = 正确跟随语义）。
        if (guard.originalPref === 'system') {
            try {
                applyThemePref('system');
            } catch (e) {
                console.warn('[theme] e2e repair rearm follow-system failed:', e);
            }
        }
        e2eConcludeHealthy();
        return;
    }
    // 判失败：计败 +1（每轮 restore 判失败 +1，跨 boot 累计，段头注④）
    const failedRuns = guard.failedRuns + 1;
    if (failedRuns >= E2E_REPAIR_MAX_FAILED_RUNS) {
        // 累计 3 次 → 放弃自动修复：守卫以 flip 态保留，后续冷启在检测步
        // 持续短路，出口转人工/dev build。
        console.warn(
            '[theme] e2e auto repair given up after',
            failedRuns,
            'failed restore rounds; fix manually via Me page theme switch or switch to a dev build',
        );
        e2eWriteGuard({
            phase: 'flip',
            originalPref: guard.originalPref,
            originalResolved: guard.originalResolved,
            failedRuns,
            rounds: 1,
        });
        e2eConcludeBoot();
        return;
    }
    if (guard.rounds < E2E_REPAIR_MAX_ROUNDS_PER_BOOT) {
        // 同 boot 重试：重开一轮 flip→restore（至多 2 轮，段头注③），重试
        // 全程 boot 页盖住（本路径不收口，重建后由新上下文续跑）。
        e2eWriteGuard({
            phase: 'restore',
            originalPref: guard.originalPref,
            originalResolved: guard.originalResolved,
            failedRuns,
            rounds: guard.rounds + 1,
        });
        await e2eDelay(E2E_REPAIR_STEP_DELAY_MS);
        try {
            // 翻一（第 2 轮）：此刻生效档已被上一轮翻二归位，翻走即真实变化
            applyThemePref(e2eLatestEffectiveTheme === 'dark' ? 'light' : 'dark');
        } catch (e) {
            console.warn('[theme] e2e repair retry flip failed:', e);
            e2eConcludeBoot();
            return;
        }
        // 不收口：重建后由 restore 步续跑第 2 轮自证。
        return;
    }
    // 本 boot 两轮仍非 E2E：计败收口，落 flip 守卫供下次冷启重试（下次冷启
    // 检测步两拍全 0 时按 failedRuns 续计，达 3 次转放弃）。
    console.warn(
        '[theme] e2e repair still non-e2e after',
        guard.rounds,
        'rounds this boot; will retry next cold start (failedRuns=',
        failedRuns,
        ')',
    );
    e2eWriteGuard({
        phase: 'flip',
        originalPref: guard.originalPref,
        originalResolved: guard.originalResolved,
        failedRuns,
        rounds: 1,
    });
    e2eConcludeBoot();
}

/** 状态机单步执行体（挂载期守卫分派后的延时回调；async 内全部 await 有界：
    注水 ≤1.5s / 轮询 ≤1.5s / 步延时 400ms，任一环卡死由 boot 强制收口兜底）。
    kind='detect'：双采样两拍全 0 → 判定非 E2E，开修复轮；kind='restore'：
    翻一重建后的续跑上下文 → 归位 + 轮询自证 + 失败分流。 */
async function e2eRunStep(guard: E2eRepairGuard | null, kind: 'detect' | 'restore'): Promise<void> {
    // 配置注水守卫：拿不到可靠原档就不动（见常量注）
    if (!(await e2eWaitConfigHydrated())) {
        console.warn('[theme] e2e repair skipped: archive config not hydrated in time');
        e2eConcludeBoot();
        return;
    }
    if (kind === 'restore') {
        // 续跑步（挂载期已按守卫分派）：守卫缺失属存储层降级，保守收口
        if (!guard) {
            e2eConcludeBoot();
            return;
        }
        // v3.1（段头注 e）：null originalResolved ⟺ v3 残留守卫且原档 'system'
        // （具体档原档在 e2eReadGuard 读取时已归一为具体档非 null）。此类残留在
        // 续跑上下文无法可靠归位——此刻生效档是翻转档，JS 侧无真实系统档读取
        // 通道（Appearance 读 Activity 配置 = 被钉住的翻转档）→ 放弃本次（清守
        // 卫收口；下次冷启新进程生效档 = 真实系统档，重新检测拿正确基准）。
        const { originalResolved } = guard;
        if (originalResolved === null) {
            e2eClearGuard();
            e2eConcludeBoot();
            return;
        }
        await e2eRestoreAndJudge({ ...guard, originalResolved });
        return;
    }
    // ---- 检测步（双采样两拍全 0 → Expo Go 冷启症状面）----
    if (guard && guard.failedRuns >= E2E_REPAIR_MAX_FAILED_RUNS) {
        // 累计 3 次 restore 判失败 → 放弃自动修复（守卫保留：后续冷启在此
        // 持续短路，出口转人工/dev build）。
        console.warn(
            '[theme] e2e auto repair given up after',
            guard.failedRuns,
            'failed restore rounds; fix manually via Me page theme switch or switch to a dev build',
        );
        e2eConcludeBoot();
        return;
    }
    if (guard) {
        // 用户竞态守卫：盘上主题被用户改过（≠ 修复起点原档）→ 中止尊重用户
        const diskPref = archiveConfig.get()['ui.theme'] as ThemePref;
        if (diskPref !== guard.originalPref) {
            e2eClearGuard();
            e2eConcludeBoot();
            return;
        }
    }
    await e2eStartRepairRound(guard);
}

/**
 * Android Expo Go 冷启 E2E 自动修复挂载点（仅 RootLayout 调用一次；web 不参与，
 * iOS 原生恒 E2E 无此症状）。渲染期把 insets/生效主题镜像进模块级快照；挂载后
 * 先读持久化守卫分派（AsyncStorage ~ms 级，远早于第一拍）：restore 态 = 翻一
 * 重建后的续跑上下文（跳过双采样——其 bottom 是链中间态，两拍口径不适用——
 * 步延时后直接归位 + 轮询自证）；flip/无守卫 = 双采样检测上下文（T1/T2 两拍，
 * 机理与 guardrail 全集见上方实现段头注）。同时驱动启动门控（boot gate，文件
 * 尾段）：arm 时装填 ~5.5s 强制收口兜底，双采样任一拍 >0 时健康收口放行 app
 * 内容。
 */
export function useAndroidE2eSelfRepair(): void {
    const insets = useSafeAreaInsets();
    const schemeApi = useColorScheme();
    // 渲染期镜像（与 _layout 的 insetsBottomRef.current 直写同法，幂等快照）
    e2eLatestInsetsBottom = insets.bottom;
    e2eLatestEffectiveTheme = schemeApi.colorScheme === 'dark' ? 'dark' : 'light';

    useEffect(() => {
        if (Platform.OS !== 'android') return;
        // 每上下文一次：本上下文已收口（含检测拍/链内任何收口点）→ 重挂全部
        // 短路；新上下文（Activity 重建重求值）由持久化守卫续跑——两种宿主
        // 模型通用。
        if (e2eStepRanInThisContext) return;
        // boot 门控兜底装填：状态机任一环卡死时 ~5.5s 强制放行（boot gate 段头注）
        e2eArmBootForceReady();
        let cancelled = false;
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        void e2eReadGuard().then((mountGuard) => {
            if (cancelled) return;
            if (mountGuard?.phase === 'restore') {
                // 续跑步（翻一重建后的新上下文）：步延时沉淀后直接归位 + 轮询
                timers.push(
                    setTimeout(() => {
                        if (e2eStepRanInThisContext) return;
                        void e2eRunStep(mountGuard, 'restore').catch((e: unknown) => {
                            console.warn('[theme] e2e repair step failed:', e);
                            e2eConcludeBoot();
                        });
                    }, E2E_REPAIR_STEP_DELAY_MS),
                );
                return;
            }
            // 双采样检测第一拍 T1（=步延时）：任一拍 >0 即健康收口（清守卫 +
            // 收口，健康冷启快路径不回退）；=0 不收口等第二拍——单拍瞬时值
            // 不再直接驱动「进入修复/判定健康」的任一方向（段头注①）。
            timers.push(
                setTimeout(() => {
                    if (e2eStepRanInThisContext) return;
                    if ((e2eLatestInsetsBottom ?? -1) > 0) e2eConcludeHealthy();
                }, E2E_REPAIR_STEP_DELAY_MS),
            );
            // 第二拍 T2：仍 0 才判定非 E2E 进入修复；>0 健康收口（insets 晚
            // 测量的健康设备在 ~1000ms 收口——宁晚收，不误翻）。
            timers.push(
                setTimeout(() => {
                    if (e2eStepRanInThisContext) return;
                    if ((e2eLatestInsetsBottom ?? -1) > 0) {
                        e2eConcludeHealthy();
                        return;
                    }
                    void e2eRunStep(mountGuard, 'detect').catch((e: unknown) => {
                        console.warn('[theme] e2e repair step failed:', e);
                        e2eConcludeBoot();
                    });
                }, E2E_REPAIR_DETECT_SECOND_SAMPLE_MS),
            );
        });
        return () => {
            cancelled = true;
            timers.forEach((timer) => clearTimeout(timer));
        };
    }, []);

    // boot 门控提前收口（E2E 健康快路径，口径不变）：bottom>0 且本上下文状态
    // 机已跑过 → 收口。状态机未跑前不得提前收口——flip 修复可能已随上一步
    // 重建生效，对档主题的新树测得 bottom>0 属预期，此时应由 restore 步归位
    // 主题后收口，app 内容不得在对档主题下抢跑进场（boot gate 段头注）。与
    // 双采样检测无交集：e2eStepRanInThisContext 仅由 e2eConcludeBoot 置位，
    // 检测期内恒 false，本 effect 不会抢跑；收口后的重挂/重渲按原口径首帧
    // 收口（过渡页 1-2 帧，预期）。
    useEffect(() => {
        if (Platform.OS !== 'android') return;
        if (!e2eStepRanInThisContext) return;
        if (insets.bottom > 0) e2eConcludeBoot();
    }, [insets.bottom]);
}

// ---------------------------------------------------------------------------
// 启动门控（boot gate，2026-11-10 / v3 更新）：Android 自愈链收口前不放行 app
// 内容——过渡页（features/archive/ui/boot-screen.tsx）在 bootReady=false 期间
// 替代 Stack 渲染，状态机两步翻转与同 boot 重试轮的 Activity 重建全部被盖在
// 启动页之下（用户诉求：「没真正进入 app 首页之前完成，黑色主题在黑色页面
// 加载，白色的在白色」）。
//
// 收口口径（e2eConcludeBoot 幂等，多路同时到达以先到者为准，后到为 no-op）：
// - web/iOS：store 初值即 true（不渲染过渡页，直接进 app）；
// - Android「无需修复」双采样快路径（hook 挂载 effect，见上）：任一拍 >0 即
//   健康收口——T1 即 >0 的健康冷启在第一拍收口（过渡页 ~400ms，与 v2 持平）；
//   T1=0 而 T2>0（insets 晚测量）在第二拍收口（~1000ms，双采样为「进入修复」
//   设两拍一致门槛的代价，宁晚收不误翻）；
// - 同上下文重挂（本上下文已收口过）：early effect 首帧收口，过渡页 1-2 帧，
//   预期口径（未改）；
// - 状态机各步的保守放弃（注水超时 / 用户竞态中止 / 翻转抛错 / 累计 3 次放弃
//   / 两轮仍非 E2E 计败收口 / step 抛错）：当拍收口；
// - 修复链完整走完：restore 轮询（bottom>0 且镜像已到归位目标档，v3.1）成功
//   收口——boot 页全程盖住两步重建与同 boot 重试轮（链内任何一步都不提前
//   收口；镜像未到的重建窗口由新上下文按同守卫续跑，不放行对档首屏）；
// - 兜底：每上下文挂载起最长 ~5.5s 强制收口（Activity 重建的新上下文会重新
//   装填，该上界是单上下文粒度；全链总时长由「至多 2 轮」界定，最坏 ~7s 量级，
//   仅出现在修复连续失败的病态面）。
//
// 载体：zustand 单布尔 store，模块级创建 = 与状态机同寿（Activity 重建在新
// 上下文模型下重置模块变量，持久化守卫负责跨上下文续跑；同上下文重挂读到
// 同一份门控状态，不重新计时、不闪回开场动画——动画只播一次的口径在
// boot-screen.tsx）。
// ---------------------------------------------------------------------------

/** boot 门控强制收口时限（挂载起算；见段头注兜底口径）。 */
const BOOT_READY_FORCE_TIMEOUT_MS = 5500;

interface BootGateState {
    /** true = 启动收口，_layout 放行既有内容（Stack）；false = 过渡页顶上。 */
    bootReady: boolean;
}

/** 轻量订阅 store（模块级创建，跨重建存活；单布尔，翻转时才触发订阅重渲）。 */
const useBootGateStore = create<BootGateState>()(() => ({
    bootReady: Platform.OS !== 'android',
}));

/** 订阅启动门控（_layout 渲染门控用）。 */
export function useBootReady(): boolean {
    return useBootGateStore((state) => state.bootReady);
}

/** boot 强制收口定时器（模块级，挂载时装填；自然收口即拆弹）。 */
let e2eBootForceTimer: ReturnType<typeof setTimeout> | null = null;

/** 启动收口（幂等）：本上下文记一步已执行、拆兜底定时器、置 ready。 */
function e2eConcludeBoot(): void {
    e2eStepRanInThisContext = true;
    if (e2eBootForceTimer !== null) {
        clearTimeout(e2eBootForceTimer);
        e2eBootForceTimer = null;
    }
    useBootGateStore.setState({ bootReady: true });
}

/** 装填兜底定时器（arm 时一次；修复链卡死时的强制放行点，见段头注）。 */
function e2eArmBootForceReady(): void {
    if (e2eBootForceTimer !== null) return;
    e2eBootForceTimer = setTimeout(() => {
        e2eBootForceTimer = null;
        console.warn('[theme] boot gate force-ready after', BOOT_READY_FORCE_TIMEOUT_MS, 'ms');
        e2eConcludeBoot();
    }, BOOT_READY_FORCE_TIMEOUT_MS);
}
