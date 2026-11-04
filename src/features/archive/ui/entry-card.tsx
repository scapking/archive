import { Text, View } from 'react-native';
import { PhotoThumb } from './photo-thumb';
import { MoodDot } from './mood-dot';
import { formatTime } from '../entry-logic';
import type { EntryWithPhotos } from '../entry-logic';

/**
 * 碎片卡：文字 + 图片行 + （时间 · 心情）落款。
 * 平面卡片（app-screens：1px 边分隔，无阴影），最大条数 9 图取前 3 + 溢出数。
 */
export function EntryCard({ entry }: { entry: EntryWithPhotos }) {
    const overflow = entry.photos.length > 3 ? entry.photos.length - 3 : 0;
    const shown = entry.photos.slice(0, 3);
    return (
        <View className="rounded-lg border border-hatch-border bg-hatch-surface px-4 py-3">
            {entry.content ? (
                <Text className="text-[15px] leading-6 text-hatch-text">{entry.content}</Text>
            ) : null}
            {shown.length > 0 ? (
                <View className="mt-3 flex-row items-center gap-2">
                    {shown.map((photo) => (
                        <PhotoThumb key={photo.id} fileKey={photo.file_key} />
                    ))}
                    {overflow > 0 ? (
                        <View className="h-[72px] w-[72px] items-center justify-center rounded-md border border-hatch-border bg-hatch-raised">
                            <Text
                                className="text-[15px] font-medium text-hatch-secondary"
                                style={{ fontVariant: ['tabular-nums'] }}
                            >
                                +{overflow}
                            </Text>
                        </View>
                    ) : null}
                </View>
            ) : null}
            <View className="mt-3 flex-row items-center justify-between">
                <Text
                    className="text-[11px] text-hatch-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {formatTime(entry.created_at)}
                </Text>
                <MoodDot mood={entry.mood} withLabel />
            </View>
        </View>
    );
}
