import type { ReactNode } from 'react';
import type { ColorValue } from 'react-native';
import { Svg } from 'react-native-svg';

/**
 * 图标基座：24×24 网格、描边式（stroke）、圆角端点，颜色/线宽/尺寸由调用方注入。
 * stroke 色与线宽设在 <Svg> 上，向所有子 path 继承——自定义 SVG 也走这里。
 */
export interface IconProps {
    size?: number;
    color?: ColorValue;
    strokeWidth?: number;
}

export function IconBase({
    size = 24,
    color = '#e5e5e5',
    strokeWidth = 2,
    children,
}: IconProps & { children: ReactNode }) {
    return (
        <Svg
            viewBox="0 0 24 24"
            width={size}
            height={size}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {children}
        </Svg>
    );
}

/**
 * 图标工厂：把一段 JSX（来自 @/core/icons 内置集，或调用方的自定义 SVG 内容）
 * 变成标准 Icon 组件。自定义图标 = createIcon(<Path …/>)。
 */
export function createIcon(children: ReactNode) {
    return function Icon(props: IconProps) {
        return <IconBase {...props}>{children}</IconBase>;
    };
}
