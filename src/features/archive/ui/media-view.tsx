import { Image, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { useFileUrl } from './use-file-url';
import type { JournalMediaRow } from '../db';

/** 图片块渲染：落盘 key → blob/file URI。 */
export function MediaImage({ media, height = 180 }: { media: JournalMediaRow; height?: number }) {
    const uri = useFileUrl(media.file_key);
    return (
        <View
            className="overflow-hidden rounded-lg border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
            style={{ height }}
        >
            {uri ? <Image source={{ uri }} className="h-full w-full" resizeMode="cover" /> : null}
        </View>
    );
}

/** 视频块渲染：内联播放器（三端 expo-video）。 */
export function MediaVideo({ media, height = 200 }: { media: JournalMediaRow; height?: number }) {
    const uri = useFileUrl(media.file_key);
    const player = useVideoPlayer(uri ?? '', (player) => {
        player.loop = false;
        player.muted = false;
    });
    if (!uri) {
        return (
            <View
                className="rounded-lg border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
                style={{ height }}
            />
        );
    }
    return (
        <View
            className="overflow-hidden rounded-lg border border-ink-border dark:border-inkd-border"
            style={{ height }}
        >
            <VideoView player={player} contentFit="cover" style={{ flex: 1 }} />
        </View>
    );
}

/** 媒体块统一入口。 */
export function MediaBlock({ media }: { media: JournalMediaRow }) {
    return media.kind === 'video' ? <MediaVideo media={media} /> : <MediaImage media={media} />;
}

/** 缩略图（卡片内小图）。 */
export function MediaThumb({ media, size = 64 }: { media: JournalMediaRow; size?: number }) {
    const uri = useFileUrl(media.file_key);
    return (
        <View
            className="overflow-hidden rounded-md border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
            style={{ width: size, height: size }}
        >
            {uri && media.kind === 'image' ? (
                <Image source={{ uri }} className="h-full w-full" resizeMode="cover" />
            ) : null}
        </View>
    );
}
