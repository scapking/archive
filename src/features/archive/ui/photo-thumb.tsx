import { Image, View } from 'react-native';
import { useFileUrl } from './use-file-url';

/**
 * 落盘图片缩略图：DB 只存 file-storage key，渲染时经 useFileUrl 解析。
 * 缺文件降级为灰底空块（见 use-file-url 的降级语义）。
 */
export function PhotoThumb({ fileKey, size = 72 }: { fileKey: string; size?: number }) {
    const uri = useFileUrl(fileKey);
    return (
        <View
            className="overflow-hidden rounded-md border border-hatch-border bg-hatch-raised"
            style={{ width: size, height: size }}
        >
            {uri ? (
                <Image source={{ uri }} className="h-full w-full" resizeMode="cover" />
            ) : null}
        </View>
    );
}
