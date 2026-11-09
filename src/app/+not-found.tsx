import { Link, Stack, router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { LucideBookOpen } from '@/core/icons';
import { usePalette } from '@/features/archive';

/** 404（主题化）：说明 + 回首页动作，与全局 ink 令牌一致。整页点按任意位置
    亦可回首页（Link 自身命中优先，背景层不吞按钮首点）。 */
export default function NotFoundScreen() {
    const palette = usePalette();
    return (
        <>
            <Stack.Screen options={{ title: '页面不存在' }} />
            <Pressable
                className="flex-1 items-center justify-center bg-ink-base px-10 dark:bg-inkd-base"
                accessibilityRole="button"
                accessibilityLabel="回到 Archive"
                onPress={() => router.replace('/')}
            >
                <LucideBookOpen size={40} color={palette.muted} strokeWidth={1.5} />
                <Text className="mt-4 text-[20px] font-semibold text-ink-text dark:text-inkd-text">
                    走到了没有路的地方
                </Text>
                <Text className="mt-2 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                    这个地址不存在或已被移动。
                </Text>
                <Link
                    href="/"
                    className="mt-12 h-11 items-center justify-center rounded-control border border-ink-border bg-ink-surface px-6 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised"
                >
                    <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                        回到 Archive
                    </Text>
                </Link>
            </Pressable>
        </>
    );
}
