import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, NativeEventSubscription, Text, View } from 'react-native';
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

/** 画区留白（4dp 网格）：head 容纳刻度文字（11px，画在顶网格线上方），
    foot 容纳 x 标签（12px），inset 让线端点离边缘一口气，不设左侧刻度栏
    ——刻度文字画在网格线内侧上方，紧凑卡里轴标签栏比线本身更抢版面。 */
const HEAD = 18;
const FOOT = 18;
const INSET = 5;

/** 1px 横线落到半像素，端侧不糊。 */
function snap(v: number): number {
    return Math.round(v) + 0.5;
}

/**
 * 折线图（app-screens §6，2026-11-25 重写）：2px 直线段（逐日字数是离散量，
 * 不做平滑插值）、面积 accent→全透明渐变收口（≤14% 克制档）、基线（0 刻度）
 * 是画区唯一一条重线（border 色）、上方 1-3 条浅网格（grid 色）各带一枚
 * 内侧刻度文字、x 标签按周取样步进落在今日（尾标签写「今天」，其余 MM/DD）。
 * 色全部走 palette（grid/border/muted/accent），无图例无数据点。
 *
 * 空态/全零态诚实呈现：max=0 不编刻度，只画基线 + 引导文案。
 *
 * animated（opt-in，默认 false）：进场整图淡入一拍（420ms ease-out、延迟
 * 260ms），为 Me 页「标题先立、曲线后到」的两拍节奏定制；不传即完全旧行为。
 * 只动 opacity（RN Animated native driver；铁律：Animated style 只许
 * transform/opacity——strokeDashoffset 画线式「描线」需 JS 逐帧驱动，违铁律，
 * 不做）。reduceMotion 命中即落终态（与 me-screen Enter 同口径：异步检测，
 * 最坏代价 = 检测落地前已起播的一拍被截停）。
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
    const [reduceMotion, setReduceMotion] = useState(false);
    const gradientId = useState(() => `ink-chart-${(GRAD_SEQ += 1)}`)[0];
    const palette = getPalette(useEffectiveTheme());
    const maxV = points.reduce((acc, p) => Math.max(acc, p.value), 0);
    const { ticks, top } = niceTicks(maxV);
    const m = plotMetrics(points, top, { width, height, head: HEAD, foot: FOOT, inset: INSET });
    const labels = xLabelPoints(points, 7, 5);
    const hasData = points.length > 1 && maxV > 0;
    const baseY = snap(m.y(0));
    const last = points.length - 1;
    // 淡入进度：opt-in 才从 0 起播；默认档初值即 1（不建时间线，渲染零差异）
    const fade = useRef(new Animated.Value(animated ? 0 : 1)).current;
    useEffect(() => {
        if (!animated) return;
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                // 读不到系统设置 → 按「无减弱」处理（Enter 同款降级）
            });
        // reduceMotion 可能在起播后才报来：事件通道存续期间持续跟随
        let sub: NativeEventSubscription | null = null;
        try {
            sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
        } catch {
            // 事件通道不可用的极端环境：只认首拍检测结果
        }
        return () => {
            cancelled = true;
            sub?.remove();
        };
    }, [animated]);
    useEffect(() => {
        if (!animated) return;
        if (reduceMotion) {
            fade.setValue(1);
            return;
        }
        const anim = Animated.timing(fade, {
            toValue: 1,
            duration: 420,
            delay: 260,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        });
        anim.start();
        return () => anim.stop();
    }, [animated, reduceMotion, fade]);
    return (
        <Animated.View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height, opacity: fade }}>
            {width > 0 ? (
                <Svg width={width} height={height}>
                    <Defs>
                        {/* 面积收口走 objectBoundingBox：自最高点渐变到基线（§6.4 fade 档） */}
                        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <Stop offset="0" stopColor={palette.accent} stopOpacity={0.14} />
                            <Stop offset="1" stopColor={palette.accent} stopOpacity={0} />
                        </LinearGradient>
                    </Defs>
                    {/* 基线（0 刻度）：画区唯一重线，恒画——有数据是轴，无数据是「一条地板」 */}
                    <Line
                        x1={m.left}
                        x2={m.left + m.plotW}
                        y1={baseY}
                        y2={baseY}
                        stroke={palette.border}
                        strokeWidth={1}
                    />
                    {/* 浅网格 + 内侧刻度文字（0 已由基线承担，不重复） */}
                    {ticks
                        .filter((tick) => tick > 0)
                        .map((tick) => {
                            const gy = snap(m.y(tick));
                            return (
                                <Line
                                    key={`grid-${tick}`}
                                    x1={m.left}
                                    x2={m.left + m.plotW}
                                    y1={gy}
                                    y2={gy}
                                    stroke={palette.grid}
                                    strokeWidth={1}
                                />
                            );
                        })}
                    {ticks
                        .filter((tick) => tick > 0)
                        .map((tick) => (
                            <SvgText
                                key={`tick-${tick}`}
                                x={m.left + 4}
                                y={m.y(tick) - 4}
                                fontSize={11}
                                fill={palette.muted}
                            >
                                {tick}
                            </SvgText>
                        ))}
                    {hasData ? (
                        <>
                            <Path d={areaPath(points, m)} fill={`url(#${gradientId})`} />
                            <Path
                                d={linePath(points, m)}
                                fill="none"
                                stroke={palette.accent}
                                strokeWidth={2}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                        </>
                    ) : null}
                    {labels.map((label, li) => (
                        <SvgText
                            key={`x-${label.index}`}
                            x={m.x(label.index)}
                            y={height - 5}
                            fontSize={12}
                            fill={label.index === last ? palette.secondary : palette.muted}
                            textAnchor={li === 0 ? 'start' : label.index === last ? 'end' : 'middle'}
                        >
                            {label.index === last ? '今天' : label.label}
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
