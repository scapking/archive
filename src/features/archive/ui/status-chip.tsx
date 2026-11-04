import { Text, View } from 'react-native';
import type { TripStatus } from '../trip-logic';

/**
 * 行程状态片：计划中（灰描边）/ 进行中（蓝点，强调色的数据用途）/ 回忆（灰填充）。
 * 导航与容器保持灰阶，色彩只出现在状态这个"数据"上。
 */
const STATUS_META: Record<TripStatus, { label: string; dot: string | null; filled: boolean }> = {
    planning: { label: '计划中', dot: null, filled: false },
    ongoing: { label: '进行中', dot: '#3B82F6', filled: false },
    finished: { label: '回忆', dot: null, filled: true },
};

export function StatusChip({ status }: { status: TripStatus }) {
    const meta = STATUS_META[status];
    return (
        <View
            className={`flex-row items-center rounded-md border px-2 py-1 ${
                meta.filled
                    ? 'border-transparent bg-ink-raised dark:bg-inkd-raised'
                    : 'border-ink-border dark:border-inkd-border'
            }`}
            accessibilityLabel={`状态：${meta.label}`}
        >
            {meta.dot ? (
                <View
                    className="mr-1.5 h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: meta.dot }}
                />
            ) : null}
            <Text
                className={`text-[11px] ${
                    meta.filled
                        ? 'text-ink-secondary dark:text-inkd-secondary'
                        : 'text-ink-muted dark:text-inkd-muted'
                }`}
            >
                {meta.label}
            </Text>
        </View>
    );
}
