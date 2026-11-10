import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideClose, LucideSearch } from '@/core/icons';
import * as db from './db';
import { useArchiveRevision, useArchiveStore, type TripCard } from './store';
import { parseBlocks, previewText, type JournalRow } from './journal-logic';
// 事件结果：store.searchEvents 返回已装饰行（decorateEvent 在 store 内统一做，
// 与 /events 列表同口径），此处只消费 Event 类型与状态片。
import { type Event } from './event-logic';
import { addDaysLocal, formatDateParts, formatTripSpan, todayLocal, tripDayList } from './trip-logic';
import { Calendar, type CalendarDayMark } from './ui/calendar';
import { EventStatusChip } from './ui/event-card';
import {
    DateInput,
    isDateInputComplete,
    LoadingView,
    ScreenHeader,
    TripBadge,
    usePalette,
} from './ui';

/**
 * 独立搜索页（DEV.md #5）：关键词 + 时间范围 + 日历点选 → 分组的笔记/行程/事件结果。
 *
 * 三种检索输入的合并语义（单一出口 runSearch）：
 * - 关键词：标题/正文（笔记）、标题/描述（行程）、标题/描述/对象/处理人（事件）LIKE；
 * - 时间范围分段（全部/近7天/近30天/自定义）：约束搜索窗口；
 * - 日历选中日：比范围更具体的「单日窗口」{ from: d, to: d }，选中即覆盖分段范围
 *   （点分段或清空关键词不动它；再点同日反选）；关键词可与之叠加。
 *
 * 事件通道（自 /events 页内搜索迁入，与笔记/行程同口径）：仅关键词驱动——
 * db.searchEvents 无时间范围参数（日期窗口对工单域不可用），空关键词直接短路
 * 不发起查询（db 层对空关键词查询返回空，工单没有「按日期列全部」的语义）。
 *
 * 可靠性口径（沿用 me 页旧 SearchSection 的成规）：300ms 防抖 + 请求序号守卫
 * （慢的旧 in-flight 响应不得覆盖新结果）+ 错误上浮 store.error 通道（store
 * search 方法自身已接通道，屏内 catch 只兜 store 之外的异常）。
 *
 * 性能口径（#15）：日历整体 memo（marks/useCallback 稳定引用，输入打字不重渲日历）；
 * 打点数据一次取用（journalDates + 行程区间派生），月份切换不触发任何数据请求。
 */

type RangeMode = 'all' | 'recent7' | 'recent30' | 'custom';

const RANGE_OPTIONS: Array<{ key: RangeMode; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'recent7', label: '近7天' },
    { key: 'recent30', label: '近30天' },
    { key: 'custom', label: '自定义' },
];

interface SearchResults {
    journals: JournalRow[];
    trips: TripCard[];
    /** 事件结果（store 层已装饰：statusLabel/preview/timeline 齐备）。 */
    events: Event[];
}

