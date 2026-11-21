import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useArchiveStore, type TripCard } from './store';
import { parseBlocks, previewText, type JournalRow } from './journal-logic';
// 事件结果：store.searchEvents 返回已装饰行（decorateEvent 在 store 内统一做，
// 与 /events 列表同口径），此处只消费 Event 类型与状态片。
import { formatEventDateTime, type Event } from './event-logic';
import { formatDateParts, formatTripSpan, tripDisplayTitle } from './trip-logic';
import { CardDeck, type DeckItem } from './ui';
import { LoadingView, ScreenHeader } from './ui';

/**
 * 搜索结果屏（2026-11-19 搜索拆分：/search 只留检索输入枢纽，结果区迁出为
 * 本独立页，路由壳 /search-results/[spec] 以路径参数传检索规格——web push 丢
 * query，见 AGENTS.md 偏差表，跨屏传参一律路径参数）。
 *
 * 结果口径（与拆分前的 /search 页内结果区完全一致）：
 * - 三通道并行：store.searchJournals / searchTrips / searchEvents；空关键词 =
 *   全量、全状态（store 已实现该口径，2026-11-19 用户指令「默认搜索全部的，
 *   不管什么状态」）；时间范围 { from, to } 只对日记/笔记/行程通道生效——
 *   事件（工单域）无日期窗口语义（db.searchEvents 无范围参数），仅按关键词查；
 * - 结果呈现 = 混合多卡 deck（自 search-screen 原样迁入：deckItems 构建 +
 *   SearchFace 卡面，搬走非复制）：日记 → 笔记 → 行程 → 事件，类型 eyebrow
 *   区分，点前卡进内容；长卡 height 520（/notes、/trips 同款）；卡面全状态
 *   可见（搜索不限完成状态）；
 * - 可靠性口径（沿用拆分前成规）：请求序号守卫（慢的旧 in-flight 响应不得
 *   覆盖新结果）+ 错误上浮 store.error 通道（store search 方法自身已接通道，
 *   屏内 catch 只兜 store 之外的异常）；
 * - 不挂 ready 门（与 /search 页的差别）：三通道全部直查 db（store 方法内部
 *   不依赖 loadAll 预载的 state），冷启深链直达本页也能出结果，不会卡加载态；
 *   规格不变不重查（本页无输入面，结果 = 提交态快照）。
 */

/** 检索规格（路由 [spec] 段的解析产物；q 空串 = 全量全状态）。 */
export interface SearchSpec {
    q: string;
    from?: string;
    to?: string;
}

interface SearchResults {
    journals: JournalRow[];
    trips: TripCard[];
    /** 事件结果（store 层已装饰：statusLabel/preview/timeline 齐备）。 */
    events: Event[];
}

