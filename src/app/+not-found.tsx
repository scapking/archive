import { Link, Stack, router } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { LucidePenLine } from '@/core/icons';
import { usePalette } from '@/features/archive';

/**
 * 404（v0.4.6 重样：方向令 §2 字阶 + §5 apple 克制）：eyebrow 档「迷路」定位
 * （404 二字 + 页名）→ 24 屏题档一行去向 → 12 meta 一行说明 → 主行动钮
 * （近黑药丸，与 PrimaryButton 同语言）。整页点按任意位置亦可回首页
 * （Link 自身命中优先，背景层不吞按钮首点）。
 */
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
                <LucidePenLine size={40} color={palette.faint} strokeWidth={1.5} />
                <Text className="mt-6 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                    404
                </Text>
                <Text className="mt-1.5 text-center text-[24px] font-semibold text-ink-text dark:text-inkd-text">
                    走到了没有路的地方
                </Text>
                <Text className="mt-2 text-center text-[12px] leading-5 text-ink-muted dark:text-inkd-muted">
                    这个地址不存在或已被移动。
                </Text>
                {/* 主行动 = 近黑药丸（白字反相），48 命中档；点穿背景层的
                    旧描边次级钮升为唯一动作，动词与去向同词（「回到 Archive」）。
                    Link 单层级（原生侧 Link 是 Text 宿主，不嵌 View 盒） */}
                <Link
                    href="/"
                    className="h-12 items-center justify-center rounded-full px-7"
                    style={{ marginTop: 28, backgroundColor: palette.primaryBtn }}
                >
                    <Text className="text-[16px] font-semibold" style={{ color: palette.onPrimaryBtn }}>
                        回到 Archive
                    </Text>
                </Link>
            </Pressable>
        </>
    );
}
