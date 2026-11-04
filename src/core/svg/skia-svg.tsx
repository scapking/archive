import { useMemo } from 'react';
import { Canvas, ImageSVG, Skia } from '@shopify/react-native-skia';
import { SkiaSvgError } from './errors';

/**
 * 通用自定义 SVG 渲染（Skia GPU 路径）：
 * 任意 SVG 字符串 → Skia.SVG 解析 → <ImageSVG> GPU 绘制。
 * 相比 react-native-svg：GPU 合成、可叠加着色器/模糊/运行时特效，扩展性上限高。
 * 解析失败抛 `svg/parse`（调用方可降级），成功后三端同一渲染结果。
 */

export interface SkiaSvgProps {
    /** 完整 SVG 字符串（含 <svg> 根节点） */
    svg: string;
    width?: number;
    height?: number;
}

export function SkiaSvg({ svg, width = 96, height = 96 }: SkiaSvgProps) {
    const parsed = useMemo(() => {
        const parsedSvg = Skia.SVG.MakeFromString(svg);
        if (parsedSvg === null) {
            throw new SkiaSvgError('svg/parse', 'SkiaSvg: SVG 字符串解析失败');
        }
        return parsedSvg;
    }, [svg]);

    return (
        <Canvas style={{ width, height }}>
            <ImageSVG svg={parsed} x={0} y={0} width={width} height={height} />
        </Canvas>
    );
}

export { SkiaSvgError, type SkiaSvgErrorCode } from './errors';
