import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideBell, LucideClose, LucideFlag, LucideSearch } from '@/core/icons';
import * as db from './db';
// 全量列表走 db.listEvents 直读（store.searchEvents 空 keyword 且无状态会拒绝
// 无界全量——db 层语义，屏层按查询形态分流，见 fetchEvents 注）；装饰统一走
// event-logic.decorateEvent（列表与搜索共用同一装饰口径，避免两处漂移）。
import { decorateEvent, type Event, type EventStatus } from './event-logic';
import { useArchiveRevision, useArchiveStore } from './store';
import { EmptyState, LoadingView, ScreenHeader, usePalette } from './ui';
import { EventCard } from './ui/event-card';
// 设置卡共享组件（详情屏状态头同款）：不进详情页改元信息/删除——落库通道经
// 回调注入（组件不 import store，RenameCard 先例），屏层实现 updateEventMeta
// + db.getEvent 权威回读。
import { EventSettingsCard } from './ui/event-settings-card';

/**
 * 事件列表页（/events，工单式容器）：
 *
 * - **检索形态**：顶部搜索框（FieldInput 视觉口径：rounded-control 近色底 +
 *   聚焦「加深一档」，复制 search 页已验证的盒子几何）+ 状态筛选分段
 *   （全部/进行中/已完成，单选轨道语言与 Me 外观分段 / search 范围分段同构）；
 * - **可靠性口径**（沿用 me/search 页成规）：300ms 防抖 + 请求序号守卫（慢的
 *   旧 in-flight 响应不得覆盖新结果）；revision 驱动的重载走同一防抖通道
 *   （mutation 后 300ms 内重查一次，序号守卫保证后到者胜）；
 * - **查询分流**（单一出口 fetchEvents）：无关键词且「全部」= 全量列表语义 →
 *   db.listEvents 直读（store.searchEvents 对无界全量返回空，db 层纪律）；
 *   有关键词或状态筛选 → store.searchEvents（错误走 store.error 通道上浮）；
 * - **列表主体**：工单时间线卡流（updated_at DESC 排序由 db 层保证），EventCard
 *   自带时间线轴 + 节点（状态上色）；点卡 → /events/[id]；
 * - **空态即邀请**（frontend-design）：无事件 = EmptyState + CTA「新建事件」；
 *   有筛选/关键词但无匹配 = 卡片化降级 + 「清除筛选」动作（解释发生了什么、
 *   给出下一步，而不是空白）。
 *
 * typedRoutes：/events 与 /events/new 尚未进 .expo/types 的路由联合（本组不跑
 * Metro，不生成类型）——`as never` 最小妥协先例（me 页 SearchEntryCard 同口径），
 * 类型生成后可整体删除。
 */

/** 状态筛选词表：'all' = 全量（不传 status），其余直通 EventStatus。 */
type EventStatusFilter = 'all' | EventStatus;

const FILTER_OPTIONS: Array<{ key: EventStatusFilter; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'open', label: '进行中' },
    { key: 'done', label: '已完成' },
];

