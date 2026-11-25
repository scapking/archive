import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, FlatList, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
// RNGH 3.x 正典 API：usePanGesture（hooks 版声明式手势，仲裁下沉 native
// detector 层）；Gesture.Pan 旧类在 3.x 已标 deprecated，不再引入。
import {
    GestureDetector,
    GestureHandlerRootView,
    usePanGesture,
    type PanGestureConfig,
} from 'react-native-gesture-handler';
// scheduleOnRN 是 Reanimated 4 中 runOnJS 的继任（react-native-worklets），
// 只在松手判定时一次性回 JS——切档不跟手（内容不随手指位移），手势更新
// 期间零 JS 工作，onDeactivate 一次判定即收。
import { scheduleOnRN } from 'react-native-worklets';
import { BouncyPressable, LucideBell, LucideFlag } from '@/core/icons';
import * as db from './db';
// 全量列表走 db.listEvents 直读（store.searchEvents 空 keyword 且无状态会拒绝
// 无界全量——db 层语义，屏层按查询形态分流，见 fetchEvents 注）；装饰统一走
// event-logic.decorateEvent（列表与搜索共用同一装饰口径，避免两处漂移）。
import {
    decorateEvent,
    type Event,
    type EventStatus,
    type EventSubjectKind,
} from './event-logic';
import { useArchiveRevision, useArchiveStore } from './store';
import { EmptyState, LoadingView, PAPER_CARD_SHADOW, ScreenHeader, Segmented, usePalette } from './ui';
import { EventCard } from './ui/event-card';
// 设置卡共享组件（详情屏状态头同款）：不进详情页改元信息（事件不可删除，
// 卡内无删除入口）——落库通道经回调注入（组件不 import store，RenameCard
// 先例），屏层实现 updateEventMeta + db.getEvent 权威回读。
import { EventSettingsCard } from './ui/event-settings-card';

/**
 * 事件列表页（/events，工单式容器）：
 *
 * - **筛选双通道（同一状态源）**：顶部状态四分段 chips（全部/进行中/已完成/
 *   已失败，默认进行中）点击切换 + 整屏内容区横滑切换（声明式仲裁 + 松手
 *   判定切档，向左 = 下一档、向右 = 上一档，到头即停不回绕；分段是
 *   「全量 → 活跃 → 完结」的语义序而非周期序列，回绕会让末档滑一步跳回
 *   全量、方向感失真；chips 分段控件本身也不回绕，心智一致）；
 * - **手势裁决（声明式，native 层竞速）**：activeOffsetX ±24dp 水平先达即
 *   激活、failOffsetY ±28dp 垂直先超才让位滚动——RNGH 3.x native detector
 *   层竞速判定，无 JS 往返；28dp 垂直容忍覆盖自然斜滑。f968404 用
 *   manualActivation 在 JS 线程手工判定 + 14dp 垂直容忍，斜滑极易先触发
 *   垂直 fail、JS 忙时判定又迟到，真机「任意区域滑不动」即此二者叠加；
 *   未决阶段不阻塞原生滚动（native 手势并行 track，pan 激活才取消滚动），
 *   Expo Go（RNGH bundled）可用；
 * - **手势域（整屏内容区）**：GestureHandlerRootView + GestureDetector 包住
 *   屏头 + chips + 列表，任意区域起手可滑（局部根容器嵌套仍是 RNGH 官方
 *   用法，不碰全局 _layout）；FAB / 设置卡 scrim 是域外兄弟节点；左缘 24dp
 *   负 hitSlop 收缩手势命中区，iOS 系统返回手势不被截胡（纯声明式，不混用
 *   manualActivation——后者会把整条仲裁拉回 JS 线程）；
 * - **松手切档（不跟手）**：内容容器**不随手指位移**（7304fbc 的跟手平移层
 *   已移除——用户口径「切换时页面结构不动，只有内容更新与移动」；跟手层
 *   会让 chips/屏头/卡框架整体平移，与预期相悖），页面结构在拖动期间恒静。
 *   激活（±24dp）只代表手势成立，不触发切档；松手（onDeactivate）一次性
 *   判定：|translationX| > 48dp（慢拖意图线，激活线 24 的两倍——手已离屏，
 *   阈值放宽避免误切）或 |velocityX| > 500dp/s（flick 速度线，轻扫快甩都算）
 *   二选一即切 ±1 档（目标档出界不切，与 chips 不回绕语义一致），否则无动作
 *   ——无回弹动画必要（没有跟手位移就没有回弹对象）。判定选松手侧而非激活
 *   即切：激活即切（24dp 一到就换内容）会把手势成立误当切换意图，轻斜滑
 *   误触率高，且与「卡片不动、内容更新」的心智不符——松手判定给意图确认，
 *   flick 由速度线兜住，手感稳。手势更新期间无 JS/Reanimated 逐帧工作，
 *   onDeactivate 一次回 JS（scheduleOnRN）；
 * - **切换过渡**：切档时列表内容 12dp 平移 + 淡入（RN Animated，仅 transform/
 *   opacity + useNativeDriver: true，只在状态切换时播放），方向随档位序
 *   （index 增 = 自右进入——松手切档同向，pager 心智一致）；chips/屏头框架
 *   不动，只有 FlatList 内容层过渡；动画容器（过渡层）与触摸容器
 *  （GestureDetector 宿主 View）分离，手势命中坐标不被动画 transform 偏移；
 *   连滑竞态：stopAnimation + setValue 打断在跑动画重设起点 + fetch 层序号
 *   守卫，最终态恒一致；
 * - **搜索职责已迁出**（合并至 /search 事件结果区，与计划/行程同口径）：本页
 *   只剩状态筛选维度，无关键词检索面（页头以留白收敛，不加线不加新元素）；
 * - **可靠性口径**（沿用 me/search 页成规）：300ms 防抖 + 请求序号守卫（慢的
 *   旧 in-flight 响应不得覆盖新结果）；revision 驱动的重载走同一防抖通道
 *   （mutation 后 300ms 内重查一次，序号守卫保证后到者胜）；
 * - **查询分流**（单一出口 fetchEvents）：'全部' = 全量列表语义 → db.listEvents
 *   直读（store.searchEvents 对无界全量返回空，db 层纪律）；其余状态 →
 *   store.searchEvents（空关键词 + 状态 = 纯筛选查询，db 层允许；错误走
 *   store.error 通道上浮）；
 * - **列表主体**：工单时间线卡流（updated_at DESC 排序由 db 层保证），EventCard
 *   自带时间线轴 + 节点（状态上色）；点卡 → /events/[id]；
 * - **空态即邀请**（frontend-design）：无事件 = EmptyState + CTA「新建事件」；
 *   有筛选但无匹配 = 卡片化降级 + 「清除筛选」动作。
 */

