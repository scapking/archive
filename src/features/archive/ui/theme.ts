import { useCallback, useEffect } from 'react';
import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { colorScheme, useColorScheme } from 'nativewind';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
// Android Expo Go 冷启 E2E 自动修复（主题双翻重建，2026-11-09）。
//
// 【问题】Expo Go 58 未捆绑 react-native-edge-to-edge 原生模块（机理见上方
// reapplyAndroidEdgeToEdge 注），冷启窗口非 E2E（decorFitsSystemWindows=true，
// 内容止步导航栏上方）。检测口径（用户实证）：Android 上首帧稳定后（挂载
// ~700ms，insets 稳定窗口）读 useSafeAreaInsets().bottom——E2E 时三键/手势
// 导航的 bottom inset 必 >0，非 E2E（insets 被窗口布局消费）恒 =0。
//
// 【修复 = 双翻】翻一 applyThemePref(对档) → ~350ms（重建完成后的下一拍）翻二
// applyThemePref(原档)。两次真实 uiMode 变化 = 两次 Activity 重建，E2E 随重建
// 链路生效，最终主题与用户设置一致。对档按当前【生效】主题取反而非按档位表：
// 'system' 档或同值翻转会被 AppCompatDelegate.setDefaultNightMode 同值 no-op
// 掉（不重建=修复失效），只有生效值真实翻转才有重建。
// reduceMotion 无关：重建是 Activity recreate，非动画。
//
// 【持久化终态核对】全程只动内存 colorScheme、不写 'ui.theme'。落盘链路收口
// 在 Me 页 setPref 的 archiveConfig.update（core/config-store createConfigStore：
// zustand persist → AsyncStorage 'archive.config' 单文档整体重写，write-through
// 于每次 setState）；applyThemePref 本就不落盘，双翻沿用 → 盘上 'ui.theme'
// 恒为用户原档，中途被杀也只漂移内存态，冷启挂载 effect（app/_layout.tsx）
// 按盘上原档重放自愈。唯一的例外盘写是下方修复守卫计数（独立键，非配置域）。
//
// 【guardrail（防循环/防误触发）】
// 1. 每次冷启至多一次：模块级相位机 idle→armed→closed。JS 上下文生命周期是
//    关键——Activity 重建=整树重挂但 JS 上下文不重启，模块变量跨重挂保留
//    （组件 ref/useRef 会随旧树销毁，用 ref 必然在重建后重入翻车）。另落盘
//    会话 token（模块求值时生成，每个 JS 上下文唯一）作双保险：相位被极端
//    路径（dev Fast Refresh 重求值）重置时，token 不匹配再拦一道。
// 2. 双翻窗口用户竞态：翻二前核对盘上 'ui.theme' 是否仍为翻一前快照——本
//    机制不写盘，盘值变化只可能来自用户 setPref → 取消翻二，尊重用户操作
//    不再翻回（用户已自行 apply 新档，无需代劳）。
// 3. insets 抖动不重触发（键盘/旋转）：700ms 单次判定，判完即 closed，无
//    订阅、无第二次读取窗口。
// 4. 误判面：全屏隐藏导航栏的设备（E2E 但 bottom=0）→ 一次无感双翻，主题
//    回到原档，可接受；insets 未测得（null，极端慢启动）→ 保守不动。检测
//    若落在 SafeAreaProvider 首测前的 0 值窗口（<700ms 早于首帧）同属此面，
//    700ms 延迟即为压该窗口而设。
// 5. 防死循环：修复尝试乐观计败落盘（会话被杀也计入），自证（双翻后 ~700ms
//    读最新 bottom>0）成功即清零；连续 3 次冷启修复后仍非 E2E → 放弃自动
//    修复并 console 提示转人工（Me 页手动切一次主题，或换 dev build）。
//    E2E 恢复正常的冷启（人工修复后）会把计数自动清零——自愈出口闭环。
// ---------------------------------------------------------------------------

/** 修复守卫持久化键（AsyncStorage 直连：archive.config 是用户配置域文档，
    修复计数属运行时自愈状态，混入会污染配置语义；archiveConfig 定义文件也
    不在本次允许改动清单内）。 */
const E2E_REPAIR_GUARD_KEY = 'archive.e2e-repair-guard';

