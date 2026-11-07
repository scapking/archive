import { Text, View } from 'react-native';
import type { TripStatus } from '../trip-logic';

/**
 * 行程状态片（淡底对 + 药丸，app-screens 状态色纪律）：
 * 计划中 = 灰描边 / 进行中 = accent 淡底 + accent 圆点与文字（强调色的数据用途）/
 * 回忆 = raised 填充。导航与容器保持灰阶，色彩只出现在状态这个「数据」上。
 */
const STATUS_META: Record<TripStatus, { label: string; kind: 'outline' | 'accent' | 'filled' }> = {
    planning: { label: '计划中', kind: 'outline' },
    ongoing: { label: '进行中', kind: 'accent' },
    finished: { label: '回忆', kind: 'filled' },
};

const KIND_CLASS: Record<'outline' | 'accent' | 'filled', string> = {
    outline: 'border border-ink-control dark:border-inkd-control',
    accent: 'border border-transparent bg-ink-accent-bg dark:bg-inkd-accent-bg',
    filled: 'border border-transparent bg-ink-raised dark:bg-inkd-raised',
};

const LABEL_CLASS: Record<'outline' | 'accent' | 'filled', string> = {
    outline: 'text-ink-secondary dark:text-inkd-secondary',
    accent: 'text-ink-accent dark:text-inkd-accent',
    filled: 'text-ink-muted dark:text-inkd-muted',
};

export function StatusChip({ status }: { status: TripStatus }) {
    const meta = STATUS_META[status];
    return (
        <View
            className={`h-6 flex-row items-center rounded-full px-2.5 ${KIND_CLASS[meta.kind]}`}
            accessibilityLabel={`状态：${meta.label}`}
        >
            {meta.kind === 'accent' ? (
                <View className="mr-1.5 h-1.5 w-1.5 rounded-full bg-ink-accent dark:bg-inkd-accent" />
            ) : null}
            <Text className={`text-[11px] font-medium ${LABEL_CLASS[meta.kind]}`}>{meta.label}</Text>
        </View>
    );
}
