import { Tabs } from 'expo-router';
import { View, useWindowDimensions } from 'react-native';
import { Sidebar } from '@/features/archive';
import { LucideBookOpen, LucideUser } from '@/core/icons';
import { useEffectiveTheme } from '@/features/archive/ui/theme';

const WIDE_BREAKPOINT = 1024;

/**
 * 响应式壳（action shell 惯例 + app-screens §3）：≥1024px 桌面用左侧栏
 * （原生 tab bar 隐藏），窄屏折叠为底部标签栏。仅两个目的地：Archive / Me。
 */
export default function TabLayout() {
    const { width } = useWindowDimensions();
    const wide = width >= WIDE_BREAKPOINT;
    const theme = useEffectiveTheme();
    const dark = theme === 'dark';

    return (
        <View className="flex-1 flex-row bg-ink-base dark:bg-inkd-base">
            {wide ? <Sidebar /> : null}
            <View className="flex-1">
                <Tabs
                    screenOptions={{
                        headerShown: false,
                        sceneStyle: { backgroundColor: dark ? '#080A0A' : '#FFFFFF' },
                        tabBarActiveTintColor: dark ? '#5B9DFF' : '#2563EB',
                        tabBarInactiveTintColor: dark ? '#7A827F' : '#8B939C',
                        tabBarStyle: wide
                            ? { display: 'none' }
                            : {
                                  backgroundColor: dark ? '#0B0E0DF2' : '#FFFFFFF5',
                                  borderTopColor: dark ? '#1E2422' : '#E5E8EC',
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
