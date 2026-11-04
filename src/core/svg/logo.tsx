import { useEffect, useMemo } from 'react';
import { Canvas, LinearGradient, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import { Easing, useDerivedValue, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { HATCH_PALETTE } from '@/core/icons';
import { SkiaSvgError } from './errors';

/**
 * Hatch Logo（Skia GPU 版）：蛋形路径填充**循环变色渐变着色器**，
 * 渐变色板轮转 + 渐变轴旋转全部由 reanimated 派生值驱动、GPU 重绘——
 * 真正的"图形本身在动"（对比 GradientCycle 的宿主分层方案，这里动的
 * 是 Skia paint 本体，三端同一渲染管线）。
 */
const EGG_D = 'M24 4 C31 4 39 13 39 26 C39 37 32.5 44 24 44 C15.5 44 9 37 9 26 C9 13 17 4 24 4 Z';
const CRACK_D = 'M9 25 L15 21 L19 27 L24 20 L29 27 L33 21 L39 25';
const HIGHLIGHT_D = 'M17 12 C18.5 10 21 9 23 9';

function pathFromSvg(d: string): SkPath {
    const path = Skia.Path.MakeFromSVGString(d);
    if (path === null) {
        throw new SkiaSvgError('svg/parse', `HatchLogoSkia: 路径解析失败 "${d.slice(0, 24)}…"`);
    }
    return path;
}

export function HatchLogoSkia({ size = 128, duration = 6000 }: { size?: number; duration?: number }) {
    const progress = useSharedValue(0);

    useEffect(() => {
        progress.value = withRepeat(
            withTiming(1, { duration, easing: Easing.linear }),
            -1,
            false,
        );
    }, [duration, progress]);

    // 色板随相位轮转 → 相邻帧颜色连续，GPU 端呈现 6 色流动
    const colors = useDerivedValue(() => {
        const count = HATCH_PALETTE.length;
        const offset = Math.floor(progress.value * count) % count;
        return [...HATCH_PALETTE.slice(offset), ...HATCH_PALETTE.slice(0, offset)];
    });
    const gradientStart = useDerivedValue(() => {
        const angle = progress.value * Math.PI * 2;
        return { x: 24 - Math.cos(angle) * 34, y: 24 - Math.sin(angle) * 34 };
    });
    const gradientEnd = useDerivedValue(() => {
        const angle = progress.value * Math.PI * 2;
        return { x: 24 + Math.cos(angle) * 34, y: 24 + Math.sin(angle) * 34 };
    });

    const eggPath = useMemo(() => pathFromSvg(EGG_D), []);
    const crackPath = useMemo(() => pathFromSvg(CRACK_D), []);
    const highlightPath = useMemo(() => pathFromSvg(HIGHLIGHT_D), []);

    return (
        <Canvas style={{ width: size, height: size }}>
            <Path path={eggPath} style="fill">
                <LinearGradient start={gradientStart} end={gradientEnd} colors={colors} />
            </Path>
            <Path
                path={crackPath}
                style="stroke"
                strokeWidth={2.4}
                color="#0a0a0a"
                strokeCap="round"
                strokeJoin="round"
            />
            <Path
                path={highlightPath}
                style="stroke"
                strokeWidth={1.6}
                color="rgba(255,255,255,0.7)"
                strokeCap="round"
            />
        </Canvas>
    );
}
