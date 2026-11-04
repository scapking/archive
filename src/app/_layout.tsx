import '../global.css';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { useArchiveStore } from '@/features/archive';

export default function RootLayout() {
    // 域数据一次性加载（时间线/行程列表共用；详情屏自持并订阅 revision）
    const ready = useArchiveStore((s) => s.ready);
    const loadAll = useArchiveStore((s) => s.loadAll);

    useEffect(() => {
        if (!ready) void loadAll();
    }, [ready, loadAll]);

    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: '#080A0A' },
            }}
        >
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="trip/[id]" />
            <Stack.Screen name="write" options={{ presentation: 'modal' }} />
            <Stack.Screen name="trip/[id]/write/[date]" options={{ presentation: 'modal' }} />
            <Stack.Screen name="trip/new" options={{ presentation: 'modal' }} />
        </Stack>
    );
}

/**
 * 路由级错误边界（expo-router 约定）：渲染异常不再白屏，
 * 给出可读的降级页 + 重试入口。
 */
export function ErrorBoundary({ error, retry }: { error: Error; retry(): void }) {
    return (
        <View className="flex-1 items-center justify-center bg-hatch-base px-10">
            <Text className="text-[17px] font-semibold text-hatch-text">出了点问题</Text>
            <Text className="mt-2 text-center text-[13px] leading-5 text-hatch-secondary">
                {error.message || '界面渲染遇到未预期的错误。'}
            </Text>
            <Pressable
                onPress={retry}
                className="mt-6 h-11 items-center justify-center rounded-lg border border-hatch-border bg-hatch-surface px-6 active:bg-hatch-raised"
            >
                <Text className="text-[14px] font-medium text-hatch-text">重试</Text>
            </Pressable>
        </View>
    );
}
