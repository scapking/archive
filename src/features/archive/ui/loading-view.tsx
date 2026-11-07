import { ActivityIndicator, View } from 'react-native';
import { usePalette } from './theme';

/**
 * 全屏加载态（数据载入期间的统一降级页）：
 * 指示色走 palette（加载是「进行中」语义，用 accent，不再散写 hex）。
 */
export function LoadingView() {
    const palette = usePalette();
    return (
        <View className="flex-1 items-center justify-center bg-ink-base dark:bg-inkd-base">
            <ActivityIndicator color={palette.spinner} />
        </View>
    );
}
