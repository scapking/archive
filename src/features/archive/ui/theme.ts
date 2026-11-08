import { useCallback } from 'react';
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

/** 生效主题的命令式读取（非渲染期用，即时快照不订阅）：与 useEffectiveTheme
    严格同源——hook 返回的 colorScheme 就是同一 colorScheme observable 的
    get(effect)，这里不带订阅 effect 读当下值，两读法恒一致。供定时器/事件
    回调里的补刷调用：触发瞬间重读，不受渲染闭包冻结影响（'system' 档冷启
    早期 Appearance 初始化可能先报 light 后报 dark，每读一次都是当时最新
    解析值；undefined 只出现在 web 未初始化窗口，与 hook 同样兜底为 light）。 */
export function getEffectiveTheme(): 'light' | 'dark' {
    return colorScheme.get() === 'dark' ? 'dark' : 'light';
}
