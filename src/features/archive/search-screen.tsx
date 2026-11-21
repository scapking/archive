import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideClose, LucideSearch } from '@/core/icons';
import * as db from './db';
import { useArchiveRevision, useArchiveStore } from './store';
import { addDaysLocal, todayLocal, tripDayList } from './trip-logic';
import { Calendar, type CalendarDayMark } from './ui/calendar';
import { DateInput, isDateInputComplete, LoadingView, ScreenHeader, usePalette } from './ui';

/**
 * 搜索页 = 检索输入枢纽（2026-11-19 搜索拆分）：关键词 + 时间范围分段 + 日历
 * 点选三种检索输入在本页编排，结果区迁至独立结果屏 /search-results/[spec]
 * （结果 deck 与卡面随迁，本页不再渲染任何结果态）。
 *
 * 三种检索输入的合并语义（结果屏按规格消费）：
 * - 关键词：标题/正文（笔记）、标题/描述（行程）、标题/描述/对象/处理人（事件）LIKE；
 * - 时间范围分段（全部/近7天/近30天/自定义）：约束搜索窗口；
 * - 日历选中日：比范围更具体的「单日窗口」{ from: d, to: d }，点日期即跳结果
 *   屏（关键词可与之叠加）；再点同日 = 反选，仅清高亮不跳转。
 *
 * 规格编码（路径参数，web push 丢 query 见 AGENTS.md 偏差表）：spec =
 * 'all'（全量口径）或 encodeURIComponent(JSON.stringify({ q, from?, to? }))；
 * 结果屏解析后调 store.searchTrips/searchJournals/searchEvents——空关键词 =
 * 全量、全状态（store 已实现该口径，2026-11-19 用户指令「默认搜索全部的，
 * 不管什么状态」）。
 *
 * 跳转触发（唯一两个出口）：键盘「搜索」键（handleSubmit）与日历点日期
 * （handleSelectDate）。分段/自定义段只设定窗口不跳转——防打字/换档过程中
 * 反复进出结果页（旧版 300ms 防抖自动查询随结果区一并退役）。
 *
 * 性能口径（#15，沿用）：日历整体 memo（marks/useCallback 稳定引用，输入打字
 * 不重渲日历）；打点数据一次取用（journalDates + 行程区间派生），月份切换不
 * 触发任何数据请求；打点加载失败只降级「无点」，不占 store.error 通道。
 */

type RangeMode = 'all' | 'recent7' | 'recent30' | 'custom';

const RANGE_OPTIONS: Array<{ key: RangeMode; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'recent7', label: '近7天' },
    { key: 'recent30', label: '近30天' },
    { key: 'custom', label: '自定义' },
];

