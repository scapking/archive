import { useCallback } from 'react';
import { Platform, TurboModuleRegistry, type TurboModule } from 'react-native';
import { colorScheme, useColorScheme } from 'nativewind';
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
// Android edge-to-edge 冷启自愈（2026-11-09 真机症状：冷启内容止步于导航栏上方，
// 去 Me 点一次主题切换后才恢复）。
//
// 机理（全部 file:line 见下）：Me 切换链最终 native 生效点 =
// react-native-edge-to-edge 插件的 EdgeToEdgeModuleImpl.applyEdgeToEdge
// （setDecorFitsSystemWindows(false) + 透明系统栏 + cutout mode，
// EdgeToEdgeModuleImpl.kt:64-117）。Android <15 冷启时该函数只能由插件模块
// onHostResume 派发（newarch EdgeToEdgeModule.kt:23-25）——RN 核心的
// updateEdgeToEdgeFeatureFlag 仅 Android 15+ 置位 enableEdgeToEdge
// （views/view/WindowUtil.kt:45-63），<15 全押插件派发时序，错过即无 E2E；
// 而切主题时 uiMode 变化触发 Activity 重建（AppearanceModule.kt:85-95 →
// AppCompatDelegate.setDefaultNightMode → applyDayNight → recreate），重建后
// onHostResume 重新派发，E2E 恢复——这正是「切一下主题就好了」的全部原因。
//
// 本函数 = 「不切主题的等价调用」（模拟可行性判定结论 a）：RNEdgeToEdge
// TurboModule 暴露的 onColorSchemeChange() 的原生实现就是 applyEdgeToEdge
// （newarch EdgeToEdgeModule.kt:31-33；插件 JS spec 在 Appearance 变化时也是调
// 它，specs/NativeEdgeToEdgeModule.ts:17-21）——幂等重设全部窗口 flag，不切
// 主题、不触发 Activity 重建、无闪屏。已排除「模拟切换」路线（结论 b 不成立）：
// androidx AppCompatDelegate.setDefaultNightMode 同值调用是 no-op
// （AppCompatDelegate.java：`if (sDefaultNightMode == mode) return;`），
// 同值双翻翻不动，只能真翻反再翻回（两次 Activity 重建闪屏），劣于直调。
//
// 用 TurboModuleRegistry.get（可能 null）而非 getEnforcing：模块未注册（未来
// 版本改名/移除/平台差异）时静默降级，不影响启动；失败也只 console.warn——
// 自愈是增强不是关键路径。
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
