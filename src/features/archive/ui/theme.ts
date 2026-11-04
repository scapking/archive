import { useCallback } from 'react';
import { colorScheme, useColorScheme } from 'nativewind';
import { archiveConfig } from '@/config/archive';

/**
 * 主题偏好（灰白浅色 / 深色 / 跟随系统）：
 * 偏好持久在 archive.config（ui.theme），生效走 css-interop 的 colorScheme.set
 * （darkMode: 'class' 下合法）。set 只能在 effect / 事件回调里调（web 渲染期
 * 无 window 会抛错，见 css-interop color-scheme.js）；web 初始值恒为 'light'，
 * 「跟随系统」由启动时显式 set('system') 恢复。
 */
export type ThemePref = 'system' | 'light' | 'dark';

/** 品牌渐变蓝（浅/深两组端点）：只用于主行动（FAB/主按钮/品牌标记）。 */
export const ACCENT_GRADIENT: Record<'light' | 'dark', [string, string]> = {
    light: ['#2563EB', '#3B82F6'],
    dark: ['#2E6FD9', '#5B9DFF'],
};

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

/** 渐变端点（按当前生效主题取）。 */
export function useAccentGradient(): [string, string] {
    const theme = useEffectiveTheme();
    return ACCENT_GRADIENT[theme];
}
