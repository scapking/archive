import { Tabs } from 'expo-router';
import { View, useWindowDimensions } from 'react-native';
import { Sidebar, getPalette, useEffectiveTheme } from '@/features/archive';
// 深路径注记：web desktop 壳的断点常量与让位判定未在域 barrel 出口（ui/index.ts
// 无本轮改动权限），域内深取（editor-icons / close-button 先例）。
import { DESKTOP_BREAKPOINT, useIsDesktopShell } from '@/features/archive/ui/desktop-shell';
import { LucideBookOpen, LucideUser } from '@/core/icons';

/**
 * 响应式壳（action shell 惯例 + app-screens §3）：≥1024dp 桌面用左侧栏
 * （原生 tab bar 隐藏），窄屏折叠为底部标签栏。仅两个目的地：Archive / Me。
 * 激活态按亮度（text vs muted），蓝色不上导航（房规：active nav by brightness）；
 * 原生 props 的色全部走 getPalette，不散写 hex。
 *
 * 侧栏常驻分工（2026-11-11）：web desktop 侧栏已上收根布局（app/_layout 的
 * DesktopShell——stack push 屏也要常驻侧栏），本布局检测到壳活跃（useIsDesktopShell，
 * 同一断点常量）时不再自渲染 Sidebar，只保留「宽屏隐藏底部 tab bar」；native
 * 宽屏（无壳）维持历史行为：Sidebar 内嵌渲染在本布局，栈屏覆盖语义同旧版。
 */
export default function TabLayout() {
    const { width } = useWindowDimensions();
    const wide = width >= DESKTOP_BREAKPOINT;
    const shellActive = useIsDesktopShell();
    const palette = getPalette(useEffectiveTheme());

    return (
        <View className="flex-1 flex-row bg-ink-base dark:bg-inkd-base">
            {/* native 宽屏内嵌侧栏（web 宽屏由根壳持有，避免双侧栏） */}
            {wide && !shellActive ? <Sidebar /> : null}
            <View className="flex-1">
                <Tabs
                    screenOptions={{
                        headerShown: false,
                        sceneStyle: { backgroundColor: palette.sceneBg },
                        tabBarActiveTintColor: palette.tabActive,
                        tabBarInactiveTintColor: palette.tabInactive,
                        tabBarStyle: wide
                            ? { display: 'none' }
                            : {
                                  backgroundColor: palette.barBg,
                                  borderTopColor: palette.barBorder,
                                  borderTopWidth: 1,
                              },
                        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
                    }}
                >
                    <Tabs.Screen
                        name="index"
                        options={{
                            title: 'Archive',
                            tabBarIcon: ({ color }) => (
                                <LucideBookOpen size={21} strokeWidth={1.75} color={color ?? undefined} />
                            ),
                        }}
                    />
                    <Tabs.Screen
                        name="me"
                        options={{
                            title: 'Me',
                            tabBarIcon: ({ color }) => (
                                <LucideUser size={21} strokeWidth={1.75} color={color ?? undefined} />
                            ),
                        }}
                    />
                </Tabs>
            </View>
        </View>
    );
}
