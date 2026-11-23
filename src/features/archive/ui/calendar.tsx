import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BouncyPressable, LucideBack, LucideChevronRight } from '@/core/icons';
import { parseLocalDate, toLocalDate, todayLocal } from '../trip-logic';
import { usePalette } from './theme';

/**
 * 月历（DEV.md #5 搜索页）：纯 View 网格（无第三方依赖、无 SVG）、无阴影、无渐变，
 * 双主题走 ink/inkd token，颜色只上数据——
 *
 * 标记口径（打点，accent 强度分档）：
 * - 计划日：accent 实心点（强，日记是主内容）；
 * - 行程日：accent 40% 透明点（弱，行程是区间背景信息）；
 * - 双有：两枚点并排。选中片的底色接近黑/白（主行动口径），此时点切换为
 *   accent-bright 保对比度（仍是 accent 家族，不引入新色相）。
 *
 * 交互：点选日期上抛 onSelectDate(date)（「再点同日反选」由调用方实现——
 * 反选语义属于结果联动，不属于日历）；月份切换是日历内部状态，不惊动父级。
 *
 * 性能契约（#15 月份切换不整页重渲）：本组件整体 memo；调用方必须保证
 * marks / onSelectDate 引用稳定（useMemo / useCallback / setState setter），
 * selected 变化时仅受影响的 DayCell 重渲（DayCell 亦 memo，props 全为原始值
 * + 稳定引用的 mark 对象）。月份切换只改本组件内部 state，父级不渲染。
 *
 * 布局口径：周一开始（中文日历惯例）；日期计算一律走 trip-logic 的 UTC 正午
 * Date（铁律：本地日期字符串为准，禁止 UTC 时间戳判断「哪天」）。
 */

/** 单日标记：该日是否有计划 / 是否落在行程区间内。 */
export interface CalendarDayMark {
    journal: boolean;
    trip: boolean;
}

export interface CalendarProps {
    /**
     * 日期（YYYY-MM-DD）→ 标记；只含「有内容」的日期，缺失即空白日。
     * 引用稳定性由调用方 useMemo 保证（memo 失效 = 月份切换整树重渲）。
     */
    marks: ReadonlyMap<string, CalendarDayMark>;
    /** 选中日（YYYY-MM-DD）；null = 未选。 */
    selected: string | null;
    /** 点选回调（再点同日反选由调用方实现）。必须引用稳定（useCallback）。 */
    onSelectDate(date: string): void;
}

/** 周一开局的表头（中文日历惯例；getUTCDay() 周日=0，列号 = (day + 6) % 7）。 */
const WEEKDAY_LABELS_MON = ['一', '二', '三', '四', '五', '六', '日'] as const;

/** 'YYYY-MM-DD' → 'YYYY-MM'。 */
function monthOf(date: string): string {
    return date.slice(0, 7);
}

/** 月份平移（跨年安全，走 UTC 正午 Date，day=1 无月末溢出问题）。 */
function shiftMonth(month: string, delta: number): string {
    const probe = parseLocalDate(`${month}-01`);
    probe.setUTCMonth(probe.getUTCMonth() + delta);
    return toLocalDate(probe).slice(0, 7);
}

/** 当月单元格序列：前置空白（null）补齐周一开局，其余为 'YYYY-MM-DD'。 */
function buildMonthCells(month: string): Array<string | null> {
    const first = parseLocalDate(`${month}-01`);
    const leading = (first.getUTCDay() + 6) % 7;
    // 当月天数：下月 0 号 = 本月最后一天（UTC 语义下天然正确）
    const dayCount = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    const cells: Array<string | null> = [];
    for (let i = 0; i < leading; i += 1) cells.push(null);
    for (let day = 1; day <= dayCount; day += 1) {
        cells.push(`${month}-${String(day).padStart(2, '0')}`);
    }
    return cells;
}

/**
 * 单日格（memo）：props 全为原始值 + 稳定引用，选中/换月时未受影响的格子跳过重渲。
 * hitSlop 核算：格子横向相邻（列间距 8px < 2×hitSlop），hitSlop 必须保持默认 0；
 * 视觉盒即命中盒（≈44px 方格，接近目标尺寸，可接受）。
 */