/** 连续失败上限：第 3 次冷启修复仍非 E2E 后放弃（防死循环骚扰，出口转人工）。 */
const E2E_REPAIR_MAX_FAILED_RUNS = 3;

/** 检测延迟：挂载后 ~700ms（首帧布局 + SafeAreaProvider 测量 + insets 稳定）。 */
const E2E_REPAIR_DETECT_DELAY_MS = 700;

/** 翻二延迟：翻一触发的 Activity 重建完成后的「下一拍」。 */
const E2E_REPAIR_RESTORE_DELAY_MS = 350;

/** 自证延迟：翻二（第二次重建）后再取一拍 insets 的观察窗口。 */
const E2E_REPAIR_VERIFY_DELAY_MS = 700;

/** 配置注水等待上限：超时放弃本次修复（宁缺毋滥——用默认档误当原档会翻错
    用户主题；下次冷启重试，不计失败）。 */
const E2E_REPAIR_HYDRATION_TIMEOUT_MS = 1500;

/** 会话 token：模块求值时生成 → 每个 JS 上下文（= 每次冷启）唯一；Activity
    重建只重挂 React 树不重启 JS 上下文，故同一冷启内（含双翻重建后）恒定。 */
const E2E_REPAIR_SESSION_TOKEN = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 修复守卫持久化结构：token=最近一次尝试所属会话；failedRuns=连续失败冷启数
    （乐观计败：翻一前 +1，自证成功或冷启观测到 E2E 正常时清零）。 */
interface E2eRepairGuard {
    token: string;
    failedRuns: number;
}

/** 相位机（模块级，跨整树重挂保留——防重入的正确载体，见 guardrail #1）：
    idle（冷启初值）→ armed（effect 首跑同步占位）→ closed（单次判定收口，
    后续重挂的 effect 全部短路）。 */
let e2eRepairPhase: 'idle' | 'armed' | 'closed' = 'idle';

/** 最新一次渲染的 bottom inset / 生效主题（渲染期镜像，跨重挂存活的「最新
    快照」）：翻二与自证拍跑在旧组件实例的模块级定时器里，组件 ref 已随旧树
    销毁，只能读这里；树若重挂，新树渲染会持续刷新该快照。 */
let e2eLatestInsetsBottom: number | null = null;
let e2eLatestEffectiveTheme: 'light' | 'dark' = 'light';

/** 双翻定时器（模块级而非 effect 局部）：翻一触发 Activity 重建会卸载旧树，
    effect cleanup 若清掉它们就永远翻不回来——刻意不受 cleanup 管理，仅在自然
    触发或竞态取消时清位。进程被杀则随之消失（盘上原档兜底，无残留态）。 */
let e2eRestoreTimer: ReturnType<typeof setTimeout> | null = null;
let e2eVerifyTimer: ReturnType<typeof setTimeout> | null = null;

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

/** 单次判定 + 双翻执行体（700ms 定时器回调；async 内全部 await 有界）。
    判定即收口：无论结果如何相位置 closed，会话内不再有第二次检测。 */