export function SearchResultsScreen({ spec }: { spec: SearchSpec }) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const error = useArchiveStore((s) => s.error);
    // null = 当前规格在途（加载态）；随 spec 变化重置
    const [results, setResults] = useState<SearchResults | null>(null);

    // 请求序号守卫：spec 快速连续变化时，慢的旧响应不得覆盖新结果
    const searchSeq = useRef(0);
    useEffect(() => {
        const seq = ++searchSeq.current;
        const keyword = spec.q.trim();
        setResults(null);
        void (async () => {
            try {
                const [journals, foundTrips, foundEvents] = await Promise.all([
                    useArchiveStore.getState().searchJournals(keyword, { from: spec.from, to: spec.to }),
                    useArchiveStore.getState().searchTrips(keyword, { from: spec.from, to: spec.to }),
                    // 事件通道仅关键词驱动：db.searchEvents 无时间范围参数（日期
                    // 窗口对工单域不可用）；空关键词 = 全量全状态（store 口径）
                    useArchiveStore.getState().searchEvents(keyword, {}),
                ]);
                if (seq !== searchSeq.current) return; // 期间已有更新的查询，丢弃本次结果
                setResults({ journals, trips: foundTrips, events: foundEvents });
            } catch (caught) {
                if (seq !== searchSeq.current) return;
                setResults(null);
                // store 三个 search 方法已接 error 通道；这里兜 store 之外的异常
                useArchiveStore.setState({
                    error: `搜索失败：${caught instanceof Error ? caught.message : String(caught)}`,
                });
            }
        })();
    }, [spec]);

    // 屏头说明小字：把规格翻译成人话（本页唯一的状态说明位；不占 store.error）
    const specLabel = useMemo(() => {
        const parts: string[] = [];
        const q = spec.q.trim();
        if (q) parts.push(`关键词「${q}」`);
        if (spec.from && spec.to) parts.push(`${spec.from} ~ ${spec.to}`);
        else if (spec.from) parts.push(`${spec.from} 起`);
        else if (spec.to) parts.push(`${spec.to} 止`);
        if (parts.length === 0) return '全部日记、笔记、行程与事件（不限关键词、时间与状态）';
        return `${parts.join(' · ')} · 全状态可见`;
    }, [spec]);

    // 日记/笔记拆组（kind 列单一事实源）。**挂在三态渲染之前**（本页无 early
    // return，位置对齐 hooks 纪律以防后续加入门禁时翻车——library 同款教训）；
    // results 未就绪按空集处理（此时渲染不到结果区）。
    const dailyResults = useMemo(
        () => (results?.journals ?? []).filter((row) => row.kind === 'daily'),
        [results],
    );
    const noteResults = useMemo(
        () => (results?.journals ?? []).filter((row) => row.kind === 'note'),
        [results],
    );

    // 结果行跳转（自 search-screen 原样迁入）：日记与笔记共用 journals 表
    // （kind 列区分），路由壳不同：日记 → /journal/[id]（日记模式编辑器），
    // 笔记 → /note/[id]（笔记模式编辑器，无收笔语义）
    const openJournal = useCallback(
        (id: string, kind: 'daily' | 'note') =>
            router.push(
                kind === 'note'
                    ? ({ pathname: '/note/[id]', params: { id } } as never)
                    : { pathname: '/journal/[id]', params: { id } },
            ),
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

    // 结果 → 混合多卡 deck 项（日记 → 笔记 → 行程 → 事件；顺序与首页 deck
    // 同口径，自 search-screen 原样迁入）。
    const deckItems = useMemo<DeckItem[]>(() => {
        const items: DeckItem[] = [];
        for (const row of dailyResults) {
            const { monthDay, weekday } = formatDateParts(row.local_date);
            items.push({
                key: `diary-${row.id}`,
                onPress: () => openJournal(row.id, 'daily'),
                node: (
                    <SearchFace
                        type="日记"
                        status={row.status === 'open' ? '进行中' : '已收笔'}
                        title={row.title?.trim() || previewText(parseBlocks(row.blocks), 40) || '[媒体]'}
                        body={undefined}
                        meta={`${monthDay} ${weekday}`}
                    />
                ),
            });
        }
        for (const row of noteResults) {
            const { monthDay, weekday } = formatDateParts(row.local_date);
            items.push({
                key: `note-${row.id}`,
                onPress: () => openJournal(row.id, 'note'),
                node: (
                    <SearchFace
                        type="笔记"
                        status={row.status === 'open' ? '进行中' : '已收笔'}
                        title={row.title?.trim() || previewText(parseBlocks(row.blocks), 40) || '[媒体]'}
                        body={row.description?.trim() ? row.description : undefined}
                        meta={`${monthDay} ${weekday}`}
                    />
                ),
            });
        }
        for (const trip of results?.trips ?? []) {
            items.push({
                key: `trip-${trip.id}`,
                onPress: () => openTrip(trip.id),
                node: (
                    <SearchFace
                        type="行程"
                        status={TRIP_STATUS_LABELS[trip.status]}
                        title={tripDisplayTitle(trip.title)}
                        body={trip.description.trim() ? trip.description : undefined}
                        meta={`${formatTripSpan(trip)} · 已写 ${trip.journalDays} 天`}
                    />
                ),
            });
        }
        for (const event of results?.events ?? []) {
            items.push({
                key: `event-${event.id}`,
                onPress: () => openEvent(event.id),
                node: (
                    <SearchFace
                        type="事件"
                        status={event.statusLabel}
                        title={event.title}
                        body={event.description ?? undefined}
                        meta={`更新于 ${formatEventDateTime(event.updated_at)}`}
                    />
                ),
            });
        }
        return items;
    }, [dailyResults, noteResults, results, openJournal, openTrip, openEvent]);

    const hasResults =
        results !== null &&
        (results.journals.length > 0 || results.trips.length > 0 || results.events.length > 0);

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头返回 + 说明小字（当前规格的人话翻译；返回回 /search 枢纽） */}
                <ScreenHeader title="搜索结果" subtitle={specLabel} />
                <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
                    {/* 全局错误通道（store.error）：搜索失败上浮于此 */}
                    {error ? (
                        <Text className="px-6 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}

                    {/* 结果三态（加载 / 无匹配 / deck 结果） */}
                    {results === null ? (
                        <LoadingView />
                    ) : !hasResults ? (
                        <View className="items-center px-6 py-12">
                            <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                没有匹配的日记、笔记、行程或事件
                            </Text>
                            <Text className="mt-1.5 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                                回搜索页换个关键词，或放宽时间范围再试
                            </Text>
                        </View>
                    ) : (
                        /* deck 容器与 /notes、/trips 长卡同款（mx-auto 阅读列 + px-6
                            屏边距，24px 单层内边距——不沿用旧搜索页 ScrollView 内
                            双层叠加的 48px 偏心） */
                        <View className="mx-auto w-full max-w-[560px] pt-1">
                            <View className="px-6">
                                <CardDeck items={deckItems} height={520} />
                            </View>
                        </View>
                    )}
                </ScrollView>
            </View>
        </View>
    );
}

/** 行程状态文案（对齐 StatusChip 词表）：搜索卡面 eyebrow 消费（自 search-screen 迁入）。 */
const TRIP_STATUS_LABELS: Record<TripCard['status'], string> = {
    planning: '计划中',
    ongoing: '进行中',
    finished: '回忆',
};

/**
 * 搜索结果卡面（deck 消费，卡壳与页码由 deck 统一绘制；自 search-screen 原样
 * 迁入）：eyebrow = 类型 + 状态（全状态可见——搜索不限完成状态）→ 题 →
 * 描述/预览（可选）→ meta。
 */
function SearchFace({
    type,
    status,
    title,
    body,
    meta,
}: {
    type: '日记' | '笔记' | '行程' | '事件';
    status?: string;
    title: string;
    body?: string;
    meta: string;
}) {
    return (
        <View className="flex-1 flex-col px-6 py-5">
            <Text
                numberOfLines={1}
                className="text-[11px] text-ink-muted dark:text-inkd-muted"
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {status ? `${type} · ${status}` : type}
            </Text>
            <Text numberOfLines={2} className="mt-1 text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                {title}
            </Text>
            {body ? (
                <Text numberOfLines={5} className="mt-2 text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                    {body}
                </Text>
            ) : null}
            <View className="min-h-0 flex-1" />
            <Text
                className="text-[11px] text-ink-muted dark:text-inkd-muted"
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {meta}
            </Text>
        </View>
    );
}
