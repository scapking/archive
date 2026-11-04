import { View, Text } from 'react-native';
import { moodMeta } from '../entry-logic';
import type { EntryMood } from '../db';

/**
 * 心情点：时间线上唯一的常驻色彩（app-screens：色只上数据）。
 * 无心情时不渲染任何东西——空值就该是空。
 */
export function MoodDot({ mood, withLabel = false }: { mood: EntryMood | null; withLabel?: boolean }) {
    const meta = moodMeta(mood);
    if (!meta) return null;
    return (
        <View className="flex-row items-center" accessibilityLabel={`心情：${meta.label}`}>
            <View
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: meta.color }}
            />
            {withLabel ? (
                <Text className="ml-1.5 text-[11px] text-hatch-muted">{meta.label}</Text>
            ) : null}
        </View>
    );
}