const DayCell = memo(function DayCell({
    date,
    selected,
    isToday,
    mark,
    onPress,
}: {
    date: string;
    selected: boolean;
    isToday: boolean;
    mark: CalendarDayMark | undefined;
    onPress(date: string): void;
}) {
    // 条件类铁律：三分支变量集合恒等（text-* 同槽位；font-* 不携带 CSS 变量）。
    // 选中 = 近黑/反白主行动底（选择是交互不是数据，不上 accent）；
    // 今天 = accent 数字（今天是数据事实，允许强调色）。
    const numberClass = selected
        ? 'text-[14px] font-semibold text-ink-on-primary-btn dark:text-inkd-on-primary-btn'
        : isToday
          ? 'text-[14px] font-medium text-ink-accent dark:text-inkd-accent'
          : 'text-[14px] font-medium text-ink-text dark:text-inkd-text';
    return (
        <View className="flex-1 items-center px-0.5">
            <Pressable
                onPress={() => onPress(date)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                accessibilityLabel={`${date}${mark?.journal ? '，有计划' : ''}${mark?.trip ? '，有行程' : ''}`}
                // 条件类铁律：两侧变量集合恒等（bg-* 同槽位；active: 变体两侧同串）
                className={
                    selected
                        ? 'aspect-square w-full items-center justify-center rounded-full bg-ink-primary-btn active:bg-ink-primary-btn dark:bg-inkd-primary-btn dark:active:bg-inkd-primary-btn'
                        : 'aspect-square w-full items-center justify-center rounded-full bg-ink-base active:bg-ink-raised dark:bg-inkd-base dark:active:bg-inkd-raised'
                }
            >
                <Text className={numberClass} style={{ fontVariant: ['tabular-nums'] }}>
                    {Number(date.slice(8, 10))}
                </Text>
                {/* 打点行（固定 4px 高，无标记时空占位不塌陷格子节奏） */}
                <View className="mt-0.5 h-1 flex-row items-center gap-0.5">
                    {mark?.journal ? (
                        // 选中片底色接近黑/白，标准 accent 会被埋没 → 换 accent-bright 保对比
                        <View
                            className={`h-1 w-1 rounded-full ${
                                selected
                                    ? 'bg-ink-accent-bright dark:bg-inkd-accent-bright'
                                    : 'bg-ink-accent dark:bg-inkd-accent'
                            }`}
                        />
                    ) : null}
                    {mark?.trip ? (
                        <View
                            className={`h-1 w-1 rounded-full opacity-40 ${
                                selected
                                    ? 'bg-ink-accent-bright dark:bg-inkd-accent-bright'
                                    : 'bg-ink-accent dark:bg-inkd-accent'
                            }`}
                        />
                    ) : null}
                </View>
            </Pressable>
        </View>
    );
});

export const Calendar = memo(function Calendar({ marks, selected, onSelectDate }: CalendarProps) {
    const palette = usePalette();
    // 月份是日历内部状态：切月不触发父级渲染（性能口径见头注）
    const [month, setMonth] = useState(() => monthOf(todayLocal()));
    const today = useMemo(() => todayLocal(), []);
    const rows = useMemo(() => {
        const cells = buildMonthCells(month);
        const out: Array<Array<string | null>> = [];
        for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
        return out;
    }, [month]);
    const monthLabel = useMemo(() => {
        const [y, m] = month.split('-');
        return `${y}年${Number(m)}月`;
    }, [month]);

    const goPrevMonth = useCallback(() => setMonth((prev) => shiftMonth(prev, -1)), []);
    const goNextMonth = useCallback(() => setMonth((prev) => shiftMonth(prev, 1)), []);
    const goToday = useCallback(() => setMonth(monthOf(todayLocal())), []);
    const handlePressDay = useCallback((date: string) => onSelectDate(date), [onSelectDate]);

    return (
        // 宽屏上限：格子 aspect-square 随列宽走，560px 阅读列下会过高，收在 420 居中
        <View className="mx-auto w-full max-w-[420px]">
            {/* 月头。hitSlop 核算：今天(横向 4) + mr-3(12px) ≥ 4 + 8 = 相邻不重叠；
                两个翻月钮间隔 w-4(16px) = 8 + 8，恰好不相交；纵向 8 上下无命中元素 */}
            <View className="mb-1 flex-row items-center">
                <Text
                    className="flex-1 text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {monthLabel}
                </Text>
                <BouncyPressable onPress={goToday} scaleTo={0.92} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
                    {/* 无障碍标注放内层 View（BouncyPressable 不透传 accessibility props） */}
                    <View accessibilityRole="button" accessibilityLabel="回到当前月份" className="mr-3 h-8 items-center justify-center">
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">今天</Text>
                    </View>
                </BouncyPressable>
                <BouncyPressable onPress={goPrevMonth} scaleTo={0.9} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <View accessibilityRole="button" accessibilityLabel="上个月" className="h-8 w-8 items-center justify-center">
                        <LucideBack size={18} strokeWidth={1.9} color={palette.muted} />
                    </View>
                </BouncyPressable>
                <View className="w-4" />
                <BouncyPressable onPress={goNextMonth} scaleTo={0.9} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <View accessibilityRole="button" accessibilityLabel="下个月" className="h-8 w-8 items-center justify-center">
                        <LucideChevronRight size={18} strokeWidth={1.9} color={palette.muted} />
                    </View>
                </BouncyPressable>
            </View>

            {/* 表头 */}
            <View className="mb-1 flex-row">
                {WEEKDAY_LABELS_MON.map((label) => (
                    <Text
                        key={label}
                        className="flex-1 py-1 text-center text-[11px] text-ink-muted dark:text-inkd-muted"
                    >
                        {label}
                    </Text>
                ))}
            </View>

            {/* 日期网格：行距 4px 纵向呼吸（相邻行不共用命中区，hitSlop 保持 0 无冲突） */}
            <View className="gap-1">
                {rows.map((row, rowIndex) => (
                    <View key={rowIndex} className="flex-row">
                        {row.map((date, cellIndex) =>
                            date ? (
                                <DayCell
                                    key={date}
                                    date={date}
                                    selected={selected === date}
                                    isToday={date === today}
                                    mark={marks.get(date)}
                                    onPress={handlePressDay}
                                />
                            ) : (
                                <View key={`blank-${cellIndex}`} className="flex-1 px-0.5">
                                    <View className="aspect-square w-full" />
                                </View>
                            ),
                        )}
                    </View>
                ))}
            </View>
        </View>
    );
});
