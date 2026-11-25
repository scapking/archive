import { Tabs } from 'expo-router';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Sidebar, getPalette, useEffectiveTheme } from '@/features/archive';
// 深路径注记：web desktop 壳的断点常量与让位判定未在域 barrel 出口（ui/index.ts
// 无本轮改动权限），域内深取（editor-icons / close-button 先例）。
import { DESKTOP_BREAKPOINT, useIsDesktopShell } from '@/features/archive/ui/desktop-shell';
import { LucidePenLine, LucideUser } from '@/core/icons';

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
 *
 * v0.4.6 tab 栏重样（用户点名「首页截图里 tab 栏的 Archive/Me 渲染很糙」）：
 * - **选中态三通道**：亮度（tintColor 语言不动）+ 图标笔画（focused 1.6 vs
 *   未选 1.5 太虚，改 1.75/2.15）+ 标签字重（active 600）——仍不上彩；
 * - **web 高度收口**：RNW 下底栏按默认内容高排布，11px 标签贴死视口下缘
 *   （baseline-home 截图「Archive」下半被裁）。web 档显式 height 56 + 顶
 *   内边距，标签带 10dp 落脚区；native 保持系统默认高（49+安全区）零改动。
 */

/** web 档底栏几何（native undefined = 交回系统布局）。 */
const WEB_BAR_STYLE = Platform.OS === 'web' ? { height: 56, paddingTop: 8 } : undefined;
const WEB_LABEL_STYLE = Platform.OS === 'web' ? { marginBottom: 0 } : undefined;

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
                                  ...(WEB_BAR_STYLE ?? {}),
                              },
                        tabBarLabelStyle: {
                            fontSize: 11,
                            fontWeight: '500',
                            ...(WEB_LABEL_STYLE ?? {}),
                        },
                    }}
                >
                    <Tabs.Screen
                        name="index"
                        options={{
                            title: 'Archive',
                            // 选中态加粗一档笔画（2.15/1.75）：亮度 + 字重 +
                            // 笔画三通道，激活目的地一眼可辨（v0.4.6）
                            tabBarIcon: ({ focused, color }) => (
                                <LucidePenLine
                                    size={22}
                                    strokeWidth={focused ? 2.15 : 1.7}
                                    color={color ?? undefined}
                                />
                            ),
                        }}
                    />
                    <Tabs.Screen
                        name="me"
                        options={{
                            title: 'Me',
                            tabBarIcon: ({ focused, color }) => (
                                <LucideUser
                                    size={22}
                                    strokeWidth={focused ? 2.15 : 1.7}
                                    color={color ?? undefined}
                                />
                            ),
                        }}
                    />
                </Tabs>
            </View>
        </View>
    );
}