export function SearchScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const ready = useArchiveStore((s) => s.ready);
    const trips = useArchiveStore((s) => s.trips);
    const revision = useArchiveRevision();

    const [query, setQuery] = useState('');
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    // #12/#13：无边框搜索框——border 零，底色用接近色（surface），聚焦切 raised（亮度变化）
    const [inputFocused, setInputFocused] = useState(false);

    // ─── 日历打点数据 ────────────────────────────────────────────────────────
    // 笔记打点：db.journalDates（最近 400 个有笔记的日期，装饰性数据足够）；
    // 行程打点：store.trips 区间派生（store 响应式，增删行程自动跟手）。
    const [journalDates, setJournalDates] = useState<Set<string>>(() => new Set());
    useEffect(() => {
        let alive = true;
        db.journalDates()
            .then((dates) => {
                if (alive) setJournalDates(dates);
            })
            .catch((caught) => {
                if (alive) console.warn('[search] 日历打点加载失败（降级为无点）:', caught);
            });
        return () => {
            alive = false;
        };
    }, [revision]);

    const marks = useMemo<ReadonlyMap<string, CalendarDayMark>>(() => {
        const map = new Map<string, CalendarDayMark>();
        for (const date of journalDates) map.set(date, { journal: true, trip: false });
        const today = todayLocal();
        for (const trip of trips) {
            const markTripDay = (date: string) => {
                const existing = map.get(date);
                map.set(date, { journal: existing?.journal ?? false, trip: true });
            };
            // 固定区间行程：直接用骨架（建站校验已限 ≤366 天，try/catch 防御坏数据）
            try {
                const days = tripDayList(trip);
                if (days) {
                    for (const day of days) markTripDay(day);
                    continue;
                }
            } catch (caught) {
                console.warn('[search] 行程区间展开失败:', caught);
            }
            // 持续性行程（open，tripDayList 返回 null）：出发日到今天逐日打点
            // （今天固定，字符串比较推进，循环必然终止）
            if (trip.start_date <= today) {
                for (let day = trip.start_date; day <= today; day = addDaysLocal(day, 1)) {
                    markTripDay(day);
                }
            }
        }
        return map;
    }, [journalDates, trips]);

    // ─── 检索输入 → 范围参数 ─────────────────────────────────────────────────
    const range = useMemo<{ from?: string; to?: string }>(() => {
        const today = todayLocal();
        if (rangeMode === 'recent7') return { from: addDaysLocal(today, -6) }; // 今天+前 6 天 = 7 天闭区间
        if (rangeMode === 'recent30') return { from: addDaysLocal(today, -29) };
        if (rangeMode === 'custom') {
            // 未填完整的段不参与（store 层会拒绝非法日期并打 error，这里从源头避开）
            return {
                from: isDateInputComplete(customFrom) ? customFrom : undefined,
                to: isDateInputComplete(customTo) ? customTo : undefined,
            };
        }
        return {};
    }, [rangeMode, customFrom, customTo]);

    // ─── 跳转出口（提交 / 点日历）────────────────────────────────────────────
    // → 结果屏：路径参数传规格（见文件头规格编码注）。路由字面量 `as never`：
    // typedRoutes 未生成（仓库既有口径）。
    const pushResults = useCallback(
        (keyword: string, searchRange: { from?: string; to?: string }) => {
            const q = keyword.trim();
            const spec =
                !q && !searchRange.from && !searchRange.to
                    ? 'all'
                    : encodeURIComponent(JSON.stringify({ q, from: searchRange.from, to: searchRange.to }));
            router.push(`/search-results/${spec}` as never);
        },
        [router],
    );

    // 选中日 = 单日窗口：点日期即带窗口跳结果屏（关键词叠加当前输入）；再点
    // 同日 = 反选，仅清除高亮不跳转（检索语义已由上一次跳转表达）
    const handleSelectDate = useCallback(
        (date: string) => {
            if (selectedDate === date) {
                setSelectedDate(null);
                return;
            }
            setSelectedDate(date);
            pushResults(query, { from: date, to: date });
        },
        [selectedDate, query, pushResults],
    );
    const handlePickRangeMode = useCallback((mode: RangeMode) => {
        // 分段与选中日互斥：点分段 = 放弃单日窗口，回到范围语义（不跳转，等提交）
        setRangeMode(mode);
        setSelectedDate(null);
    }, []);

    // 自定义段的行内提示（不占用 store.error：这是输入未完成，不是失败）
    const customHint = useMemo(() => {
        if (rangeMode !== 'custom') return null;
        if (!isDateInputComplete(customFrom) || !isDateInputComplete(customTo)) {
            return '两端日期填完整后生效';
        }
        if (customFrom > customTo) return '起点晚于终点，可能查不到结果';
        return null;
    }, [rangeMode, customFrom, customTo]);

    // 键盘「搜索」键：带当前输入跳结果屏（单日窗口优先于分段范围——更具体者胜，
    // 与拆分前的搜索窗口合并语义一致）
    const handleSubmit = useCallback(() => {
        pushResults(query, selectedDate ? { from: selectedDate, to: selectedDate } : range);
    }, [query, range, selectedDate, pushResults]);

    if (!ready) return <LoadingView />;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 副标已删（2026-11-19 简洁化口径：屏头描述性副标全线退役） */}
                <ScreenHeader title="搜索" />
                {/* 阅读列宽约束（mx-auto + max-w-[560px]）：与 Me 页同口径 */}
                <ScrollView
                    className="mx-auto w-full max-w-[560px]"
                    contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 32 }}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                >
                    {/* 搜索框：border 零 + 近色底 rounded-control，聚焦底色亮度变化（#12/#13）。
                        不 autoFocus：日历是首屏另一价值，不自动弹键盘抢焦点 */}
                    <View
                        className={`h-11 flex-row items-center gap-2 rounded-control px-3 ${
                            inputFocused
                                ? 'bg-ink-raised dark:bg-inkd-raised'
                                : 'bg-ink-surface dark:bg-inkd-surface'
                        }`}
                    >
                        <LucideSearch size={16} strokeWidth={1.9} color={palette.muted} />
                        <TextInput
                            className="h-full min-w-0 flex-1 text-[15px] text-ink-text dark:text-inkd-text"
                            placeholder="搜索日记、笔记、行程与事件"
                            placeholderTextColor={palette.muted}
                            value={query}
                            onChangeText={setQuery}
                            onFocus={() => setInputFocused(true)}
                            onBlur={() => setInputFocused(false)}
                            onSubmitEditing={handleSubmit}
                            returnKeyType="search"
                            accessibilityLabel="搜索关键词"
                        />
                        {query.length > 0 ? (
                            // 命中核算：视觉 24px + hitSlop 10 = 44；左右邻（输入框）
                            // 均非命中元素，与屏边距内无相邻调用点，10 不产生重叠
                            <BouncyPressable onPress={() => setQuery('')} scaleTo={0.85} hitSlop={10}>
                                <View className="h-6 w-6 items-center justify-center">
                                    <LucideClose size={16} strokeWidth={1.9} color={palette.muted} />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>

                    {/* 时间范围分段（选择理由：检索是快进快出流，三段 DateInput×2 = 6 个
                        输入位过重，且半填状态会撞 store 的日期校验；分段把精确输入收进
                        「自定义」显式入口，默认路径零输入成本；样式与 Me 页外观分段同构。
                        轨道无边框 + 选中「加深一档」（raised）：与 ThemeSection /
                        EndModeSwitch 同一轨道与亮度语言（一致性收敛轮）） */}
                    <View className="mt-3 flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                        {RANGE_OPTIONS.map((option) => {
                            const active = rangeMode === option.key;
                            return (
                                <Pressable
                                    key={option.key}
                                    onPress={() => handlePickRangeMode(option.key)}
                                    // 分段本体 h-9(36px) < 44：纵向 hitSlop 4 补足；横向必须归 0
                                    // ——相邻分段 gap-1(4px) < 2×hitSlop，外扩会重叠（Me 页同款核算）
                                    hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                                    // 条件类铁律：两侧变量集合恒等（与 ThemeSection 同款写法）
                                    className={`h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised ${
                                        active
                                            ? 'bg-ink-raised dark:bg-inkd-raised'
                                            : 'bg-ink-surface dark:bg-inkd-surface'
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: active }}
                                >
                                    <Text
                                        className={`text-[12px] ${
                                            active
                                                ? 'font-medium text-ink-text dark:text-inkd-text'
                                                : 'text-ink-muted dark:text-inkd-muted'
                                        }`}
                                    >
                                        {option.label}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>

                    {/* 自定义展开：DateInput 复用（ui 契约），段值未完整不参与查询 */}
                    {rangeMode === 'custom' ? (
                        <View className="mt-2 gap-2">
                            <View className="flex-row items-center gap-2">
                                <Text className="w-5 text-[12px] text-ink-muted dark:text-inkd-muted">起</Text>
                                <View className="min-w-0 flex-1">
                                    <DateInput value={customFrom} onChange={setCustomFrom} placeholder="开始日期" />
                                </View>
                            </View>
                            <View className="flex-row items-center gap-2">
                                <Text className="w-5 text-[12px] text-ink-muted dark:text-inkd-muted">止</Text>
                                <View className="min-w-0 flex-1">
                                    <DateInput value={customTo} onChange={setCustomTo} placeholder="结束日期" />
                                </View>
                            </View>
                            {customHint ? (
                                <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">{customHint}</Text>
                            ) : null}
                        </View>
                    ) : null}

                    {/* 日历：打点 = 有笔记（强 accent）/ 行程日（弱 accent）；点选日期
                        即带单日窗口跳结果屏（再点同日反选仅清高亮）。卡体无边框
                        （#13 收敛：surface-on-base tone 分层，同 me 曲线卡） */}
                    <View className="mt-3 rounded-card bg-ink-surface p-3 dark:bg-inkd-surface">
                        <Calendar marks={marks} selected={selectedDate} onSelectDate={handleSelectDate} />
                    </View>

                    {/* 选中日状态行：跳转语义已表达，这里只交代反选手势 */}
                    {selectedDate ? (
                        <Text className="mt-3 text-center text-[12px] text-ink-secondary dark:text-inkd-secondary">
                            已选 {selectedDate}（再点一次取消）
                        </Text>
                    ) : null}

                    {/* 引导文案（2026-11-19 搜索拆分：结果区迁至 /search-results
                        独立页，本页只做检索输入枢纽——提交或点日历日期即跳转） */}
                    <View className="mt-6 items-center py-10">
                        <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                            输入关键词、选好范围，或点日历里的日期
                        </Text>
                        <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                            点键盘「搜索」或点日历日期，在结果页翻看日记、笔记、行程与事件
                        </Text>
                    </View>
                </ScrollView>
            </View>
        </View>
    );
}