async function e2eRepairTick(): Promise<void> {
    e2eRepairPhase = 'closed';

    const bottom = e2eLatestInsetsBottom;
    // insets 未测得（SafeAreaProvider 尚无快照）→ 本会话保守放弃
    if (bottom == null) return;

    if (bottom > 0) {
        // 已 E2E（dev build / 已修复 / 人工修过）：清零历史失败计数（自愈出口）
        const healthy = await e2eReadGuard();
        if (healthy && healthy.failedRuns !== 0) {
            e2eWriteGuard({ token: E2E_REPAIR_SESSION_TOKEN, failedRuns: 0 });
        }
        return;
    }

    // ---- bottom === 0：判定非 E2E（Expo Go 冷启症状面）----
    const guard = await e2eReadGuard();
    if (guard && guard.failedRuns >= E2E_REPAIR_MAX_FAILED_RUNS) {
        // 连续 3 次冷启修复后仍非 E2E → 放弃自动修复（防死循环骚扰）。
        console.warn(
            '[theme] e2e auto repair given up after',
            guard.failedRuns,
            'failed cold starts; fix manually via Me page theme switch or switch to a dev build',
        );
        return;
    }
    if (guard && guard.token === E2E_REPAIR_SESSION_TOKEN) {
        // 双保险：本会话已跑过修复（相位被 Fast Refresh 重置等极端路径兜底）
        return;
    }

    // 配置注水守卫：拿不到可靠原档就不动（见常量注）
    if (!(await e2eWaitConfigHydrated())) {
        console.warn('[theme] e2e repair skipped: archive config not hydrated in time');
        return;
    }

    // 原档快照（盘值，非内存生效值）：竞态守卫的比对基准 + 翻二的恢复目标
    const originalPref = archiveConfig.get()['ui.theme'] as ThemePref;
    // 对档按生效主题取反（guardrail：保证真实 uiMode 变化，绕开同值 no-op）
    const opposite: ThemePref = e2eLatestEffectiveTheme === 'dark' ? 'light' : 'dark';

    // 乐观计败先行落盘：本会话若在自证前被杀，这次尝试也计入连续失败
    e2eWriteGuard({ token: E2E_REPAIR_SESSION_TOKEN, failedRuns: (guard?.failedRuns ?? 0) + 1 });

    // 翻一：真实 uiMode 变化 → Activity 重建（E2E 生效点）。不落盘（见持久化终态）。
    try {
        applyThemePref(opposite);
    } catch (e) {
        console.warn('[theme] e2e repair flip failed:', e);
        return;
    }

    e2eRestoreTimer = setTimeout(() => {
        e2eRestoreTimer = null;
        // 用户竞态守卫：双翻窗口内用户已改主题（只有 setPref 写盘）→ 取消翻二
        const currentPref = archiveConfig.get()['ui.theme'] as ThemePref;
        if (currentPref !== originalPref) return;
        // 翻二：恢复原档（'system' 档经 Appearance 'unspecified' 交还系统）。
        // 若旧树已随重建重挂且挂载 effect 先行恢复了原档，此处同值 no-op 无害。
        try {
            applyThemePref(originalPref);
        } catch (e) {
            console.warn('[theme] e2e repair restore failed:', e);
            return;
        }
        // 自证拍：读最新快照（重挂后的新树 / insets 事件驱动的重渲都会刷新它）
        e2eVerifyTimer = setTimeout(() => {
            e2eVerifyTimer = null;
            const after = e2eLatestInsetsBottom;
            if (after != null && after > 0) {
                e2eWriteGuard({ token: E2E_REPAIR_SESSION_TOKEN, failedRuns: 0 });
            }
            // 仍 ===0：保持乐观计败值，下次冷启再试，至 MAX 放弃
        }, E2E_REPAIR_VERIFY_DELAY_MS);
    }, E2E_REPAIR_RESTORE_DELAY_MS);
}

/**
 * Android Expo Go 冷启 E2E 自动修复挂载点（仅 RootLayout 调用一次；web 不参与，
 * iOS 原生恒 E2E 无此症状）。渲染期把 insets/生效主题镜像进模块级快照，
 * 挂载后 700ms 单次判定 bottom===0 → 主题双翻两次重建；机理与 guardrail
 * 全集见上方实现段头注。
 */
export function useAndroidE2eSelfRepair(): void {
    const insets = useSafeAreaInsets();
    const schemeApi = useColorScheme();
    // 渲染期镜像（与 _layout 的 insetsBottomRef.current 直写同法，幂等快照）
    e2eLatestInsetsBottom = insets.bottom;
    e2eLatestEffectiveTheme = schemeApi.colorScheme === 'dark' ? 'dark' : 'light';

    useEffect(() => {
        if (Platform.OS !== 'android') return;
        // 每次冷启至多一次：effect 首跑同步占位（idle→armed），此后因 Activity
        // 重建 / Fast Refresh 触发的重挂在此短路——重建=整树重挂但模块变量保留，
        // 相位机天然防重入（guardrail #1）。占位在 effect 期而非判定期，避免
        // await 注水窗口内重挂造成双定时器双判定。
        if (e2eRepairPhase !== 'idle') return;
        e2eRepairPhase = 'armed';
        const detectTimer = setTimeout(() => {
            void e2eRepairTick().catch((e: unknown) => {
                e2eRepairPhase = 'closed';
                console.warn('[theme] e2e repair tick failed:', e);
            });
        }, E2E_REPAIR_DETECT_DELAY_MS);
        return () => {
            // 只清未触发的检测定时器；双翻定时器刻意模块级存活（见其声明注）
            clearTimeout(detectTimer);
        };
    }, []);
}
