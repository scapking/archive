import { Image, View } from 'react-native';
import { LucideUser } from '@/core/icons';
import { usePalette } from './theme';
// 深路径注记：use-file-url 已在 ui/index.ts 出口，本文件同样可走 barrel；
// 但本组件与 use-file-url 同目录同层，直连减少一层 barrel 间接（同 close-button 先例）。
import { useFileUrlState } from './use-file-url';

/**
 * ProfileAvatar：个人头像的唯一呈现组件（Me 页标题行消费）。
 *
 * 数据契约：`fileKey` 是 file-storage key（'profile/avatar.jpg'，config 'ui.avatar'
 * 持久化）；null / '' = 未设置头像。呈现三态（useFileUrlState 口径，与媒体块一致）：
 * 1. loading：解析中 → raised 圆底占位（不裸黑块、不闪图标）；
 * 2. ready：拿到可渲染 URI（native file:// / web blob:）→ 圆形裁切显示；
 * 3. missing：文件被删（GC/换设备）/ key 缺失 → LucideUser 圆底占位——
 *    头像缺失属文档化可自愈降级（config 里 key 还在但文件没了，下次设置头像
 *    覆盖写即恢复），不打断 Me 页使用，也绝不做静默清 key（区分「没设置」与「读不到」）。
 *
 * 视觉口径：rounded-full + 1px ink-border（圆底在 base 画布上的边缘定义，
 * 双主题 token 成对）+ raised 底；无边框规范 #13 管卡片级描边，圆形头像的
 * 1px 轮廓属元素级边界（同 TripBadge 的 border），不在清除之列。
 * 尺寸由调用方定（Me 页 44dp，40-48 档——小头像融入标题行，不做大头像块），
 * 点击行为（选图上传）不由本组件负责。
 */
export function ProfileAvatar({
    fileKey,
    size = 44,
}: {
    /** file-storage key；null = 未设置头像（直接渲染占位，不走解析）。 */
    fileKey: string | null;
    /** 直径（px），含 1px 边框。 */
    size?: number;
}) {
    const { status, uri } = useFileUrlState(fileKey);
    const palette = usePalette();
    return (
        <View
            className="items-center justify-center overflow-hidden rounded-full border border-ink-border bg-ink-raised dark:border-inkd-border dark:bg-inkd-raised"
            style={{ width: size, height: size }}
        >
            {status === 'ready' && uri ? (
                <Image
                    source={{ uri }}
                    style={{ width: size, height: size }}
                    resizeMode="cover"
                />
            ) : status === 'missing' ? (
                <LucideUser
                    size={Math.round(size * 0.44)}
                    strokeWidth={1.9}
                    color={palette.muted}
                />
            ) : null}
        </View>
    );
}
