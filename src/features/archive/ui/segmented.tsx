import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { PAPER_PILL_SHADOW } from './paper-shadow';

/**
 * 分段控件（v0.4.6 方向文档「大胆重样」C 侧收口，ownership C 行「分段控件」项）：
 *
 * 旧态三处各自实现（settings-screen 私有 CompactSegmented / events 与 search 的
 * 等分 chips 行 / trip-form 的 EndModeSwitch），亮度语言一致但几何与字阶漂移。
 * 本组件收口为**一个解剖两种密度**：
 * - 轨道：rounded-full + raised 一档底（纸面上的浅井，不靠描边靠亮度）；
 * - 滑块：浅档白块 / 深档提亮块 + PAPER_PILL 投影（方向令 §1「层次靠光影」的
 *   最小单位——选中态从「换色」变为「浮起」，深浅两档同语言）；
 * - 字阶：compact 13 / row 15，选中 medium + ink-text，未选 regular + secondary
 *   （方向令 §2 双主题等权；accent 不上 chrome，选中是交互态不是数据）。
 *
 * 两种密度：
 * - `compact`：段宽随文字收缩，用于设置页行尾（主题 / 图片对齐 / App 锁 / 防截屏）
 *   与设置卡；滑块逐段实测宽度 + 前缀和偏移 + spring 平移（旧 CompactSegmented
 *   的实测口径原样保留——Animated 系组件 className 在 web 被 css-interop 静默
 *   丢弃，几何一律内联 style 的仓库铁律同注）。
 * - `row`：等分整行，用于列表筛选 chips / 搜索范围 / 行程结束语义开关
 *   （段间 gap-1 停车距，横向 hitSlop 恒 0 的旧核算不变）。
 */

export type SegmentedDensity = 'compact' | 'row';

export function Segmented<T extends string>({
    options,
    value,
    onChange,
    labelPrefix,
    density = 'compact',
    accessibilityRole = 'button',
    className,
}: {
    options: Array<{ key: T; label: string }>;
    value: T;
    onChange(key: T): void;
    /** 无障碍前缀（「主题：深色模式」——与旧 CompactSegmented 口径一致）。 */
    labelPrefix?: string;
    density?: SegmentedDensity;
    /** 'button' = 筛选/外观分段；'radio' = 表单互斥开关（EndModeSwitch 旧语义）。 */
    accessibilityRole?: 'button' | 'radio';
    /** 外层追加类（宽度/边距职责在调用方，组件只管自身几何）。 */
    className?: string;
}) {
    const [segWidths, setSegWidths] = useState<number[]>([]);
    const placedRef = useRef(false);
    const sliderX = useRef(new Animated.Value(0)).current;
    const activeIndex = Math.max(0, options.findIndex((option) => option.key === value));
    // 逐段实测：offsets = 前缀和（compact 段间零间隙，实测段宽和恒等于轨道内容区宽；
    // row 段间 gap-1(4px) 计入段原点，滑块停在段本体上不含间隙）
    const measured = segWidths.length === options.length && segWidths.every((width) => width > 0);
    let acc = 0;
    const offsets = options.map((_, index) => {
        const offset = acc;
        acc += (segWidths[index] ?? 0) + (density === 'row' ? 4 : 0);
        return offset;
    });
    const segW = measured ? segWidths[activeIndex] : 0;
    useEffect(() => {
        if (!measured) return;
        const target = offsets[activeIndex];
        if (!placedRef.current) {
            placedRef.current = true;
            sliderX.setValue(target);
            return;
        }
        const spring = Animated.spring(sliderX, { toValue: target, friction: 9, useNativeDriver: true });
        spring.start();
        return () => spring.stop();
        // offsets 随 segWidths 派生（O(段数) 每渲染直算），activeIndex 选中变更即重瞄准
    }, [activeIndex, measured, offsets, sliderX]);
    return (
        <View
            className={`flex-row overflow-hidden rounded-full p-1 bg-ink-raised dark:bg-inkd-raised ${className ?? ''}`}
            accessibilityRole={accessibilityRole === 'radio' ? 'radiogroup' : undefined}
        >
            {/* 滑块：纯视觉层先渲染（段落文字浮其上），几何内联 style（Animated
                className web 丢弃铁律），涂装在内层普通 View；实测未就绪时宽 0 不可见。
                深色档用 border(#1E2422) 而非 raised——轨道已是 raised，同色即隐身 */}
            <Animated.View
                pointerEvents="none"
                style={{
                    position: 'absolute',
                    top: 4,
                    bottom: 4,
                    left: 4,
                    width: segW,
                    transform: [{ translateX: sliderX }],
                }}
            >
                <View
                    className="h-full w-full rounded-full bg-ink-base dark:bg-inkd-border"
                    style={PAPER_PILL_SHADOW}
                />
            </Animated.View>
            {options.map((option, index) => {
                const active = value === option.key;
                return (
                    <Pressable
                        key={option.key}
                        onPress={() => onChange(option.key)}
                        // 段本体高 < 44 时纵向 hitSlop 4 补足；横向恒 0（row 段间
                        // gap-1 < 2×hitSlop，外扩会重叠——旧 chips 行核算原样保留）
                        hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                        className={
                            density === 'row'
                                ? 'h-10 flex-1 items-center justify-center rounded-full active:opacity-70 dark:active:opacity-70'
                                : 'h-8 items-center justify-center px-3 active:opacity-70 dark:active:opacity-70'
                        }
                        onLayout={(event) =>
                            setSegWidths((prev) => {
                                const width = event.nativeEvent.layout.width;
                                if (prev[index] === width) return prev;
                                const next = [...prev];
                                next[index] = width;
                                return next;
                            })
                        }
                        accessibilityRole={accessibilityRole}
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={labelPrefix ? `${labelPrefix}：${option.label}` : option.label}
                    >
                        {/* 字阶双档（row 15 / compact 13）+ 选中态（medium/text 色 vs
                            normal/secondary 色）——两侧条件类均为完整字面量，变量集恒等 */}
                        <Text
                            className={`${density === 'row' ? 'text-[15px]' : 'text-[13px]'} ${
                                active
                                    ? 'font-medium text-ink-text dark:text-inkd-text'
                                    : 'font-normal text-ink-secondary dark:text-inkd-secondary'
                            }`}
                        >
                            {option.label}
                        </Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