export function EventsScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const revision = useArchiveRevision();

    const [query, setQuery] = useState('');
    const [statusFilter, setStatusFilter] = useState<EventStatusFilter>('all');
    const [inputFocused, setInputFocused] = useState(false);
    // 检索结果（null = 首载未完成 → LoadingView；[] = 已查无果 → 空态分流）
    const [results, setResults] = useState<Event[] | null>(null);
    const [searching, setSearching] = useState(false);

    // ─── 检索执行：300ms 防抖 + 序号守卫（search 页同款）────────────────────
    const fetchSeq = useRef(0);
    const fetchEvents = useCallback(async (keyword: string, filter: EventStatusFilter) => {
        const seq = ++fetchSeq.current;
        setSearching(true);
        try {
            // 查询形态分流：无关键词 + 全部 = 全量列表（db 直读）；否则走
            // store.searchEvents（status 传 'all' 时下传空 filter）
            const rows =
                !keyword && filter === 'all'
                    ? (await db.listEvents()).map(decorateEvent)
                    : await useArchiveStore.getState().searchEvents(
                          keyword,
                          filter === 'all' ? {} : { status: filter },
                      );
            if (seq !== fetchSeq.current) return; // 期间已有更新的查询，丢弃本次结果
            setResults(rows);
        } catch (caught) {
            // db 直读路径的异常兜底（store.searchEvents 自带 error 通道）；序号
            // 过期的失败不覆盖新结果
            if (seq !== fetchSeq.current) return;
            setResults([]);
            useArchiveStore.setState({
                error: `事件列表读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            if (seq === fetchSeq.current) setSearching(false);
        }
    }, []);

    // 检索输入 + revision 单通道：防抖 300ms 后执行（revision 重载延迟 300ms
    // 可接受——mutation 的落库本就异步，序号守卫保证时序正确）
    useEffect(() => {
        const timer = setTimeout(() => {
            void fetchEvents(query.trim(), statusFilter);
        }, 300);
        return () => clearTimeout(timer);
    }, [query, statusFilter, revision, fetchEvents]);

    // 键盘「搜索」键立即执行（不等防抖）：与 search 页同口径，结果恒等且有序号
    // 守卫，防抖定时器随后重复触发仅一次冗余查询、无可见副作用
    const handleSubmit = useCallback(() => {
        void fetchEvents(query.trim(), statusFilter);
    }, [query, statusFilter, fetchEvents]);

    /** 空态卡「清除筛选」（有筛选/关键词但无匹配的出路）。 */
    const clearFilters = useCallback(() => {
        setQuery('');
        setStatusFilter('all');
    }, []);

    // ─── 长按设置卡（EventSettingsCard 共享组件，详情屏同款回调契约）──────────
    // 卡片长按 → settingsEvent 持该装饰行；点卡进详情与长按设置并存（长按后
    // Pressability 不补发 onPress）。保存成功**不关卡**（连续编辑多字段），
    // 关闭 = onClose / scrim / Android 返回键（组件内既有出口）。
    const [settingsEvent, setSettingsEvent] = useState<Event | null>(null);

    /**
     * 设置卡元信息落库通用链：updateEventMeta → 成功后 db.getEvent 权威回读 →
     * settingsEvent 换装饰行（卡内 GPS/时间线只读位即时刷新，不滞留旧值）。
     * 列表侧 revision 已由 store bump，既有 300ms 防抖通道自会刷新，这里不重复
     * 拉列表；回读失败不回滚保存本体（下次打开按 DB 校正）。false = 失败（卡内
     * errorText 就地可重试）。
     */
    const saveSettingsMeta = useCallback(
        async (
            eventId: string,
            patch: Parameters<ReturnType<typeof useArchiveStore.getState>['updateEventMeta']>[1],
        ): Promise<boolean> => {
            const ok = await useArchiveStore.getState().updateEventMeta(eventId, patch);
            if (!ok) return false;
            try {
                const fresh = await db.getEvent(eventId);
                if (fresh) setSettingsEvent(decorateEvent(fresh));
            } catch {
                // 权威回读失败保留当前行（保存已确认），不阻塞卡内编辑流
            }
            return true;
        },
        [],
    );

    /** 设置卡删除：级联软删成功 → 关卡（列表项经 revision 防抖通道消失）。 */
    const deleteSettingsEvent = useCallback(async (eventId: string): Promise<boolean> => {
        const ok = await useArchiveStore.getState().deleteEvent(eventId);
        if (ok) setSettingsEvent(null);
        return ok;
    }, []);

    /** 设置卡错误上浮（定位失败等 store 外异常 → store.error 通道，详情屏
     *  surfaceError 同语义；errorText 与屏头错误横幅同帧可见）。 */
    const surfaceSettingsError = useCallback((message: string) => {
        useArchiveStore.setState({ error: message });
    }, []);

    if (!ready || results === null) return <LoadingView />;

    const filtered = query.trim().length > 0 || statusFilter !== 'all';

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader title="事件" subtitle="要跟的事记成工单，按最近活动排列" />
                <FlatList
                    data={results}
                    keyExtractor={(item) => item.id}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                    // 阅读列宽约束（mx-auto + max-w-[560px]）：与 Me/search 同口径；
                    // 底部留白取 FAB 让位口径（+96，对齐 journal-edit 画布底部基线，
                    // 末卡不被悬浮钮顶穿）
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 96,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 560,
                    }}
                    ListHeaderComponent={
                        // pb-4(16dp)：header 与列表主体的净距（trip-detail
                        // ListHeader 末块 mb-4 同规）。必须挂 header 根而非 chips
                        // 行——error 横幅是 chips 之后的条件末块，挂 chips 会漏掉
                        // 「横幅→首卡」零间距变体。缺它则首卡面与筛选轨道同为
                        // surface 底色零间距粘连（卡片压 chips 观感），时间线轴
                        // inset-y-0 也从 chips 底边起笔（CDP 实测 rect：chips
                        // bottom == 首卡 row/轴顶，gap=0）
                        <View className="pb-4">
                            {/* 搜索框（FieldInput 视觉口径：border 零 + 近色底
                                rounded-control，聚焦亮度一档变化，#12/#13） */}
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
                                    placeholder="搜标题、描述、对象或处理人…"
                                    placeholderTextColor={palette.muted}
                                    value={query}
                                    onChangeText={setQuery}
                                    onFocus={() => setInputFocused(true)}
                                    onBlur={() => setInputFocused(false)}
                                    onSubmitEditing={handleSubmit}
                                    returnKeyType="search"
                                    accessibilityLabel="搜索事件"
                                />
                                {searching ? (
                                    <ActivityIndicator size="small" color={palette.spinner} />
                                ) : null}
                                {query.length > 0 ? (
                                    // 命中核算：视觉 24px + hitSlop 10 = 44；左右邻
                                    // （spinner/输入框）均非命中元素，无重叠核算项
                                    <BouncyPressable
                                        onPress={() => setQuery('')}
                                        scaleTo={0.85}
                                        hitSlop={10}
                                    >
                                        <View className="h-6 w-6 items-center justify-center">
                                            <LucideClose
                                                size={16}
                                                strokeWidth={1.9}
                                                color={palette.muted}
                                            />
                                        </View>
                                    </BouncyPressable>
                                ) : null}
                            </View>
                            {/* 状态筛选分段（单选轨道：选中「加深一档」raised，与
                                Me 外观分段 / search 范围分段同一轨道语言） */}
                            <View className="mt-3 flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                                {FILTER_OPTIONS.map((option) => {
                                    const active = statusFilter === option.key;
                                    return (
                                        <Pressable
                                            key={option.key}
                                            onPress={() => setStatusFilter(option.key)}
                                            // 分段本体 h-9(36) < 44：纵向 hitSlop 4 补足；
                                            // 横向必须归 0——相邻分段 gap-1(4) < 2×hitSlop
                                            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                                            // 条件类铁律：两侧变量集合恒等（bg-色 全携带
                                            // --tw-bg-opacity，无 transparent 侧）
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
                            {error ? (
                                // store.error 通道（搜索/列表读取失败等）统一在此可见
                                <Text className="mt-3 text-[12px] text-ink-negative dark:text-inkd-negative">
                                    {error}
                                </Text>
                            ) : null}
                        </View>
                    }
                    ListEmptyComponent={
                        filtered ? (
                            // 有筛选/关键词但无匹配：卡片化降级 + 出路动作（frontend-design：
                            // 失败与空态是方向，不是情绪）
                            <View className="mt-3 rounded-card bg-ink-surface p-4 dark:bg-inkd-surface">
                                <View className="flex-row items-center gap-3">
                                    <View className="h-10 w-10 items-center justify-center rounded-control bg-ink-raised dark:bg-inkd-raised">
                                        <LucideSearch
                                            size={18}
                                            strokeWidth={1.9}
                                            color={palette.secondary}
                                        />
                                    </View>
                                    <View className="min-w-0 flex-1">
                                        <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                            没有匹配的事件
                                        </Text>
                                        <Text
                                            numberOfLines={1}
                                            className="mt-0.5 text-[12px] text-ink-muted dark:text-inkd-muted"
                                        >
                                            换个关键词，或清掉状态筛选再试
                                        </Text>
                                    </View>
                                </View>
                                <View className="mt-3">
                                    <BouncyPressable onPress={clearFilters} scaleTo={0.97}>
                                        <View
                                            className="h-11 items-center justify-center rounded-control border border-ink-border bg-ink-base dark:border-inkd-border dark:bg-inkd-base"
                                            accessibilityRole="button"
                                            accessibilityLabel="清除筛选"
                                        >
                                            <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                                                清除筛选
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                </View>
                            </View>
                        ) : (
                            // 全量空态：EmptyState 邀请（一行是什么 + 一行怎么做 + 动作）。
                            // FlatList 内无 flex-1 高度上下文，min-h 包装给出垂直居中的
                            // 呼吸空间（min-height 内 flex 生效）
                            <View className="min-h-[420px] flex-1 items-center justify-center">
                                <EmptyState
                                    icon={
                                        <LucideBell
                                            size={40}
                                            color={palette.muted}
                                            strokeWidth={1.5}
                                        />
                                    }
                                    title="还没有事件"
                                    hint="建一张工单，把要跟的事记下来。"
                                    actionLabel="新建事件"
                                    onAction={() => router.push('/events/new' as never)}
                                />
                            </View>
                        )
                    }
                    renderItem={({ item }) => (
                        <EventCard
                            event={item}
                            onPress={() => router.push(`/events/${item.id}` as never)}
                            // 长按弹设置卡（不进详情改元信息/删除）；长按后松手
                            // 不补发 onPress（Pressability 语义，天然二选一）
                            onLongPress={() => setSettingsEvent(item)}
                        />
                    )}
                    // 空态在 EmptyState/卡片层兜住（FlatList 空数据时
                    // ListEmptyComponent 渲染在 header 之下，无需额外占位）
                />
                {/* 新建事件 FAB（工单容器的第一动作）：与 journal-edit 的 + 罗盘
                    同位同几何（right-6，bottom = insets.bottom + 24），Icon 换 Flag
                    ——点击直达创建页 */}
                <View
                    className="absolute right-6 z-10"
                    style={{ bottom: insets.bottom + 24 }}
                    pointerEvents="box-none"
                >
                    <BouncyPressable
                        onPress={() => router.push('/events/new' as never)}
                        scaleTo={0.88}
                    >
                        <View
                            className="h-14 w-14 items-center justify-center rounded-full"
                            style={{ backgroundColor: palette.primaryBtn }}
                            accessibilityRole="button"
                            accessibilityLabel="新建事件"
                        >
                            <LucideFlag size={22} color={palette.onPrimaryBtn} strokeWidth={2.2} />
                        </View>
                    </BouncyPressable>
                </View>
                {/* 长按设置卡（scrim + 居中卡，条件渲染禁 RN Modal）：errorText =
                    store.error 反应式（与屏头横幅同通道）；onSaveSubject 保持
                    详情屏的原子对写法（kind null = 显式清除整对，归一在 store） */}
                {settingsEvent ? (
                    <EventSettingsCard
                        event={settingsEvent}
                        onSaveTitle={(value) => saveSettingsMeta(settingsEvent.id, { title: value })}
                        onSaveStatus={(status) => saveSettingsMeta(settingsEvent.id, { status })}
                        onSaveGps={(gps) => saveSettingsMeta(settingsEvent.id, { gps })}
                        onSaveHandledBy={(value) => saveSettingsMeta(settingsEvent.id, { handledBy: value })}
                        onSaveSubject={(kind, value) =>
                            saveSettingsMeta(settingsEvent.id, {
                                subjectKind: kind,
                                subjectValue: kind === null ? null : value,
                            })
                        }
                        onSaveDescription={(value) => saveSettingsMeta(settingsEvent.id, { description: value })}
                        onDelete={() => deleteSettingsEvent(settingsEvent.id)}
                        onSurfaceError={surfaceSettingsError}
                        onClose={() => setSettingsEvent(null)}
                        errorText={error}
                    />
                ) : null}
            </View>
        </View>
    );
}
