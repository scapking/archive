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
// 已排除路线（本轮+上轮，勿再试）：NavigationBar.setStyle（Q+ 上
// isContrastEnforced 读平台 attr 默认 true，setNavigationBarContrastEnforced
// 恒被打开，重开 scrim）；模拟主题切换（AppCompatDelegate.setDefaultNightMode
// 同值 no-op，双翻必闪屏）；SystemUI.setBackgroundColorAsync 三拍补刷（只改
// decorView 底色，不穿 contrast/布局语义）。Expo Go 环境若仍复现冷启症状，
// 出口只有 dev build（`npx expo prebuild --platform android` 本地构建或
// `eas build --profile development`），届时插件链与本函数同时生效。
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
