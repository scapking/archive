import { cloneElement, isValidElement } from 'react';
import { Circle, Path, Rect } from 'react-native-svg';
import { createIcon } from '@/core/icons';

/**
 * 编辑器组自建线性图标（24×24 stroke 网格，与 core/icons 同基座）：
 * 既有 Lucide 集（core/icons/lucide.tsx）缺这些形，且 core/icons 不在本组
 * 修改权限内——业务层按 icon-base 的官方用法 createIcon(<Path …/>) 自建，
 * 不直接 import lucide-react-native（房规：第三方图标包只在 core 适配层出现）。
 * path 数据取自 lucide 1.64 对应图标的 __iconData.node。
 */

/** 上移 / 下移（块操作条；chevron-up / chevron-down）。 */
export const ChevronUpIcon = createIcon(<Path d="m18 15-6-6-6 6" />);
export const ChevronDownIcon = createIcon(<Path d="m6 9 6 6 6-6" />);

/** 暂停（音频播放器；pause）。 */
export const PauseIcon = createIcon(
    <>
        <Rect x={14} y={3} width={5} height={18} rx={1} />
        <Rect x={5} y={3} width={5} height={18} rx={1} />
    </>,
);

/** 全屏（媒体块全屏入口暗示；maximize）。 */
export const MaximizeIcon = createIcon(
    <>
        <Path d="M8 3H5a2 2 0 0 0-2 2v3" />
        <Path d="M21 8V5a2 2 0 0 0-2-2h-3" />
        <Path d="M3 16v3a2 2 0 0 0 2 2h3" />
        <Path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </>,
);

/** 前后摄翻转（拍摄覆盖层；switch-camera）。 */
export const SwitchCameraIcon = createIcon(
    <>
        <Path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
        <Path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
        <Circle cx={12} cy={12} r={3} />
        <Path d="m18 22-3-3 3-3" />
        <Path d="m6 2 3 3-3 3" />
    </>,
);

/** 停止（录音/录像进行中的停止钮；square）。 */
export const SquareIcon = createIcon(<Rect width={18} height={18} x={3} y={3} rx={2} />);

/** 声纹（录音选择器行 / 音频块标；audio-lines）。 */
export const AudioLinesIcon = createIcon(
    <>
        <Path d="M2 10v3" />
        <Path d="M6 6v11" />
        <Path d="M10 3v18" />
        <Path d="M14 8v7" />
        <Path d="M18 5v13" />
        <Path d="M22 10v3" />
    </>,
);

/** 块操作入口（聚焦文本块浮出的微型钮；more-horizontal）。 */
export const MoreIcon = createIcon(
    <>
        <Circle cx={12} cy={12} r={1} />
        <Circle cx={19} cy={12} r={1} />
        <Circle cx={5} cy={12} r={1} />
    </>,
);

/** 相册视频（+ 选择器行；image-play 与图片行区分）。 */
export const ImagePlayIcon = createIcon(
    <>
        <Path d="M15 15.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997a1 1 0 0 1-1.517-.86z" />
        <Path d="M21 12.17V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6" />
        <Path d="m6 21 5-5" />
        <Circle cx={9} cy={9} r={2} />
    </>,
);

/**
 * 调用点的 icon 只给形状，色统一在这里补（缺色时原样渲染；范式同
 * archive-screen withTint——业务层图标不带 color，渲染处统一注入语义色）。
 */
export function tintIcon(node: React.ReactNode, color: string): React.ReactNode {
    if (!isValidElement(node)) return node;
    const element = node as React.ReactElement<{ color?: string }>;
    return element.props.color !== undefined ? node : cloneElement(element, { color });
}
