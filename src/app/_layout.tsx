import '../global.css';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useArchiveStore } from '@/features/archive';
import { applyThemePref, useEffectiveTheme, type ThemePref } from '@/features/archive/ui/theme';
import { archiveConfig } from '@/config/archive';

export default function RootLayout() {
    // 域数据一次性加载 + 恢复主题偏好（web 初始恒 light，需显式 set 回 'system'）
    const ready = useArchiveStore((s) => s.ready);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const theme = useEffectiveTheme();

    useEffect(() => {
        if (!ready) void loadAll();
        applyThemePref(archiveConfig.get()['ui.theme'] as ThemePref);
    }, [ready, loadAll]);

    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: theme === 'dark' ? '#080A0A' : '#FFFFFF' },
            }}
        >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="trip/[id]" />
            <Stack.Screen name="trip/new" options={{ presentation: 'modal' }} />
            <Stack.Screen name="trip/[id]/edit" options={{ presentation: 'modal' }} />
            <Stack.Screen name="write" options={{ presentation: 'modal' }} />
            <Stack.Screen name="trip/[id]/write/[date]" options={{ presentation: 'modal' }} />
            <Stack.Screen name="journal/[id]" options={{ presentation: 'modal' }} />
        </Stack>
    );
}

/**
 * 路由级错误边界（expo-router 约定）：渲染异常不再白屏，
 * 给出可读的降级页 + 重试入口。
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry(): void }) {
    return (
        <View className="flex-1 items-center justify-center bg-ink-base px-10 dark:bg-inkd-base">
            <Text className="text-[17px] font-semibold text-ink-text dark:text-inkd-text">
                出了点问题
            </Text>
            <Text className="mt-2 text-center text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                {error.message || '界面渲染遇到未预期的错误。'}
            </Text>
            <Pressable
                onPress={retry}
                className="mt-6 h-11 items-center justify-center rounded-lg border border-ink-border bg-ink-surface px-6 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
            >
                <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">重试</Text>
            </Pressable>
        </View>
    );
}
