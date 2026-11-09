import { useCallback, useEffect } from 'react';
import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';
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

/** 非 CSS 场景的语义色（值与 tailwind.config.js 的 ink/inkd 严格成对）。 */
export interface Palette {
    /** 数据强调（进度/进行中/连续天数）；禁上 chrome。 */
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
};

export function getPalette(theme: 'light' | 'dark'): Palette {
    return theme === 'dark' ? DARK : LIGHT;
}

/** 当前生效主题下的语义色（组件里取 icon color / 原生 props 用）。 */
export function usePalette(): Palette {
    return getPalette(useEffectiveTheme());
}

export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
    const pref = archiveConfig.use((state) => state['ui.theme']) as ThemePref;
    const setPref = useCallback((next: ThemePref) => {
        archiveConfig.update({ 'ui.theme': next });
        applyThemePref(next);
    }, []);
    return [pref, setPref];
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
// Android Expo Go 冷启 E2E 自动修复 v2（持久化守卫驱动的跨上下文状态机，
// 2026-11-09）。
//
// 【问题】Expo Go 58 未捆绑 react-native-edge-to-edge 原生模块（机理见上方
// reapplyAndroidEdgeToEdge 注），冷启窗口非 E2E（decorFitsSystemWindows=true，
// 内容止步导航栏上方）。检测口径（用户实证）：Android 上首帧稳定后读
// useSafeAreaInsets().bottom——E2E 时三键/手势导航的 bottom inset 必 >0，
// 非 E2E（insets 被窗口布局消费）恒 =0。
//
// 【v1 教训 → v2 架构】v1「同上下文双翻」被真机证伪：Expo Go 的
// ExperienceActivity 重建是**新 JS 上下文**（bundle 重新求值），v1 的翻二
// 定时器随翻一的上下文死亡而丢失（主题滞留对档），且重建与模块求值竞态
// 触发 `Cannot find native module 'ExpoCrypto'` 崩溃循环。v2 把每一步落盘
// 为持久化守卫状态（AsyncStorage），每次挂载（无论同上下文重挂还是新上下文
// 重求值）都从守卫状态续跑恰好一步：
//   无守卫 + bottom===0 → 落盘 {phase:'flip'} → 翻对档（触发重建）；
//   phase='flip'        → 翻二 applyThemePref(原档)（归位）→ 落盘 'restore'；
//   phase='restore'     → bottom>0 成功清守卫收口；仍 0 计败重试（3 次放弃）。
// 每个上下文至多执行一步（e2eStepRanInThisContext），步间推进靠重建/重挂。
//
// 【guardrail】1. 失败计数落盘 + 3 次放弃（守卫保留使后续冷启持续短路，出口
// 转人工/dev build；E2E 健康冷启自动清零重置）；2. 双翻窗口用户竞态：盘上
// 'ui.theme' 被用户改过 → 中止尊重用户；3. 注水超时不动（宁缺毋滥）；4.
// 误判面：全屏隐藏导航栏设备（E2E 但 bottom=0）→ 走一轮翻转后原档归位，
// 可接受；insets null 保守不动。
// ---------------------------------------------------------------------------

/** 修复守卫持久化键（AsyncStorage 直连：archive.config 是用户配置域文档，
    修复状态属运行时自愈流程，混入会污染配置语义）。 */
const E2E_REPAIR_GUARD_KEY = 'archive.e2e-repair-guard';

/** 连续失败上限：第 3 次冷启修复仍非 E2E 后放弃（防死循环骚扰，出口转人工）。 */
const E2E_REPAIR_MAX_FAILED_RUNS = 3;

/** 每步动作前的稳定等待（挂载/重建后的布局与 insets 沉淀）。 */
const E2E_REPAIR_STEP_DELAY_MS = 400;

/** restore 步自证观察窗（等待重建后的 insets 事件重渲刷新镜像）。 */
const E2E_REPAIR_SETTLE_DELAY_MS = 600;

/** 配置注水等待上限：超时放弃本次修复（宁缺毋滥——用默认档误当原档会翻错
    用户主题；下次冷启重试，不计失败）。 */
const E2E_REPAIR_HYDRATION_TIMEOUT_MS = 1500;

/** 修复守卫持久化结构：phase=下一步动作（flip=翻对档触发重建 / restore=归位
    用户原档）；originalPref=用户原档（restore 目标 + 用户竞态比对基准）；
    failedRuns=连续失败冷启数（restore 失败 +1，成功或放弃清零，3 次放弃）。 */
type E2eRepairPhase = 'flip' | 'restore';

interface E2eRepairGuard {
    phase: E2eRepairPhase;
    originalPref: ThemePref;
    failedRuns: number;
}