export function SearchScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const trips = useArchiveStore((s) => s.trips);
    const revision = useArchiveRevision();

    const [query, setQuery] = useState('');
    const [rangeMode, setRangeMode] = useState<RangeMode>('all');
    const [customFrom, setCustomFrom] = useState('');
    const [customTo, setCustomTo] = useState('');
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [results, setResults] = useState<SearchResults | null>(null);
    const [searching, setSearching] = useState(false);
    // #12/#13：无边框搜索框——border 零，底色用接近色（surface），聚焦切 raised（亮度变化）
    const [inputFocused, setInputFocused] = useState(false);

    // ─── 日历打点数据 ────────────────────────────────────────────────────────
    // 笔记打点：db.journalDates（最近 400 个有笔记的日期，装饰性数据足够）；
    // 行程打点：store.trips 区间派生（store 响应式，增删行程自动跟手）。
    // 打点加载失败只降级为「无点」：不打断搜索主流程，也不占用全局 error 通道
    // （搜索本身的错误才走 store.error）。
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

    // 选中日 = 单日窗口，覆盖分段范围（更具体者胜；再点同日反选在 setter 里做）
    const handleSelectDate = useCallback((date: string) => {
        setSelectedDate((prev) => (prev === date ? null : date));
    }, []);
    const handlePickRangeMode = useCallback((mode: RangeMode) => {
        // 分段与选中日互斥：点分段 = 放弃单日窗口，回到范围语义
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

    // ─── 搜索执行：300ms 防抖 + 序号守卫 ─────────────────────────────────────
    const searchSeq = useRef(0);
    const runSearch = useCallback(async (keyword: string, searchRange: { from?: string; to?: string }) => {
        const seq = ++searchSeq.current;
        setSearching(true);
        try {
            const [journals, foundTrips, foundEvents] = await Promise.all([
                useArchiveStore.getState().searchJournals(keyword, searchRange),
                useArchiveStore.getState().searchTrips(keyword, searchRange),
                // 事件通道仅关键词驱动：db.searchEvents 无时间范围参数，日期窗口
                // 对工单域不可用；空关键词短路（db 层空关键词查询恒返回空，不发起）
                keyword.length > 0
                    ? useArchiveStore.getState().searchEvents(keyword, {})
                    : Promise.resolve<Event[]>([]),
            ]);
            if (seq !== searchSeq.current) return; // 期间已有更新的查询，丢弃本次结果
            setResults({ journals, trips: foundTrips, events: foundEvents });
        } catch (caught) {
            if (seq !== searchSeq.current) return;
            setResults(null);
            // store 两个 search 方法已接 error 通道；这里兜 store 之外的异常
            useArchiveStore.setState({
                error: `搜索失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            if (seq === searchSeq.current) setSearching(false);
        }
    }, []);

    useEffect(() => {
        const keyword = query.trim();
        const selected = selectedDate;
        // 三无输入（无关键词、无选中日、无范围）：不发起无界查询，回邀请态；
        // 序号自增作废仍在途的旧响应
        if (!keyword && !selected && !range.from && !range.to) {
            searchSeq.current += 1;
            setResults(null);
            setSearching(false);
            return;
        }
        const searchRange = selected ? { from: selected, to: selected } : range;
        const timer = setTimeout(() => {
            void runSearch(keyword, searchRange);
        }, 300);
        return () => clearTimeout(timer);
    }, [query, range, selectedDate, runSearch]);

    // 键盘「搜索」键：立即执行（不等 300ms）。若防抖定时器随后再触发同一输入，
    // 结果恒等且有序号守卫，仅一次冗余查询、无可见副作用
    const handleSubmit = useCallback(() => {
        const selected = selectedDate;
        void runSearch(query.trim(), selected ? { from: selected, to: selected } : range);
    }, [query, range, selectedDate, runSearch]);

    // ─── 结果行跳转 ──────────────────────────────────────────────────────────
    const openJournal = useCallback(
        (id: string) => router.push({ pathname: '/journal/[id]', params: { id } }),
        [router],
    );
    const openTrip = useCallback(
        (id: string) => router.push({ pathname: '/trip/[id]', params: { id } }),
        [router],
    );
    // 事件详情跳转：与 /events 列表同口径（typedRoutes 路由联合未含 /events/[id]
    // 时以 `as never` 最小妥协，类型生成后可整体删除）
    const openEvent = useCallback(
        (id: string) => router.push(`/events/${id}` as never),
        [router],
    );

    if (!ready) return <LoadingView />;

    const hasResults =
        results !== null &&
        (results.journals.length > 0 || results.trips.length > 0 || results.events.length > 0);

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader title="搜索" subtitle="按关键词与日期搜索" />
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
                            placeholder="搜索笔记、行程与事件"
                            placeholderTextColor={palette.muted}
                            value={query}
                            onChangeText={setQuery}
                            onFocus={() => setInputFocused(true)}
                            onBlur={() => setInputFocused(false)}
                            onSubmitEditing={handleSubmit}
                            returnKeyType="search"
                            accessibilityLabel="搜索关键词"
                        />
                        {searching ? <ActivityIndicator size="small" color={palette.spinner} /> : null}
                        {query.length > 0 ? (
                            // 命中核算：视觉 24px + hitSlop 10 = 44；左右邻（spinner/输入框）
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

                    {/* 日历：打点 = 有笔记（强 accent）/ 行程日（弱 accent）；点选联动结果。
                        卡体无边框（#13 收敛：surface-on-base tone 分层，同 me 曲线卡） */}
                    <View className="mt-3 rounded-card bg-ink-surface p-3 dark:bg-inkd-surface">
                        <Calendar marks={marks} selected={selectedDate} onSelectDate={handleSelectDate} />
                    </View>

                    {/* 全局错误通道（store.error）：搜索失败上浮于此 */}
                    {error ? (
                        <Text className="mt-3 text-[12px] text-ink-negative dark:text-inkd-negative">{error}</Text>
                    ) : null}

                    {/* 结果区：三态（邀请 / 无匹配 / 分组结果） */}
                    {results === null ? (
                        <View className="items-center py-12">
                            <View className="mb-3 h-11 w-11 items-center justify-center rounded-full bg-ink-surface dark:bg-inkd-surface">
                                <LucideSearch size={20} color={palette.faint} />
                            </View>
                            <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                搜点什么吧
                            </Text>
                            <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                                输入关键词，或点选日历里有记录的日期
                            </Text>
                        </View>
                    ) : !hasResults ? (
                        <View className="items-center py-12">
                            <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                没有匹配的日记、行程或事件
                            </Text>
                            <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                                换个关键词，或放宽时间范围再试
                            </Text>
                        </View>
                    ) : (
                        <>
                            {results.journals.length > 0 ? (
                                <View className="mt-5">
                                    <ResultSectionHeader label="笔记" count={results.journals.length} />
                                    <View className="gap-2">
                                        {results.journals.map((row) => (
                                            <JournalResultRow
                                                key={row.id}
                                                row={row}
                                                onPress={() => openJournal(row.id)}
                                            />
                                        ))}
                                    </View>
                                </View>
                            ) : null}
                            {results.trips.length > 0 ? (
                                <View className="mt-5">
                                    <ResultSectionHeader label="行程" count={results.trips.length} />
                                    <View className="gap-2">
                                        {results.trips.map((trip) => (
                                            <TripResultRow
                                                key={trip.id}
                                                trip={trip}
                                                onPress={() => openTrip(trip.id)}
                                            />
                                        ))}
                                    </View>
                                </View>
                            ) : null}
                            {results.events.length > 0 ? (
                                <View className="mt-5">
                                    <ResultSectionHeader label="事件" count={results.events.length} />
                                    <View className="gap-2">
                                        {results.events.map((event) => (
                                            <EventResultRow
                                                key={event.id}
                                                event={event}
                                                onPress={() => openEvent(event.id)}
                                            />
                                        ))}
                                    </View>
                                </View>
                            ) : null}
                        </>
                    )}
                </ScrollView>
            </View>
        </View>
    );
}

/** 分组标题（用户旧需求「Notes:/xingcheng:」的正规化）：组名 + 计数。 */
function ResultSectionHeader({ label, count }: { label: string; count: number }) {
    return (
        <View className="mb-2 flex-row items-baseline gap-1.5">
            <Text className="text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">{label}</Text>
            <Text className="text-[11px] text-ink-muted dark:text-inkd-muted" style={{ fontVariant: ['tabular-nums'] }}>
                {count}
            </Text>
        </View>
    );
}

/** 笔记行：标题（未命名回退首行摘要 / [媒体]）+ 日期；open 状态用 accent 文字标注（数据语义）。 */
function JournalResultRow({ row, onPress }: { row: JournalRow; onPress(): void }) {
    const title =
        row.title && row.title.trim().length > 0
            ? row.title
            : previewText(parseBlocks(row.blocks), 40) || '[媒体]';
    const { monthDay, weekday } = formatDateParts(row.local_date);
    return (
        <Pressable
            onPress={onPress}
            // 行卡无边框（#13 收敛）+ 内边距对齐 Me 页行卡档 px-4 py-3（同层级同值）；
            // 标题 font-medium 对齐行程行/Me 行标题字重（同层级同值）
            className="flex-row items-center gap-2.5 rounded-control bg-ink-surface px-4 py-3 active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={`笔记：${title}，${monthDay}`}
        >
            <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                    {title}
                </Text>
                <Text
                    className="mt-0.5 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {monthDay} {weekday}
                </Text>
            </View>
            {row.status === 'open' ? (
                <Text className="text-[11px] font-medium text-ink-accent dark:text-inkd-accent">进行中</Text>
            ) : null}
        </Pressable>
    );
}

/** 行程行：TripBadge（图标唯一呈现组件）+ 标题 + 持续性安全区间文案。 */
function TripResultRow({ trip, onPress }: { trip: TripCard; onPress(): void }) {
    return (
        <Pressable
            onPress={onPress}
            // 行卡无边框 + px-4 py-3：与笔记行 / Me 页行卡同一行语言（一致性收敛轮）
            className="flex-row items-center gap-3 rounded-control bg-ink-surface px-4 py-3 active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={`行程：${trip.title}`}
        >
            <TripBadge icon={trip.icon} size="detail" />
            <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                    {trip.title}
                </Text>
                <Text
                    numberOfLines={1}
                    className="mt-0.5 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {formatTripSpan(trip)}
                </Text>
            </View>
        </Pressable>
    );
}

/** 事件行（工单语义，自 /events 页内搜索迁入）：状态片（EventStatusChip，与
 *  事件卡同源组件）+ 标题/摘要/时间线三段——EventCard 解剖的搜索行压缩版，
 *  摘要空则整体退化为标题 + 时间线两段。时间线短口径：编辑过报更新时刻、
 *  否则报创建时刻（eventTimeline 语义，不渲染假更新位）。 */
function EventResultRow({ event, onPress }: { event: Event; onPress(): void }) {
    const timelineText = event.timeline.edited
        ? `更新 ${event.timeline.updatedText}`
        : `创建 ${event.timeline.createdText}`;
    return (
        <Pressable
            onPress={onPress}
            // 行卡无边框 + px-4 py-3：与笔记行 / 行程行同一行语言（同层级同值）；
            // a11y label 带状态语义（进行中/已完成/已失败）
            className="flex-row items-center gap-3 rounded-control bg-ink-surface px-4 py-3 active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={`事件：${event.title}，${event.statusLabel}`}
        >
            <EventStatusChip status={event.status} />
            <View className="min-w-0 flex-1">
                <Text numberOfLines={1} className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                    {event.title}
                </Text>
                {event.preview ? (
                    <Text
                        numberOfLines={1}
                        className="mt-0.5 text-[12px] text-ink-secondary dark:text-inkd-secondary"
                    >
                        {event.preview}
                    </Text>
                ) : null}
                <Text
                    className="mt-0.5 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {timelineText}
                </Text>
            </View>
        </Pressable>
    );
}
