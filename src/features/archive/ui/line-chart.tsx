import { useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';
import {
    areaPath,
    linePath,
    niceTicks,
    plotMetrics,
    xLabelPoints,
    type ChartPoint,
} from '../chart-logic';
import { useEffectiveTheme } from './theme';

let GRAD_SEQ = 0;

/**
 * 折线图（app-screens §6 + action 图表纪律）：2px 直线、面积 accent→透明渐变、
 * 3-5 条横网格（grid 令牌双主题）、4 个 x 标签、无图例无数据点。空数据显示空框。
 */
export function LineChart({ points, height = 168 }: { points: ChartPoint[]; height?: number }) {
    const [width, setWidth] = useState(0);
    const gradientId = useState(() => `ink-chart-${(GRAD_SEQ += 1)}`)[0];
    const theme = useEffectiveTheme();
    const gridColor = theme === 'dark' ? '#1B211F' : '#ECEEF1';
    const labelColor = theme === 'dark' ? '#7A827F' : '#8B939C';
    const strokeColor = theme === 'dark' ? '#5B9DFF' : '#2563EB';
    const maxV = points.reduce((m, p) => Math.max(m, p.value), 0);
    const { ticks, top } = niceTicks(maxV);
    const m = plotMetrics(points, top, { width, height, lane: 34, foot: 20, head: 12 });
    const labels = xLabelPoints(points, 3);
    const hasData = points.length > 1 && maxV > 0;
    return (
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height }}>
            {width > 0 ? (
                <Svg width={width} height={height}>
                    <Defs>
                        <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <Stop offset="0" stopColor={strokeColor} stopOpacity={0.2} />
                            <Stop offset="1" stopColor={strokeColor} stopOpacity={0.02} />
                        </LinearGradient>
                    </Defs>
                    {ticks.map((tick) => (
                        <Line
                            key={`grid-${tick}`}
                            x1={m.left}
                            x2={width}
                            y1={m.y(tick)}
                            y2={m.y(tick)}
                            stroke={gridColor}
                            strokeWidth={1}
                        />
                    ))}
                    {/* 网格刻度文字 */}
                    {ticks.map((tick) => (
                        <SvgText
                            key={`label-${tick}`}
                            x={m.left - 6}
                            y={m.y(tick) + 3.5}
                            fontSize={9}
                            fill={labelColor}
                            textAnchor="end"
                        >
                            {tick}
                        </SvgText>
                    ))}
                    {hasData ? (
                        <>
                            <Path d={areaPath(points, m)} fill={`url(#${gradientId})`} />
                            <Path d={linePath(points, m)} fill="none" stroke={strokeColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                        </>
                    ) : null}
                    {labels.map((label) => (
                        <SvgText
                            key={`x-${label.index}`}
                            x={m.x(label.index)}
                            y={height - 4}
                            fontSize={9}
                            fill={labelColor}
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
        </View>
    );
}