/** 每上下文一步守卫：本 JS 上下文已执行过步骤（含收口）→ 同上下文的重挂全部
    短路；Activity 重建若产生新 JS 上下文（Expo Go 实测行为，v1 同上下文双翻
    被证伪的根因）则变量重置、由持久化守卫续跑下一步——两种宿主模型通用。 */
let e2eStepRanInThisContext = false;

/** 最新一次渲染的 bottom inset / 生效主题（渲染期镜像，跨重挂存活的「最新
    快照」）：restore 自证与各步判定读这里；树重挂后由新树渲染持续刷新。 */
let e2eLatestInsetsBottom: number | null = null;
let e2eLatestEffectiveTheme: 'light' | 'dark' = 'light';

/** 读修复守卫（存储层失败降级为 null：守卫缺失的后果只是多一次修复尝试，
    有 3 次上限兜底，不会死循环）。 */
function e2eReadGuard(): Promise<E2eRepairGuard | null> {
    return AsyncStorage.getItem(E2E_REPAIR_GUARD_KEY)
        .then((raw) => (raw ? (JSON.parse(raw) as E2eRepairGuard) : null))
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

/** 状态机单步执行体（挂载/重建后的稳定延时回调；async 内全部 await 有界）。
    每次执行恰好推进一步，步间靠 Activity 重建/重挂回到本函数
    （e2eStepRanInThisContext 在收口处置位，防同上下文重复执行）。 */
async function e2eRunStep(insetsBottom: number): Promise<void> {
    // 配置注水守卫：拿不到可靠原档就不动（见常量注）
    if (!(await e2eWaitConfigHydrated())) {
        console.warn('[theme] e2e repair skipped: archive config not hydrated in time');
        e2eConcludeBoot();
        return;
    }
    const diskPref = archiveConfig.get()['ui.theme'] as ThemePref;
    const guard = await e2eReadGuard();

    // 健康快路径（含守卫存在时的重置出口）：E2E 已生效 → 清历史计数并收口
    if (insetsBottom > 0) {
        if (guard) {
            AsyncStorage.removeItem(E2E_REPAIR_GUARD_KEY).catch((e: unknown) => {
                console.warn('[theme] e2e repair guard clear failed:', e);
            });
        }
        e2eConcludeBoot();
        return;
    }

    // ---- bottom === 0：判定非 E2E（Expo Go 冷启症状面）----
    if (guard && guard.failedRuns >= E2E_REPAIR_MAX_FAILED_RUNS) {
        // 连续 3 次冷启修复后仍非 E2E → 放弃自动修复（守卫保留：后续冷启在此
        // 持续短路，出口转人工/dev build）。
        console.warn(
            '[theme] e2e auto repair given up after',
            guard.failedRuns,
            'failed cold starts; fix manually via Me page theme switch or switch to a dev build',
        );
        e2eConcludeBoot();
        return;
    }

    if (guard) {
        // 用户竞态守卫：盘上主题被用户改过（≠ 修复起点原档）→ 中止尊重用户
        if (diskPref !== guard.originalPref) {
            AsyncStorage.removeItem(E2E_REPAIR_GUARD_KEY).catch((e: unknown) => {
                console.warn('[theme] e2e repair guard clear failed:', e);
            });
            e2eConcludeBoot();
            return;
        }
        if (guard.phase === 'flip') {
            // 步骤 B：翻一（对档）已触发重建——本步归位用户原档 → 重建后由
            // 'restore' 步收口。不收口即返回（boot 页继续盖住归位重建）。
            e2eWriteGuard({ phase: 'restore', originalPref: guard.originalPref, failedRuns: guard.failedRuns });
            setTimeout(() => {
                try {
                    applyThemePref(guard.originalPref);
                } catch (e) {
                    console.warn('[theme] e2e repair restore failed:', e);
                    e2eConcludeBoot();
                }
            }, E2E_REPAIR_STEP_DELAY_MS);
            return;
        }
        // 步骤收口（phase='restore'）：restore 重建后仍 bottom===0 → 本次尝试
        // 失败计败 +1；达到上限转人工，否则下次冷启以 'flip' 重试整轮。
        const failedRuns = guard.failedRuns + 1;
        AsyncStorage.removeItem(E2E_REPAIR_GUARD_KEY).catch((e: unknown) => {
            console.warn('[theme] e2e repair guard clear failed:', e);
        });
        if (failedRuns >= E2E_REPAIR_MAX_FAILED_RUNS) {
            console.warn(
                '[theme] e2e auto repair given up after',
                failedRuns,
                'failed cold starts; fix manually via Me page theme switch or switch to a dev build',
            );
            e2eConcludeBoot();
            return;
        }
        e2eWriteGuard({ phase: 'flip', originalPref: guard.originalPref, failedRuns });
        e2eConcludeBoot();
        return;
    }

    // ---- 无守卫 + bottom===0：启动修复步骤 A ----
    e2eWriteGuard({ phase: 'flip', originalPref: diskPref, failedRuns: 1 });
    setTimeout(() => {
        try {
            // 翻一：真实 uiMode 变化 → Activity 重建（E2E 生效点）。不落盘
            // 'ui.theme'（持久化终态核对见段头注）。
            applyThemePref(e2eLatestEffectiveTheme === 'dark' ? 'light' : 'dark');
        } catch (e) {
            console.warn('[theme] e2e repair flip failed:', e);
            AsyncStorage.removeItem(E2E_REPAIR_GUARD_KEY).catch((e2: unknown) => {
                console.warn('[theme] e2e repair guard clear failed:', e2);
            });
            e2eConcludeBoot();
        }
    }, E2E_REPAIR_STEP_DELAY_MS);
    // 不收口：flip 的重建/重挂后由 'flip' 分支续跑归位（boot 页全程盖住）。
}

/**
 * Android Expo Go 冷启 E2E 自动修复挂载点（仅 RootLayout 调用一次；web 不参与，
 * iOS 原生恒 E2E 无此症状）。渲染期把 insets/生效主题镜像进模块级快照，挂载后
 * 稳定延时执行状态机单步（持久化守卫驱动，跨上下文/重挂续跑，机理与 guardrail
 * 全集见上方实现段头注）。同时驱动启动门控（boot gate，文件尾段）：arm 时装填
 * ~5.5s 强制收口兜底，E2E 健康（bottom>0）时提前收口放行 app 内容。
 */
export function useAndroidE2eSelfRepair(): void {
    const insets = useSafeAreaInsets();
    const schemeApi = useColorScheme();
    // 渲染期镜像（与 _layout 的 insetsBottomRef.current 直写同法，幂等快照）
    e2eLatestInsetsBottom = insets.bottom;
    e2eLatestEffectiveTheme = schemeApi.colorScheme === 'dark' ? 'dark' : 'light';

    useEffect(() => {
        if (Platform.OS !== 'android') return;
        // 每上下文一步：本上下文已执行（含收口）→ 短路；新上下文（Activity
        // 重建重求值）由持久化守卫续跑下一步——两种宿主模型通用。
        if (e2eStepRanInThisContext) return;
        // boot 门控兜底装填：状态机任一环卡死时 ~5.5s 强制放行（boot gate 段头注）
        e2eArmBootForceReady();
        const timer = setTimeout(() => {
            void e2eRunStep(e2eLatestInsetsBottom ?? -1).catch((e: unknown) => {
                console.warn('[theme] e2e repair step failed:', e);
                e2eConcludeBoot();
            });
        }, E2E_REPAIR_STEP_DELAY_MS);
        return () => clearTimeout(timer);
    }, []);

    // boot 门控提前收口（E2E 健康快路径）：bottom>0 且本上下文状态机已跑过 →
    // 收口。状态机未跑前不得提前收口——flip 修复可能已随上一步重建生效，对档
    // 主题的新树测得 bottom>0 属预期，此时应由 'restore' 步归位主题后收口，
    // app 内容不得在对档主题下抢跑进场（boot gate 段头注）。
    useEffect(() => {
        if (Platform.OS !== 'android') return;
        if (!e2eStepRanInThisContext) return;
        if (insets.bottom > 0) e2eConcludeBoot();
    }, [insets.bottom]);
}

// ---------------------------------------------------------------------------
// 启动门控（boot gate，2026-11-09 / v2 更新）：Android 自愈链收口前不放行 app
// 内容——过渡页（features/archive/ui/boot-screen.tsx）在 bootReady=false 期间
// 替代 Stack 渲染，状态机两步翻转的 Activity 重建全部被盖在启动页之下（用户
// 诉求：「没真正进入 app 首页之前完成，黑色主题在黑色页面加载，白色的在白色」）。
//
// 收口口径（e2eConcludeBoot 幂等，多路同时到达以先到者为准，后到为 no-op）：
// - web/iOS：store 初值即 true（不渲染过渡页，直接进 app）；
// - Android「无需修复」快路径：渲染期镜像 bottom>0 即 E2E 健康 → 提前收口
//   （hook 内 effect，见上；状态机未跑过前抑制——flip 步生效后的 bottom>0 属
//   预期中间态，须等 restore 归位）；
// - 状态机各步的保守放弃（insets 未测得 / 3 次失败放弃 / 用户竞态中止 /
//   注水超时 / 翻转抛错 / restore 后仍非 E2E 计败 / step 抛错）：当拍收口；
// - 修复链完整走完：restore 后 bottom>0 成功收口——boot 页全程盖住两步重建；
// - 兜底：挂载起最长 ~5.5s 强制收口（状态机任一环卡死不困在启动页）。上界取
//   v2 链最坏 400+1500+400+400+600≈3300ms 加两次重建与多拍余量。
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