/** 状态筛选词表：'all' = 全量（不传 status），其余直通 EventStatus。 */
type EventStatusFilter = 'all' | EventStatus;

/** 设置卡元信息 patch 类型（store.updateEventMeta 第二参）：saveCardMeta 单点
 *  通道复用，与 store 层签名同源（不复制字段面，store 扩字段零改动）。 */
type EventMetaPatch = Parameters<
    ReturnType<typeof useArchiveStore.getState>['updateEventMeta']
>[1];

/** 筛选四分段（需求口径：全部 / 进行中 / 已完成 / 已失败；默认进行中不变）。 */
const FILTER_OPTIONS: Array<{ key: EventStatusFilter; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'open', label: '进行' },
    { key: 'done', label: '完成' },
    { key: 'failed', label: '失败' },
];

/** 横滑激活阈值（dp）：水平位移先达 ±此值即激活（native 层与 failOffsetY 竞速）。
 *  激活只代表手势成立（让位滚动），不触发切档——切档在松手侧判定。 */
const SWIPE_ACTIVATE_X_DP = 24;
/** 垂直容忍（dp）：垂直位移先超 ±此值手势 fail 让位列表滚动。28dp 覆盖自然
 *  斜滑（24dp 水平内斜至 ~49° 仍判横滑），判定在 native orchestrator 完成。 */
const SWIPE_FAIL_Y_DP = 28;
/** 左缘让位带宽（dp）：负 hitSlop 收缩手势命中区——起手在此带内手势域不覆盖，
 *  iOS 系统返回手势（屏幕左缘横移）不被截胡；纯声明式，无 JS 判定时序。 */
const SWIPE_EDGE_GUARD_DP = 24;
/** 松手切档位移线（dp）：松手时 |translationX| 超此值即切档（慢拖意图线，
 *  激活线 24 的两倍——手已离屏、无跟手位移可看，阈值放宽避免误切）。 */
