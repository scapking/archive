import { memo, useCallback, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { BouncyPressable, LucideBack, LucideChevronRight } from '@/core/icons';
import { todayLocal } from '../trip-logic';
import { inDateRange, monthGrid, monthLabel, monthOf, shiftMonth } from '../calendar-logic';
import { usePalette } from './theme';

/**
 * 月历（DEV.md #5 搜索页 + v0.4.7 行程日期选择弹层共用）：纯 View 网格（无
 * 第三方依赖、无 SVG），双主题走 ink/inkd token，颜色只上数据。
 *
 * 网格/月槽/区间判定的纯逻辑全部收口 calendar-logic.ts（单实现源，node 单测
 * 把关：末行补齐防巨圆、跨年平移、闭区间命中）；本文件只做视图。
 *
 * 标记口径（打点，accent 强度分档；搜索页消费）：
 * - 计划日：accent 实心点（强，日记是主内容）；
 * - 行程日：accent 40% 透明点（弱，行程是区间背景信息）；
 * - 双有：两枚点并排。选中片的底色接近黑/白（主行动口径），此时点切换为
 *   accent-bright 保对比度（仍是 accent 家族，不引入新色相）。
 *
 * 交互：点选日期上抛 onSelectDate(date)（「再点同日反选」由调用方实现——
 * 反选语义属于结果联动，不属于日历）；月份切换是日历内部状态，不惊动父级。
 * v0.4.7 新增（选择器场景，搜索页不传保持旧行为逐 dp 不变）：
 * - `initialMonth`：打开即落在选中日所在月（弹层重挂一次即定槽，非受控）；
 * - `minDate`/`maxDate`：闭区间外禁选（不响应点按 + faint 字色）——「不出错」
 *   在网格层收口，调用方拿到的永远是区间内日期；
 * - `tone`：'page'（默认，格子底 = 页底 ink-base，搜索页原样）/ 'card'
 *   （纸卡/浮层上的日历：格子底 = surface 与宿主卡同色，视觉上「无底」只剩
 *   选中片浮起——settings 卡片语言，禁散写 hex，两侧变量集恒等铁律保持）。
 *
 * 性能契约（#15 月份切换不整页重渲）：本组件整体 memo；调用方必须保证
 * marks / onSelectDate 引用稳定（useMemo / useCallback / setState setter），
 * selected 变化时仅受影响的 DayCell 重渲（DayCell 亦 memo，props 全为原始值
 * + 稳定引用的 mark 对象）。月份切换只改本组件内部 state，父级不渲染。
 *
 * 触控口径（v0.4.7，Apple 日期选择「两步不出错」的硬件底线）：翻月钮视觉盒
 * 升 44（h-11 w-11 圆，hitSlop 归零）；今天钮 32 高 + hitSlop 上下 8 左右 12
 * ≥44；日格 aspect-square 随列宽（≤420 列下 ≥44）。键盘可达性由消费端弹层
 * 的「手输」兜底通道承担（RN Pressable 网格不赌三端 focus 环行为）。
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
    /** 打开时的初始月所在日期（'YYYY-MM-DD'；缺省 = 今天）。非受控：只在
     *  挂载槽位生效（弹层每次打开重新挂载，天然跟随当前值）。 */
    initialMonth?: string | null;
    /** 可选闭区间下界（含）；区间外禁选。 */
    minDate?: string | null;
    /** 可选闭区间上界（含）。 */
    maxDate?: string | null;
    /** 格子底色语境（见头注 'page'/'card' 口径），默认 'page'。 */
    tone?: 'page' | 'card';
}

/** 周一开局的表头（中文日历惯例）。 */
const WEEKDAY_LABELS_MON = ['一', '二', '三', '四', '五', '六', '日'] as const;

/**
 * 单日格（memo）：props 全为原始值 + 稳定引用，选中/换月时未受影响的格子跳过重渲。
 * hitSlop 核算：格子横向相邻（列间距 8px < 2×hitSlop），hitSlop 必须保持默认 0；
 * 视觉盒即命中盒（≈44px 方格，接近目标尺寸，可接受）。
 */
