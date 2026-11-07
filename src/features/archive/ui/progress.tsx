import { Text, View } from 'react-native';
import { usePalette } from './theme';

/**
 * 细进度条（计划完成度等目标类数据）：轨道 = raised，进度 = accent（数据上色，
 * 房规「blue only on data」）。两端数值由调用方配文案；数字位调用方给 tabular-nums。
 */
export function ProgressBar({ done, total, className = '' }: { done: number; total: number; className?: string }) {
    const palette = usePalette();
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    return (
        <View className={`h-1 w-full rounded-full bg-ink-raised dark:bg-inkd-raised ${className}`}>
            <View
                className="h-1 rounded-full"
                style={{ width: `${pct}%`, backgroundColor: palette.accent }}
            />
        </View>
    );
}

/** 进度条的伴随文案（「计划完成 3/5」）；数字位 tabular-nums。 */
export function ProgressLabel({ done, total, prefix = '计划完成' }: { done: number; total: number; prefix?: string }) {
    return (
        <Text
            className="text-[11px] text-ink-muted dark:text-inkd-muted"
            style={{ fontVariant: ['tabular-nums'] }}
        >
            {prefix} {done}/{total}
        </Text>
    );
}