const SWIPE_COMMIT_X_DP = 48;
/** 松手切档速度线（dp/s）：位移或速度二选一，轻扫快甩（flick）也切档。 */
const SWIPE_COMMIT_VELOCITY_DP_S = 500;
/** 切换动画内容平移量（dp，4dp 网格）：轻量方向感，不浮夸。 */
const SWAP_SLIDE_DP = 12;
/** 切换动画时长（ms）：数据 300ms 防抖到达前动画已收尾，不抢数据的戏。 */
const SWAP_DURATION_MS = 160;

export function EventsScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const revision = useArchiveRevision();

    const [statusFilter, setStatusFilter] = useState<EventStatusFilter>('open');
    // 检索结果（null = 首载未完成 → LoadingView；[] = 已查无果 → 空态分流）
    const [results, setResults] = useState<Event[] | null>(null);
    // 页头副标已删（2026-11-19 简洁化口径：屏头描述性副标全线退役）

    // ─── 检索执行：300ms 防抖 + 序号守卫（search 页同款）────────────────────
    const fetchSeq = useRef(0);
    const fetchEvents = useCallback(async (filter: EventStatusFilter) => {
        const seq = ++fetchSeq.current;
        try {
            // 查询形态分流：'全部' = 全量列表（db 直读）；其余状态走
            // store.searchEvents（空关键词 + status = 纯筛选查询）
            const rows =
                filter === 'all'
                    ? (await db.listEvents()).map(decorateEvent)
                    : await useArchiveStore.getState().searchEvents('', { status: filter });
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
        }
    }, []);

    // 状态筛选 + revision 单通道：防抖 300ms 后执行（revision 重载延迟 300ms
    // 可接受——mutation 的落库本就异步，序号守卫保证时序正确）
    useEffect(() => {
        const timer = setTimeout(() => {
            void fetchEvents(statusFilter);
        }, 300);
        return () => clearTimeout(timer);
    }, [statusFilter, revision, fetchEvents]);

    /** 空态卡「清除筛选」（有筛选但无匹配的出路）。 */
    const clearFilters = useCallback(() => {
        setStatusFilter('all');
    }, []);

    // ─── 横滑切换筛选（chips 点击共用的同一状态源 setStatusFilter）────────────
    /** 横滑切档：按 FILTER_OPTIONS 顺序 ±1 步，到头即停（分段语义不回绕）。 */
    const swipeFilter = useCallback((dir: 1 | -1) => {
        setStatusFilter((prev) => {
            const idx = FILTER_OPTIONS.findIndex((option) => option.key === prev);
            const next = idx + dir;
            if (next < 0 || next >= FILTER_OPTIONS.length) return prev;
            return FILTER_OPTIONS[next].key;
        });
    }, []);

    // 手势裁决改声明式（RNGH 3.x native detector 层竞速判定，无 JS 往返）：
    // - activeOffsetX ±24dp 水平先达 → 激活（手势成立，让位判定收口）；
    // - failOffsetY ±28dp 垂直先超 → fail 让位 FlatList 垂直滚动。两条 offset
    //   是「谁先到谁赢」的竞速制（f968404 的 manualActivation 是 JS 线程顺序
    //   判定：14dp 容忍过紧 + 判定迟到，是「滑不动」的根因）；
    // - hitSlop left 负值收缩命中区：手势域自左缘内缩 24dp 让位 iOS 系统返回
    //   手势。不混用 manualActivation——那会把整条仲裁拉回 JS 线程。
    // 未决阶段原生滚动照常并行；pan 激活即由 native 层取消 FlatList 滚动。
    // 切档不跟手：无 onUpdate（内容不随手指位移，拖动期间零 JS/动画工作），
    // 松手 onDeactivate 一次性判定（见顶部「松手切档」注）。
    const filterIndex = FILTER_OPTIONS.findIndex((option) => option.key === statusFilter);
    const swipeGesture = usePanGesture(
        useMemo<PanGestureConfig>(
            () => ({
                maxPointers: 1,
                activeOffsetX: [-SWIPE_ACTIVATE_X_DP, SWIPE_ACTIVATE_X_DP],
                failOffsetY: [-SWIPE_FAIL_Y_DP, SWIPE_FAIL_Y_DP],
                hitSlop: { left: -SWIPE_EDGE_GUARD_DP },
                onDeactivate: (event) => {
                    'worklet';
                    // 松手判定：canceled（系统手势/取消接管）不切档；位移
                    //（> 48dp 意图线）或速度（> 500dp/s flick 线）二选一即切
                    // ±1 档，目标档出界（首档右滑/末档左滑）不切——与 chips
                    // 不回绕语义一致。切档走 swipeFilter 函数式更新，连滑时
                    // 旧回调携带过期 filterIndex 也只会 ±1 步，无越权跳档。
                    // 无跟手位移故无回弹对象，未达阈值即无动作。
                    if (!event.canceled) {
                        const dir: 1 | -1 = event.translationX < 0 ? 1 : -1;
                        const target = filterIndex + dir;
                        const committed =
                            Math.abs(event.translationX) > SWIPE_COMMIT_X_DP ||
                            Math.abs(event.velocityX) > SWIPE_COMMIT_VELOCITY_DP_S;
                        if (committed && target >= 0 && target < FILTER_OPTIONS.length) {
                            scheduleOnRN(swipeFilter, dir);
                        }
                    }
                },
            }),
            [filterIndex, swipeFilter],
        ),
    );

    // ─── 切换过渡动画（12dp 平移 + 淡入，仅 transform/opacity + native driver）
    // 值域：-12..0..+12，0 = 就位（translateX 归零 + 全不透明）；方向 = 档位序
    // （index 增 → 内容自右进入；横滑松手切档同向——chips/屏头框架不动，只有
    // 列表内容层做此过渡，pager 心智一致）。swapAnim 共享单值：连滑时
    // setValue 打断旧动画重设起点，最终态恒一致（fetch 层另有 300ms 防抖 +
    // 序号守卫）。filterIndex 在手势段已算好（worklet 闭包要用）。
    const swapAnim = useRef(new Animated.Value(0)).current;
    const prevFilterIndexRef = useRef(filterIndex);
    const listRef = useRef<FlatList<Event> | null>(null);

    useEffect(() => {
        const prev = prevFilterIndexRef.current;
        if (prev === filterIndex) return; // 初次挂载 / 同值重渲：无动画
        prevFilterIndexRef.current = filterIndex;
        const from = filterIndex > prev ? SWAP_SLIDE_DP : -SWAP_SLIDE_DP;
        swapAnim.stopAnimation();
        swapAnim.setValue(from);
        Animated.timing(swapAnim, {
            toValue: 0,
            duration: SWAP_DURATION_MS,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
        }).start();
        // 切档后回到列表顶（新档位从头读，滚动位置不跨档位保留）
        listRef.current?.scrollToOffset({ offset: 0, animated: false });
    }, [filterIndex, swapAnim]);

    // 动画容器样式（只 transform/opacity，挂 Animated.View 不与触摸容器同节点）
    const swapStyle = {
        flex: 1,
        opacity: swapAnim.interpolate({
            inputRange: [-SWAP_SLIDE_DP, 0, SWAP_SLIDE_DP],
            outputRange: [0, 1, 0],
            extrapolate: 'clamp',
        }),
        transform: [{ translateX: swapAnim }],
    };

    // ─── 长按设置卡（EventSettingsCard 共享组件，详情屏同款回调契约）──────────
    // 卡片长按 → settingsEvent 持该装饰行；点卡进详情与长按设置并存（长按后
    // Pressability 不补发 onPress）。保存成功**不关卡**（连续编辑多字段），
    // 关闭 = onClose / scrim / Android 返回键（组件内既有出口）。事件不可
    // 删除（产品口径）：无 onDelete 通道，store.deleteEvent 数据层能力保留
    // 仅 UI 不暴露。
    const [settingsEvent, setSettingsEvent] = useState<Event | null>(null);
    // 当前卡事件 id 的 ref 镜像（render 期同步，detail 屏 blocksRef 同款口径）：
    // 稳定回调在闭包外读当前 id——卡经 memo 包裹，内联箭头回调会让 memo 失效
    //（父屏 revision 风暴时整卡被拖着重渲，滚动掉帧主因之一）。
    const settingsEventIdRef = useRef<string | null>(null);
    settingsEventIdRef.current = settingsEvent?.id ?? null;

    /**
     * 设置卡元信息落库通用链：updateEventMeta → 成功后 db.getEvent 权威回读 →
     * settingsEvent 换装饰行（卡内 GPS/时间线只读位即时刷新，不滞留旧值）。
     * 列表侧 revision 已由 store bump，既有 300ms 防抖通道自会刷新，这里不重复
     * 拉列表；回读失败不回滚保存本体（下次打开按 DB 校正）。false = 失败（卡内
     * errorText 就地可重试）。
     */
    const saveSettingsMeta = useCallback(
        async (eventId: string, patch: EventMetaPatch): Promise<boolean> => {
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

    /**
     * 设置卡回调稳定化（memo 生效前提）：saveCardMeta 读 ref 镜像的当前事件
     * id（卡开着才有值，闭包恒最新）；各字段薄包装经 useCallback 固化引用，
     * 直传 EventSettingsCard——父屏任意 re-render 不换引用，卡不被拖着重渲。
     */
    const saveCardMeta = useCallback(
        (patch: EventMetaPatch): Promise<boolean> => {
            const eventId = settingsEventIdRef.current;
            return eventId ? saveSettingsMeta(eventId, patch) : Promise.resolve(false);
        },
        [saveSettingsMeta],
    );
    const saveCardTitle = useCallback(
        (value: string) => saveCardMeta({ title: value }),
        [saveCardMeta],
    );
    const saveCardStatus = useCallback(
        (status: EventStatus) => saveCardMeta({ status }),
        [saveCardMeta],
    );
    const saveCardGps = useCallback(
        (gps: { lat: number; lng: number; accuracy?: number } | null) => saveCardMeta({ gps }),
        [saveCardMeta],
    );
    const saveCardHandledBy = useCallback(
        (value: string) => saveCardMeta({ handledBy: value }),
        [saveCardMeta],
    );
    const saveCardSubject = useCallback(
        (kind: EventSubjectKind | null, value: string) =>
            saveCardMeta({ subjectKind: kind, subjectValue: kind === null ? null : value }),
        [saveCardMeta],
    );
    const saveCardDescription = useCallback(
        (value: string) => saveCardMeta({ description: value }),
        [saveCardMeta],
    );
    const closeSettings = useCallback(() => setSettingsEvent(null), []);

    /** 设置卡错误上浮（定位失败等 store 外异常 → store.error 通道，详情屏
     *  surfaceError 同语义；errorText 与屏头错误横幅同帧可见）。 */
    const surfaceSettingsError = useCallback((message: string) => {
        useArchiveStore.setState({ error: message });
    }, []);

    if (!ready || results === null) return <LoadingView />;

    const filtered = statusFilter !== 'all';

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 横滑手势域（整屏内容区）：屏头 + chips + 列表都在内，任意
                    区域起手可滑。局部根容器嵌套仍是 RNGH 官方用法（不碰全局
                    _layout）；FAB / 设置卡 scrim 是域外兄弟节点，触摸互不影响 */}
                <GestureHandlerRootView style={{ flex: 1 }}>
                    <GestureDetector gesture={swipeGesture}>
                        {/* 触摸容器（无动画 style）：与内层动画容器分离，手势
                            命中坐标不被动画 transform 偏移 */}
                        <View className="flex-1">
                            <ScreenHeader title="事件" />
                            {/* 过渡层（仅状态切换时播放，只 transform/opacity）：
                                切档不跟手——内容容器不随手指位移，拖动期间
                                chips/屏头/卡框架恒静（用户口径「卡片不动，只有
                                内容更新和移动」）。静态 flex:1 撑满屏头以下 */}
                            <Animated.View style={swapStyle}>
                                <FlatList
                                    ref={listRef}
                                    data={results}
                                    keyExtractor={(item) => item.id}
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
                                            {/* 状态筛选分段（v0.4.6 收口到 ui/segmented row 档）：
                                                四段等分全部/进行/完成/失败，选中 = 滑块浮起 + 近距
                                                投影（方向令 §1 光影语言，替换旧「加深一档」平色块）。
                                                页内搜索已迁出（职责归 Me 搜索卡），此处以 ScreenHeader
                                                pb-3 + 分段 mt-1 的既有留白节奏收敛，不加线不加元素 */}
                                            <Segmented<EventStatusFilter>
                                                className="mt-1"
                                                density="row"
                                                options={FILTER_OPTIONS}
                                                value={statusFilter}
                                                onChange={setStatusFilter}
                                            />
                                            {error ? (
                                                // store.error 通道（列表读取失败等）统一在此可见：
                                                // 与设置页同款 tinted 横幅（错误是设计面不是裸红行）
                                                <View className="mt-3 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                                                    <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                                        {error}
                                                    </Text>
                                                </View>
                                            ) : null}
                                        </View>
                                    }
                                    ListEmptyComponent={
                                        filtered ? (
                                            // 有筛选但无匹配：卡片化降级 + 出路动作（frontend-design：
                                            // 失败与空态是方向，不是情绪）。图标/文案对齐工单语义
                                            // （页内搜索入口已迁出，不再以 Search 图标指向不存在的能力）
                                            <View
                                                className="mt-3 rounded-card bg-ink-surface p-5 dark:bg-inkd-surface"
                                                style={PAPER_CARD_SHADOW}
                                            >
                                                <View className="flex-row items-center gap-3">
                                                    <LucideFlag
                                                        size={20}
                                                        strokeWidth={1.9}
                                                        color={palette.secondary}
                                                    />
                                                    <View className="min-w-0 flex-1">
                                                        <Text className="text-[16px] text-ink-text dark:text-inkd-text">
                                                            没有匹配的事件
                                                        </Text>
                                                        <Text
                                                            numberOfLines={1}
                                                            className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted"
                                                        >
                                                            切到别的状态，或清掉筛选再试
                                                        </Text>
                                                    </View>
                                                </View>
                                                <View className="mt-4">
                                                    <BouncyPressable onPress={clearFilters} scaleTo={0.97}>
                                                        <View
                                                            className="h-12 items-center justify-center rounded-control bg-ink-base dark:bg-inkd-base"
                                                            style={PAPER_CARD_SHADOW}
                                                            accessibilityRole="button"
                                                            accessibilityLabel="清除筛选"
                                                        >
                                                            <Text className="text-[16px] font-medium text-ink-text dark:text-inkd-text">
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
                                            // 长按弹设置卡（不进详情改元信息）；长按后松手
                                            // 不补发 onPress（Pressability 语义，天然二选一）
                                            onLongPress={() => setSettingsEvent(item)}
                                        />
                                    )}
                                    // 空态在 EmptyState/卡片层兜住（FlatList 空数据时
                                    // ListEmptyComponent 渲染在 header 之下，无需额外占位）
                                />
                            </Animated.View>
                        </View>
                    </GestureDetector>
                </GestureHandlerRootView>
                {/* 新建事件 FAB（工单容器的第一动作）：与 journal-edit 的 + 罗盘
                    同位同几何（right-6，bottom = insets.bottom + 24），Icon 换 Flag
                    ——点击直达创建页。悬浮在手势域之上（域外兄弟节点，z 序更高）：
                    FAB 是精确点位操作，触摸先命中 FAB，天然不参与横滑手势 */}
                <View
                    className="absolute right-6 z-10"
                    style={{ bottom: insets.bottom + 24 }}
                    pointerEvents="box-none"
                >
                    <BouncyPressable
                        onPress={() => router.push('/events/new' as never)}
                        scaleTo={0.88}
                    >
                        {/* v0.4.9 令5：FAB 是屏上真悬浮物，补 PAPER_CARD 柔影
                            （纸×墨纵深：悬浮靠影不靠色，与列表卡同光影档） */}
                        <View
                            className="h-14 w-14 items-center justify-center rounded-full"
                            style={[{ backgroundColor: palette.primaryBtn }, PAPER_CARD_SHADOW]}
                            accessibilityRole="button"
                            accessibilityLabel="新建事件"
                        >
                            <LucideFlag size={22} color={palette.onPrimaryBtn} strokeWidth={2.2} />
                        </View>
                    </BouncyPressable>
                </View>
                {/* 长按设置卡（scrim + 居中卡，条件渲染禁 RN Modal）：errorText =
                    store.error 反应式（与屏头横幅同通道）；回调全部稳定引用直传
                    （memo 卡的生效前提——见 saveCard* 注）；onSaveSubject 保持
                    详情屏的原子对写法（kind null = 显式清除整对，归一在 store）。
                    手机号/邮箱编辑面随 onSavePhone/onSaveEmail 接线才渲染（本
                    入口未接线，不出死编辑面）。事件不可删除：无 onDelete 通道 */}
                {settingsEvent ? (
                    <EventSettingsCard
                        event={settingsEvent}
                        onSaveTitle={saveCardTitle}
                        onSaveStatus={saveCardStatus}
                        onSaveGps={saveCardGps}
                        onSaveHandledBy={saveCardHandledBy}
                        onSaveSubject={saveCardSubject}
                        onSaveDescription={saveCardDescription}
                        onSurfaceError={surfaceSettingsError}
                        onClose={closeSettings}
                        errorText={error}
                    />
                ) : null}
            </View>
        </View>
    );
}