const DayCell = memo(function DayCell({
    date,
    selected,
    isToday,
    disabled,
    tone,
    mark,
    onPress,
}: {
    date: string;
    selected: boolean;
    isToday: boolean;
    /** 区间外（min/max 约束）：不响应点按，字色退 faint。 */
    disabled: boolean;
    tone: 'page' | 'card';
    mark: CalendarDayMark | undefined;
    onPress(date: string): void;
}) {
    // 条件类铁律：分支变量集合恒等（text-* 同槽位；font-* 不携带 CSS 变量）。
    // 选中 = 近黑/反白主行动底（选择是交互不是数据，不上 accent）；
    // 今天 = accent 数字（今天是数据事实，允许强调色）；禁选 = faint（不可达态）。
    const numberClass = selected
        ? 'text-[14px] font-semibold text-ink-on-primary-btn dark:text-inkd-on-primary-btn'
        : disabled
          ? 'text-[14px] font-medium text-ink-faint dark:text-inkd-faint'
          : isToday
            ? 'text-[14px] font-medium text-ink-accent dark:text-inkd-accent'
            : 'text-[14px] font-medium text-ink-text dark:text-inkd-text';
    // 未选中格底色随宿主语境（'page' = 页底；'card' = 浮层纸面）——两侧完整
    // 字面量成对给出，bg/dark:bg/active: 变量槽位集合恒等
    const plainCellClass =
        tone === 'card'
            ? 'aspect-square w-full items-center justify-center rounded-full bg-ink-surface active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised'
            : 'aspect-square w-full items-center justify-center rounded-full bg-ink-base active:bg-ink-raised dark:bg-inkd-base dark:active:bg-inkd-raised';
    return (
        <View className="flex-1 items-center px-0.5">
            <Pressable
                onPress={disabled ? undefined : () => onPress(date)}
                disabled={disabled}
                accessibilityRole="button"
                accessibilityState={{ selected, disabled }}
                accessibilityLabel={`${date}${disabled ? '，不可选' : ''}${mark?.journal ? '，有计划' : ''}${mark?.trip ? '，有行程' : ''}`}
                // 条件类铁律：分支两侧变量集合恒等（bg-* 同槽位；active: 变体两侧同串）
                className={
                    selected
                        ? 'aspect-square w-full items-center justify-center rounded-full bg-ink-primary-btn active:bg-ink-primary-btn dark:bg-inkd-primary-btn dark:active:bg-inkd-primary-btn'
                        : plainCellClass
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

export const Calendar = memo(function Calendar({
    marks,
    selected,
    onSelectDate,
    initialMonth,
    minDate,
    maxDate,
    tone = 'page',
}: CalendarProps) {
    const palette = usePalette();
    // 月份是日历内部状态：切月不触发父级渲染（性能口径见头注）。初槽 = 选中
    // 日所在月（选择器打开即落在正确的月），无选中日落今天所在月。
    const [month, setMonth] = useState(() => {
        const anchor = /^\d{4}-\d{2}-\d{2}$/.test(initialMonth ?? selected ?? '')
            ? (initialMonth ?? selected as string)
            : todayLocal();
        return monthOf(anchor);
    });
    const today = useMemo(() => todayLocal(), []);
    const rows = useMemo(() => monthGrid(month), [month]);
    const label = useMemo(() => monthLabel(month), [month]);

    const goPrevMonth = useCallback(() => setMonth((prev) => shiftMonth(prev, -1)), []);
    const goNextMonth = useCallback(() => setMonth((prev) => shiftMonth(prev, 1)), []);
    const goToday = useCallback(() => setMonth(monthOf(todayLocal())), []);
    const handlePressDay = useCallback((date: string) => onSelectDate(date), [onSelectDate]);

    // 今天按钮在区间外时同样禁按（不出错口径贯穿全网格）
    const todayEnabled = inDateRange(today, minDate, maxDate);

    return (
        // 宽屏上限：格子 aspect-square 随列宽走，560px 阅读列下会过高，收在 420 居中
        <View className="mx-auto w-full max-w-[420px]">
            {/* 月头（v0.4.7 重排）：[‹] 月份 [›] 居中成组 + 尾部「今天」药丸。
                hitSlop 核算：两个翻月钮视觉盒 44×44（h-11 w-11），与居中文案
                之间 gap-1；今天药丸（32 高 + hitSlop 8/12 → ≥44）与翻月钮之间
                有 flex-1 弹垫，命中区互不交叠——钮本体升 44 后 slop 归 0，
                不再依赖旧 8px 停车距核算 */}
            <View className="mb-2 flex-row items-center">
                <BouncyPressable onPress={goPrevMonth} scaleTo={0.9}>
                    <View
                        accessibilityRole="button"
                        accessibilityLabel="上个月"
                        className="h-11 w-11 items-center justify-center rounded-full bg-ink-raised active:opacity-70 dark:bg-inkd-raised"
                    >
                        <LucideBack size={18} strokeWidth={1.9} color={palette.secondary} />
                    </View>
                </BouncyPressable>
                <Text
                    className="min-w-0 flex-1 text-center text-[16px] font-semibold text-ink-text dark:text-inkd-text"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {label}
                </Text>
                <BouncyPressable onPress={goNextMonth} scaleTo={0.9}>
                    <View
                        accessibilityRole="button"
                        accessibilityLabel="下个月"
                        className="h-11 w-11 items-center justify-center rounded-full bg-ink-raised active:opacity-70 dark:bg-inkd-raised"
                    >
                        <LucideChevronRight size={18} strokeWidth={1.9} color={palette.secondary} />
                    </View>
                </BouncyPressable>
                <BouncyPressable onPress={todayEnabled ? goToday : undefined} scaleTo={0.92}>
                    {/* 命中盒 44（h-11 w-12 透明外格）+ 可见药丸 32 内衬：
                        hitSlop 不用负 margin 伪装（负 margin 改布局不改命中） */}
                    <View
                        accessibilityRole="button"
                        accessibilityLabel="回到当前月份"
                        className="ml-1 h-11 w-14 items-center justify-center"
                    >
                        <View className="h-8 items-center justify-center rounded-full bg-ink-raised px-3 dark:bg-inkd-raised">
                            <Text
                                className={`text-[13px] font-medium ${
                                    todayEnabled
                                        ? 'text-ink-secondary dark:text-inkd-secondary'
                                        : 'text-ink-faint dark:text-inkd-faint'
                                }`}
                            >
                                今天
                            </Text>
                        </View>
                    </View>
                </BouncyPressable>
            </View>

            {/* 表头 */}
            <View className="mb-1 flex-row">
                {WEEKDAY_LABELS_MON.map((label2) => (
                    <Text
                        key={label2}
                        className="flex-1 py-1 text-center text-[11px] text-ink-muted dark:text-inkd-muted"
                    >
                        {label2}
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
                                    disabled={!inDateRange(date, minDate, maxDate)}
                                    tone={tone}
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
