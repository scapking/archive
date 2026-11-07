import { Tabs } from 'expo-router';
import { View, useWindowDimensions } from 'react-native';
import { Sidebar, getPalette, useEffectiveTheme } from '@/features/archive';
import { LucideBookOpen, LucideUser } from '@/core/icons';

const WIDE_BREAKPOINT = 1024;

/**
 * 响应式壳（action shell 惯例 + app-screens §3）：≥1024px 桌面用左侧栏
 * （原生 tab bar 隐藏），窄屏折叠为底部标签栏。仅两个目的地：Archive / Me。
 * 激活态按亮度（text vs muted），蓝色不上导航（房规：active nav by brightness）；
 * 原生 props 的色全部走 getPalette，不散写 hex。
 */
export default function TabLayout() {
    const { width } = useWindowDimensions();
    const wide = width >= WIDE_BREAKPOINT;
    const palette = getPalette(useEffectiveTheme());

    return (
        <View className="flex-1 flex-row bg-ink-base dark:bg-inkd-base">
            {wide ? <Sidebar /> : null}
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
