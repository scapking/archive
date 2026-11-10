import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import {
    areaPath,
    linePath,
    niceTicks,
    plotMetrics,
    xLabelPoints,
    type ChartPoint,
} from '../chart-logic';
import { getPalette, useEffectiveTheme } from './theme';

let GRAD_SEQ = 0;

/**
 * 折线图（app-screens §6 + 图表房规）：2px 直线、面积填充 ≤14%（accent→透明）、
 * 3-5 条横网格、刻度与 x 标签 12px（字号下限 11 的 SVG 场景）、无图例无数据点。
 * 色全部走 palette（grid/muted/accent），空数据显示空框。
 *
 * animated（opt-in，默认 false）：进场整图淡入一拍（420ms ease-out、延迟
 * 260ms），为 Me 页「标题先立、曲线后到」的两拍节奏定制；不传即完全旧行为。
 * 只动 opacity（RN Animated native driver；铁律：Animated style 只许
 * transform/opacity——strokeDashoffset 画线式「描线」需 JS 逐帧驱动，违铁律，
 * 不做）。目前唯一调用方是 Me 页，他屏接入不受影响。
 */
export function LineChart({
    points,
    height = 168,
    animated = false,
}: {
    points: ChartPoint[];
    height?: number;
    /** 进场淡入（opt-in）：true 时整图 opacity 0→1（420ms / 延迟 260ms）。 */
    animated?: boolean;
}) {
    const [width, setWidth] = useState(0);
    const gradientId = useState(() => `ink-chart-${(GRAD_SEQ += 1)}`)[0];
    const palette = getPalette(useEffectiveTheme());
    const maxV = points.reduce((m, p) => Math.max(m, p.value), 0);
    const { ticks, top } = niceTicks(maxV);
    const m = plotMetrics(points, top, { width, height, lane: 34, foot: 20, head: 12 });
    const labels = xLabelPoints(points, 3);
    const hasData = points.length > 1 && maxV > 0;
    // 淡入进度：opt-in 才从 0 起播；默认档初值即 1（不建时间线，渲染零差异）
    const fade = useRef(new Animated.Value(animated ? 0 : 1)).current;
    useEffect(() => {
        if (!animated) return;
        const anim = Animated.timing(fade, {
            toValue: 1,
            duration: 420,
            delay: 260,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        });
        anim.start();
        return () => anim.stop();
    }, [animated, fade]);
    return (
        <Animated.View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height, opacity: fade }}>
            {width > 0 ? (
                <Svg width={width} height={height}>
                    <Defs>
                        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <Stop offset="0" stopColor={palette.accent} stopOpacity={0.14} />
                            <Stop offset="1" stopColor={palette.accent} stopOpacity={0.02} />
                        </LinearGradient>
                    </Defs>
                    {ticks.map((tick) => (
                        <Line
                            key={`grid-${tick}`}
                            x1={m.left}
                            x2={width}
                            y1={m.y(tick)}
                            y2={m.y(tick)}
                            stroke={palette.grid}
                            strokeWidth={1}
                        />
                    ))}
                    {/* 网格刻度文字 */}
                    {ticks.map((tick) => (
                        <SvgText
                            key={`label-${tick}`}
                            x={m.left - 6}
                            y={m.y(tick) + 4}
                            fontSize={12}
                            fill={palette.muted}
                            textAnchor="end"
                        >
                            {tick}
                        </SvgText>
                    ))}
                    {hasData ? (
                        <>
                            <Path d={areaPath(points, m)} fill={`url(#${gradientId})`} />
                            <Path d={linePath(points, m)} fill="none" stroke={palette.accent} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                        </>
                    ) : null}
                    {labels.map((label) => (
                        <SvgText
                            key={`x-${label.index}`}
                            x={m.x(label.index)}
                            y={height - 4}
                            fontSize={12}
                            fill={palette.muted}
                            textAnchor={label.index === 0 ? 'start' : label.index === points.length - 1 ? 'end' : 'middle'}
                        >
                            {label.label}
                        </SvgText>
                    ))}
                </Svg>
            ) : null}
            {!hasData && width > 0 ? (
                <Text className="absolute inset-x-0 top-1/2 -translate-y-2 text-center text-[12px] text-ink-muted dark:text-inkd-muted">
                    还没有数据，写满一周就有一条线
                </Text>
            ) : null}
        </Animated.View>
    );
}

