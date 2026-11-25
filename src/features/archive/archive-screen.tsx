import { useCallback, useEffect, useMemo, useState } from 'react';
import { BackHandler, Image, Pressable, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideBookOpen,
    LucideCalendarX,
    LucideCheck,
    LucideChevronRight,
    LucideClose,
    LucideFlag,
    LucidePencil,
    LucidePlay,
    LucideRoute,
    LucideListPlus,
    LucideTrash,
    LucideType,
} from '@/core/icons';
import { haptics } from '@/core/haptics';
import { useArchiveRevision, useArchiveStore } from './store';
// 数据版本中立层（屏层消费同 me-screen 直连 notify 的先例反向）：deck 数据的
// 刷新信号除 store revision 外还有屏层直连 db 广播的中立计数（计划增/勾/删），
// 两者任一前进都要求 deck 重载（见下方 revision 驱动 loadAll 注）。
import { useDataRevision } from './data-revision';
import * as db from './db';
import type { EventRow, JournalBlock, JournalRow } from './db';
import { formatDateGroupLabel, isEditable, parseBlocks } from './journal-logic';
// 计划纯逻辑（v11）：在堆判定收口派生函数，禁散落 status 字面量比较
import { isPlanOpen } from './plan-logic';
import { PLAN_TITLE_FALLBACK } from './journal-edit-screen';
import {
    formatDateParts,
    formatTripSpan,
    todayLocal,
    tripDisplayTitle,
    tripTodayLabel,
} from './trip-logic';
import { requestViewer } from './viewer-request';
import {
    ActionMenuCard,
    CardDeck,
    CloseButton,
    PAPER_CARD_SHADOW,
    ComposeFab,
    LoadingView,
    ProgressBar,
    RenameCard,
    StatusChip,
    TripBadge,
    useBlockActionGestures,
    useFileUrl,
    useJournalMedia,
    usePalette,
    type ActionMenuRow,
    type DeckItem,
} from './ui';

/**
 * Archive 首页：**动态多卡堆叠**（2026-11-19 用户指令「有多少都在那个卡片
 * 显示，不再固定两张」）——日记（今天）/ 行程 / 事件 / 计划四类实体的活跃项
 * 全部进同一个图片堆（ui/card-pile 共享组件），左右滑动翻看，点前卡进内容
 * （卡序 = 用户优先级指令：日记 > 行程 > 事件 > 计划）。
 * **卡面语言统一（v0.4.6 指令 4/7 重样）**：eyebrow（类型二字 + 最小必要
 * meta）/ 标题或正文 / 底部统计 + CTA 三段式，字阶 16/13/12/11。**行程名
 * 不上卡面**（指令 4：即使命名也不显示，兜底「未命名行程」一并退场——封面/
 * 日期/节奏/统计承担区分，名字只在屏头与详情出现）；「更新于 …」「0 字」类
 * 冗余串退场（指令 7）。见 TripCard / NoteDeckCard / EventDeckCard；首页与
 * /plans、/trips 堆共用 TripCard、NoteDeckCard（library-screen 深取，同
 * DeadEndView 先例）。
 *
 * - **进入口径（完成态不显示，用户指令）**：日记 = 今天不存在或 open（已收笔
 *   不显示）；计划 = 仅 open（v11 计划状态机：closed/failed 离堆、历史在搜索
 *   可见，与事件同口径）；行程 = planning + ongoing（finished 不显示）；
 *   事件 = 仅 open（done/failed 不显示）；
 * - **类型标识（用户指令「卡片要有标识好区分」）**：每张卡 eyebrow 行带类型
 *   前缀（日记/计划/行程/事件）——日记与计划是两个实体（journals.kind 列），
 *   靠 eyebrow 一眼分辨；
 * - **长按菜单**（原 useBlockActionGestures 手势保留在前卡内部；堆的
 *   PanResponder 方向锁只认领水平拖拽，纯点按/长按从不认领，两套手势并存）：
 *   日记卡 → 日记菜单（重命名/完成收笔/删除）；行程卡 → 行程菜单（按卡所属
 *   行程）；计划卡 → 计划菜单（改计划名/标记完成/标记失败/删除计划，v11 对齐
 *   事件四字口径）；事件卡 → 事件菜单（标记完成/标记失败）；
 * - 点卡：日记 → /write；计划 → /plan/[id]；行程 → /trip/[id]；事件 →
 *   /events/[id]。
 *
 * 数据刷新：trip 通道 = store.trips（任一版本前进即重跑 loadAll，既有口径）；
 * 计划/事件通道 = db 直读 + revision 重载（同 library 自持界面取径）；
 * todayJournal = getJournalByDate 既有 effect；行程封面 = 每张行程卡内部
 * useTripCover（原 deckTrip 单查升级为按卡查询，同值短路防重渲）。
 */

/** deck 行程卡数据类型（屏侧组装的 store 装饰行）。 */
type DeckTrip = ReturnType<typeof useArchiveStore.getState>['trips'][number];

/**
 * 行程菜单行（R2）：关闭行程仅进行中可达（end_date 落今天，明日起进入回忆
 * ——当天仍进行中）；编辑仅未锁定（finished 只读，#7）；删除行二次确认 =
 * title 换文案（从简口径：行副标描述全线退役，标题自释）；danger 色机制不变。
 */
function tripMenuRows(trip: DeckTrip, confirmDelete: boolean): ActionMenuRow[] {
    return [
        ...(trip.status === 'ongoing'
            ? [{ key: 'close', icon: <LucideCalendarX size={20} strokeWidth={1.9} />, title: '关闭行程' }]
            : []),
        { key: 'new', icon: <LucideRoute size={20} strokeWidth={1.9} />, title: '新建行程' },
        ...(trip.status !== 'finished'
            ? [{ key: 'edit', icon: <LucidePencil size={20} strokeWidth={1.9} />, title: '编辑行程' }]
            : []),
        {
            key: 'delete',
            icon: <LucideTrash size={16} strokeWidth={1.9} />,
            title: confirmDelete ? '再点一次' : '删除行程',
            danger: true,
        },
    ];
}

/**
 * 日记菜单行（R3，措辞归位 2026-11-19：这堆卡是**日记**——每天一篇的
 * /write 页，不是独立计划，菜单词表全部用「日记」）：重命名/完成收笔仅
 * open 态；删除行二次确认 = title 换文案。
 */
function diaryMenuRows(journal: JournalRow, confirmDelete: boolean): ActionMenuRow[] {
    const open = isEditable(journal.status);
    return [
        ...(open ? [{ key: 'rename', icon: <LucideType size={20} strokeWidth={1.9} />, title: '改日记名' }] : []),
        ...(open ? [{ key: 'complete', icon: <LucideCheck size={20} strokeWidth={1.9} />, title: '完成收笔' }] : []),
        {
            key: 'delete',
            icon: <LucideTrash size={16} strokeWidth={1.9} />,
            title: confirmDelete ? '再点一次' : '删除日记',
            danger: true,
        },
    ];
}

/** 行程卡封面（首图优先、无图取首视频，原 deckTrip 单查升级为按卡查询）：
    同值短路防重渲（#15）；音频不作封面。 */
function useTripCover(tripId: string | null): { kind: 'image' | 'video'; fileKey: string } | null {
    const revision = useArchiveRevision();
    const [cover, setCover] = useState<{ kind: 'image' | 'video'; fileKey: string } | null>(null);
    useEffect(() => {
        if (!tripId) {
            setCover((prev) => (prev === null ? prev : null));
            return;
        }
        let active = true;
        db.listTripMediaByTrip(tripId)
            .then((rows) => {
                if (!active) return;
                const firstImage = rows.find((row) => row.kind === 'image');
                const firstVideo = rows.find((row) => row.kind === 'video');
                const next = firstImage
                    ? { kind: 'image' as const, fileKey: firstImage.file_key }
                    : firstVideo
                        ? { kind: 'video' as const, fileKey: firstVideo.file_key }
                        : null;
                setCover((prev) =>
                    prev?.kind === next?.kind && prev?.fileKey === next?.fileKey ? prev : next,
                );
            })
            .catch(() => {
                if (active) setCover((prev) => (prev === null ? prev : null));
            });
        return () => {
            active = false;
        };
    }, [tripId, revision]);
    return cover;
}

export function ArchiveScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const revision = useArchiveRevision();
    const dataRevision = useDataRevision();
    const palette = usePalette();

    const [todayJournal, setTodayJournal] = useState<JournalRow | null>(null);
    const [chooserOpen, setChooserOpen] = useState(false);
    // 重命名设置卡（日记菜单入口）：非 null = 正在重命名该篇（设置卡挂屏根，
    // 条件渲染 scrim + 居中卡，同 chooser / 块操作卡范式）
    const [renamingJournalId, setRenamingJournalId] = useState<string | null>(null);
    // 行程菜单卡（行程卡长按入口，R2）：tripId 定位目标行程（deck 是多卡堆，
    // 菜单作用于「长按的那一张」）；confirmDelete = 删除行二次确认态
    const [tripMenu, setTripMenu] = useState<{ tripId: string; confirmDelete: boolean } | null>(null);
    // 日记菜单卡（日记卡长按入口，R3）：结构同 tripMenu
    const [journalMenu, setJournalMenu] = useState<{ confirmDelete: boolean } | null>(null);
    // 事件菜单卡（事件卡长按入口）：eventId；标记完成/失败即离堆（open 过滤）
    const [eventMenu, setEventMenu] = useState<string | null>(null);
    // 计划菜单卡（计划卡长按入口）：noteId；重命名复用 RenameCard（updateJournalTitle
    // 对 open 计划有效）、删除复用 deleteJournal（级联删媒体）
    const [planMenu, setNoteMenu] = useState<{ id: string; confirmDelete: boolean } | null>(null);
    // 计划/事件列表（deck 卡数据通道）：null = 首载未完成；revision 驱动重载
    const [notes, setNotes] = useState<JournalRow[] | null>(null);
    const [openEvents, setOpenEvents] = useState<EventRow[] | null>(null);

    // Android 返回键关弹窗（替代 Modal 的 onRequestClose 语义）
    useEffect(() => {
        if (!chooserOpen) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            setChooserOpen(false);
            return true;
        });
        return () => sub.remove();
    }, [chooserOpen]);

    useEffect(() => {
        if (!ready) void loadAll();
    }, [ready, loadAll]);
    useEffect(() => {
        let active = true;
        db.getJournalByDate(null, todayLocal())
            .then((row) => {
                if (active) setTodayJournal(row);
            })
            .catch((caught) => {
                // 中断场景：今天日记读取 reject 不能 unhandled（红屏）也不能静默——
                // 静默会把「读不到」渲染成「今天还没写」，卡片保留上次数据并上浮错误，
                // revision / ready 变化会自动重试
                if (active) {
                    useArchiveStore.setState({
                        error: `今天日记读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [revision, ready]);

    // 数据版本驱动重载（既有口径）：行程数据只在 loadAll 内重建，任何 mutation
    // bump 版本后 store.trips 滞留旧值——任一版本号前进即重跑 loadAll（成本：
    // 行程 CRUD 自带 loadAll，幂等双载 SQLite ms 级）。revision = 0 是启动基线。
    useEffect(() => {
        if (revision > 0 || dataRevision > 0) void loadAll();
    }, [revision, dataRevision, loadAll]);

    // 计划 + 事件（deck 卡数据）：revision 重载（同 library 自持界面取径）。
    // 事件仅 open（done/failed 不进 deck——用户指令「完成的不显示」）。
    useEffect(() => {
        let active = true;
        db.listPlans()
            .then((rows) => {
                if (active) setNotes(rows);
            })
            .catch((caught) => {
                if (active) {
                    setNotes([]);
                    useArchiveStore.setState({
                        error: `计划列表读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [revision]);
    useEffect(() => {
        let active = true;
        db.listEvents({ status: 'open' })
            .then((rows) => {
                if (active) setOpenEvents(rows);
            })
            .catch((caught) => {
                if (active) {
                    setOpenEvents([]);
                    useArchiveStore.setState({
                        error: `事件列表读取失败：${caught instanceof Error ? caught.message : String(caught)}`,
                    });
                }
            });
        return () => {
            active = false;
        };
    }, [revision]);

    const today = todayLocal();
    const journalLabel = formatDateGroupLabel(today, today);

    // deck 卡序列（日记 → 行程 → 事件 → 计划；2026-11-19 用户优先级指令
    // 「优先级最高是日记，其次行程、事件、计划」——计划循环移到末位；完成态
    // 过滤见文件头进入口径）。**useMemo 挂在下方 early return 之前**（hooks
    // 铁律：ready/notes 翻转会改变 hook 数量——library「Rendered more hooks」
    // 同款教训），引用稳定防 deck 层位定位 spring 无意义重跑（#15）。
    const deckItems = useMemo<DeckItem[]>(() => {
        const items: DeckItem[] = [];
        // ① 日记（今天）：不存在 → 邀请卡（原日记空卡样式）；已收笔 → 不显示
        if (!todayJournal) {
            items.push({
                key: 'diary-invite',
                accessibilityLabel: `写今天的日记，${journalLabel.monthDay}`,
                onPress: () => router.push('/write'),
                node: (
                    // 邀请卡（v0.4.6 指令 7 重样）：空态是行动邀请——今天日期升为
                    // 卡面屏题档（24），邀请语 16，CTA 收 accent；笔 icon 轻收尾。
                    <View className="flex-1 flex-col px-7 py-6">
                        <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">日记</Text>
                        <View className="min-h-0 flex-1 justify-center gap-2">
                            <Text className="text-[24px] font-semibold text-ink-text dark:text-inkd-text">
                                {journalLabel.monthDay} {journalLabel.weekday}
                            </Text>
                            <Text className="text-[16px] text-ink-secondary dark:text-inkd-secondary">
                                今天的一页还没写
                            </Text>
                            <View className="mt-1 flex-row items-center">
                                <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                                    开始写
                                </Text>
                                <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                            </View>
                        </View>
                    </View>
                ),
            });
        } else if (isEditable(todayJournal.status)) {
            items.push({
                key: `diary-${todayJournal.id}`,
                accessibilityLabel: '打开日记',
                onPress: () => router.push('/write'),
                onLongPress: () => {
                    haptics.impact('medium');
                    setJournalMenu({ confirmDelete: false });
                },
                node: (
                    <JournalCard
                        journal={todayJournal}
                        label={journalLabel}
                        onOpen={() => router.push('/write')}
                        onRequestMenu={() => {
                            haptics.impact('medium');
                            setJournalMenu({ confirmDelete: false });
                        }}
                    />
                ),
            });
        }
        // ② 行程（planning + ongoing；finished 不显示）
        for (const trip of trips) {
            if (trip.status === 'finished') continue;
            items.push({
                key: `trip-${trip.id}`,
                accessibilityLabel: `打开行程：${tripDisplayTitle(trip.title)}`,
                onPress: () => router.push({ pathname: '/trip/[id]', params: { id: trip.id } }),
                onLongPress: () => {
                    haptics.impact('medium');
                    setTripMenu({ tripId: trip.id, confirmDelete: false });
                },
                node: (
                    <TripCard
                        trip={trip}
                        onOpen={() => router.push({ pathname: '/trip/[id]', params: { id: trip.id } })}
                        onRequestMenu={() => {
                            haptics.impact('medium');
                            setTripMenu({ tripId: trip.id, confirmDelete: false });
                        }}
                    />
                ),
            });
        }
        // ③ 事件（仅 open）
        for (const event of openEvents ?? []) {
            items.push({
                key: `event-${event.id}`,
                accessibilityLabel: `打开事件：${event.title}`,
                onPress: () => router.push(`/events/${event.id}` as never),
                onLongPress: () => {
                    haptics.impact('medium');
                    setEventMenu(event.id);
                },
                node: <EventDeckCard event={event} />,
            });
        }
        // ④ 计划（仅 open——v11 计划状态机：标记完成/失败即离堆，历史在搜索
        // 可见，对齐事件 open 过滤；标题空串兜底；2026-11-19 用户优先级指令：
        // 计划排末位）
        for (const note of notes ?? []) {
            if (!isPlanOpen(note)) continue;
            items.push({
                key: `note-${note.id}`,
                accessibilityLabel: note.title?.trim() ? `打开计划：${note.title}` : '打开未命名计划',
                onPress: () => router.push({ pathname: '/plan/[id]', params: { id: note.id } } as never),
                onLongPress: () => {
                    haptics.impact('medium');
                    setNoteMenu({ id: note.id, confirmDelete: false });
                },
                node: <NoteDeckCard note={note} />,
            });
        }
        return items;
        // today 不入依赖（日内恒定字符串）；journalLabel 由 today 派生同理
    }, [todayJournal, notes, trips, openEvents, journalLabel, palette, router]);

    if (!ready || notes === null || openEvents === null) return <LoadingView />;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头（v0.4.6 字阶纪律：屏题 24 / 正文行 16 / meta 12 / eyebrow 11） */}
                <View className="px-6 pb-1 pt-2">
                    <Text className="text-[24px] font-semibold text-ink-text dark:text-inkd-text">
                        Archive
                    </Text>
                    <Text
                        className="mt-1 text-[16px] text-ink-secondary dark:text-inkd-secondary"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {metrics.streak > 0 ? `连续记录 ${metrics.streak} 天` : '今天的记录都在这里'}
                    </Text>
                    {/* store.error 通道：v0.4.7 令 3 对齐 settings 错误横幅语言
                        （tinted negative-bg 圆角卡，错误是设计面不是贴留白的小字） */}
                    {error ? (
                        <View className="mt-2 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                            <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                {error}
                            </Text>
                        </View>
                    ) : null}
                </View>

                {/* 动态多卡 deck（N 卡泛化：卡片样式/露条交互 = 原 deck 原样；
                    背卡露条点按 = 提前到前位；完成态过滤见文件头）；屏边距 px-6
                    与屏头 / Me / 搜索同一口径；mt-4 顶部间距（既有口径）。
                    v0.4.7 令 1：入口组卡（事件/计划/行程）整块删除——导航职责
                    已在 Me「我的内容」与 tab，首页不留重复入口（保持已删）。
                    高度回滚固定 430，2026-11-25 用户令：v0.4.7 的「吃满屏内
                    剩余高度夹紧 [430,680]」机制退场，CardDeck 回到 v0.4.6 固定
                    卡高（deck.tsx 缺省 height=430 契约）。垂直位置 = 顶对齐
                    （2026-11-19 用户澄清：不是垂直居中）；死白由空态邀请卡
                    （DeckEmptyInvite）与卡面本身承载，不留「补丁卡」。 */}
                <View className="mt-4 px-6">
                    <View className="mx-auto w-full max-w-[560px]">
                        <CardDeck items={deckItems} emptyState={<DeckEmptyInvite />} />
                    </View>
                </View>
            </View>

            <ComposeFab
                onPress={() => {
                    haptics.impact();
                    setChooserOpen(true);
                }}
                accessibilityLabel="新建"
            />

            {/* 重命名设置卡（日记/计划菜单共用入口，共享组件 ui/rename-card）：
                条件渲染 scrim + 居中卡挂屏根（zIndex 50 压过 FAB/deck）。初值按
                renamingJournalId 查目标行（v11 修复计划改名链路：旧实现恒以
                todayJournal 供初值并作为渲染条件——无日记当天计划改名卡弹不出、
                有日记时初值还错拿日记标题）；落库通道经 onSave 注入
                （store.updateJournalTitle，锁定预检 #7 兜底）；Android 返回键
                由卡片自身 BackHandler 关闭（同块操作卡范式）。 */}
            {renamingJournalId
                ? (() => {
                      const target =
                          todayJournal && todayJournal.id === renamingJournalId
                              ? todayJournal
                              : (notes ?? []).find((note) => note.id === renamingJournalId) ??
                                null;
                      if (!target) return null;
                      return (
                          <RenameCard
                              initialTitle={target.title ?? ''}
                              onSave={(title) =>
                                  useArchiveStore.getState().updateJournalTitle(renamingJournalId, title)
                              }
                              onClose={() => setRenamingJournalId(null)}
                              errorText={error}
                          />
                      );
                  })()
                : null}

            {/* 行程菜单卡（行程卡长按入口，R2，共享组件 ui/action-menu-card）：
                菜单作用于长按的那张行程卡（tripId 定位）；关闭行程 = end_date
                落今天；编辑仅未锁定态（finished 只读，#7）；删除经二次确认步。 */}
            {tripMenu ? (
                (() => {
                    const target = trips.find((trip) => trip.id === tripMenu.tripId) ?? null;
                    if (!target) return null;
                    return (
                        <ActionMenuCard
                            title="行程"
                            rows={tripMenuRows(target, tripMenu.confirmDelete)}
                            onAction={(key) => {
                                if (key === 'close') {
                                    haptics.success();
                                    setTripMenu(null);
                                    void useArchiveStore
                                        .getState()
                                        .updateTrip(target.id, { endDate: todayLocal() });
                                    return;
                                }
                                if (key === 'new') {
                                    setTripMenu(null);
                                    router.push('/trip/new');
                                    return;
                                }
                                if (key === 'edit') {
                                    setTripMenu(null);
                                    router.push({ pathname: '/trip/[id]/edit', params: { id: target.id } });
                                    return;
                                }
                                if (key === 'delete') {
                                    // 二次确认步：第一次点击只换行文案（卡保持打开）
                                    if (!tripMenu.confirmDelete) {
                                        setTripMenu({ tripId: target.id, confirmDelete: true });
                                        return;
                                    }
                                    haptics.impact('heavy');
                                    setTripMenu(null);
                                    void useArchiveStore.getState().deleteTrip(target.id);
                                }
                            }}
                            onClose={() => setTripMenu(null)}
                        />
                    );
                })()
            ) : null}

            {/* 日记菜单卡（日记卡长按入口，共享组件 ui/action-menu-card）：措辞
                用「日记」（每天一篇的 /write 页）；重命名 → RenameCard；完成收笔
                = 手动提前结束；删除经二次确认步。 */}
            {journalMenu && todayJournal ? (
                <ActionMenuCard
                    title="日记"
                    rows={diaryMenuRows(todayJournal, journalMenu.confirmDelete)}
                    onAction={(key) => {
                        if (key === 'rename') {
                            setJournalMenu(null);
                            setRenamingJournalId(todayJournal.id);
                            return;
                        }
                        if (key === 'complete') {
                            haptics.success();
                            setJournalMenu(null);
                            void useArchiveStore.getState().completeJournal(todayJournal.id);
                            return;
                        }
                        if (key === 'delete') {
                            if (!journalMenu.confirmDelete) {
                                setJournalMenu({ confirmDelete: true });
                                return;
                            }
                            haptics.impact('heavy');
                            setJournalMenu(null);
                            void useArchiveStore.getState().deleteJournal(todayJournal.id);
                        }
                    }}
                    onClose={() => setJournalMenu(null)}
                />
            ) : null}

            {/* 事件菜单卡（事件卡长按入口，四字标题口径）：标记完成/失败 = 状态
                即存（updateEventMeta bump revision，事件离堆——deck 只显 open）；
                删除按产品口径不在此暴露（数据层能力保留）。 */}
            {eventMenu ? (
                <ActionMenuCard
                    title="事件"
                    rows={[
                        {
                            key: 'done',
                            icon: <LucideCheck size={20} strokeWidth={1.9} />,
                            title: '标记完成',
                        },
                        {
                            key: 'failed',
                            icon: <LucideClose size={20} strokeWidth={1.9} />,
                            title: '标记失败',
                        },
                    ]}
                    onAction={(key) => {
                        setEventMenu(null);
                        haptics.success();
                        void useArchiveStore.getState().updateEventMeta(eventMenu, {
                            status: key === 'done' ? 'done' : 'failed',
                        });
                    }}
                    onClose={() => setEventMenu(null)}
                />
            ) : null}

            {/* 计划菜单卡（计划卡长按入口，v11 对齐事件菜单解剖与四字口径）：
                改计划名复用 RenameCard（updateJournalTitle 对 open 计划有效）；
                标记完成/标记失败 = 状态即存（updatePlanMeta status，计划离堆——
                deck 与计划堆只显 open，事件菜单同款交互；closed 沿用存量「完成
                计划」落库值，failed 为 v11 新终态）；删除复用 deleteJournal
                （级联删媒体，二次确认）。 */}
            {planMenu ? (
                <ActionMenuCard
                    title="计划"
                    rows={[
                        {
                            key: 'rename',
                            icon: <LucideType size={20} strokeWidth={1.9} />,
                            title: '改计划名',
                        },
                        {
                            key: 'done',
                            icon: <LucideCheck size={20} strokeWidth={1.9} />,
                            title: '标记完成',
                        },
                        {
                            key: 'failed',
                            icon: <LucideClose size={20} strokeWidth={1.9} />,
                            title: '标记失败',
                        },
                        {
                            key: 'delete',
                            icon: <LucideTrash size={16} strokeWidth={1.9} />,
                            title: planMenu.confirmDelete ? '再点一次' : '删除计划',
                            danger: true,
                        },
                    ]}
                    onAction={(key) => {
                        if (key === 'rename') {
                            setNoteMenu(null);
                            setRenamingJournalId(planMenu.id);
                            return;
                        }
                        if (key === 'done' || key === 'failed') {
                            haptics.success();
                            setNoteMenu(null);
                            // 终态即离堆（open 过滤，事件同款）：完成 = closed
                            // （兼容存量）、失败 = failed；completed_at 由 db 同批落
                            void useArchiveStore
                                .getState()
                                .updatePlanMeta(planMenu.id, {
                                    status: key === 'done' ? 'closed' : 'failed',
                                });
                            return;
                        }
                        if (!planMenu.confirmDelete) {
                            setNoteMenu({ id: planMenu.id, confirmDelete: true });
                            return;
                        }
                        haptics.impact('heavy');
                        setNoteMenu(null);
                        void useArchiveStore.getState().deleteJournal(planMenu.id);
                    }}
                    onClose={() => setNoteMenu(null)}
                />
            ) : null}

            {/* + 选择器（单容器行组，2026-11-19 用户指令「一个卡片容器包裹，
                内部没有横线区分」——同 Me 内容卡语言）：条件渲染遮罩而非 RN
                Modal：Modal 是独立原生窗口，Expo Go(Fabric) 上其内容触摸概率性
                失效；条件渲染层与普通视图同机制，行为一致。 */}
            {chooserOpen ? (
                <View className="absolute inset-0 z-50">
                    <Pressable
                        className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                        onPress={() => setChooserOpen(false)}
                    >
                        <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
                            {/* 卡头：题 + 右上关闭钮（关闭语言统一） */}
                            <View className="flex-row items-center justify-between px-1 pt-0.5">
                                <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                                    开始什么？
                                </Text>
                                <CloseButton onPress={() => setChooserOpen(false)} />
                            </View>
                            {/* 单容器行组：rounded-card surface 包裹 + overflow-hidden
                                裁行高亮进圆角；行间零线条（留白即分隔），行内
                                active:bg 高亮（Pressable 直挂无 remount 风险）；行高
                                h-12（48 ≥44，hitSlop 0），裸图标 + 题单行 */}
                            <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                                <ChooserRow
                                    icon={<LucideBookOpen size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    title="新建日记"
                                    onPress={() => {
                                        haptics.impact();
                                        setChooserOpen(false);
                                        router.push('/write');
                                    }}
                                />
                                <ChooserRow
                                    icon={<LucideListPlus size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    title="新建计划"
                                    onPress={() => {
                                        haptics.impact();
                                        setChooserOpen(false);
                                        router.push('/plan/new' as never);
                                    }}
                                />
                                <ChooserRow
                                    icon={<LucideRoute size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    title="新的行程"
                                    onPress={() => {
                                        haptics.impact();
                                        setChooserOpen(false);
                                        router.push('/trip/new');
                                    }}
                                />
                                <ChooserRow
                                    icon={<LucideFlag size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    title="新建事件"
                                    onPress={() => {
                                        haptics.impact();
                                        setChooserOpen(false);
                                        router.push('/events/new' as never);
                                    }}
                                />
                            </View>
                        </Pressable>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
}

/**
 * 首页 deck 空堆态（设计过的邀请，不是死白——方向令 §3）：仅当「今天日记已收笔
 * 且无在途行程 / 未决事件 / 进行中计划」时出现（日记缺卡必有邀请卡垫底，deck
 * 常态非空）。文案口径与邀请卡一致：说清现状 + 指一条出路（+ 新建），不复述
 * 已删的入口组卡导航。
 */
function DeckEmptyInvite() {
    return (
        // settings 同源卡面（v0.4.7 令 3）：rounded-card surface + PAPER_CARD
        // 静止卡影，空态也是一张浮在页底上的纸卡，不是贴底的裸文字
        <View
            className="items-center rounded-card bg-ink-surface px-8 py-10 dark:bg-inkd-surface"
            style={PAPER_CARD_SHADOW}
        >
            <Text className="text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">今日</Text>
            <Text className="mt-2 text-[24px] font-semibold text-ink-text dark:text-inkd-text">
                这一页已收笔
            </Text>
            <Text className="mt-2 text-center text-[13px] leading-5 text-ink-muted dark:text-inkd-muted">
                明天会翻开新的一页。想再记点什么，点右下角 +。
            </Text>
        </View>
    );
}

/** 选择器行（单容器行组内的一行，Me 内容卡 ContentEntryRow 同语言）：裸图标 +
    题单行，行高 h-12（48 ≥44，hitSlop 0），行间贴靠零线条，按压 = 行级
    active:bg 高亮（Pressable 本体直挂 active: 类无 css-interop remount 风险）。 */
function ChooserRow({
    icon,
    title,
    onPress,
}: {
    icon: React.ReactNode;
    title: string;
    onPress(): void;
}) {
    return (
        <Pressable
            onPress={onPress}
            className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={title}
        >
            {icon}
            <Text className="flex-1 text-[15px] font-medium text-ink-text dark:text-inkd-text">{title}</Text>
        </Pressable>
    );
}

// ─── deck 卡片（原样式保留：封面在上 / 文字在下的垂直两段式）─────────────────

/** 封面实图：cover 裁切铺满 16:10（高封顶 220）；点击 → requestViewer 进 /viewer
    全屏路由预览。文件缺失时静默降级为 raised 底（use-file-url 文档化降级口径，
    封面不打断浏览）。后位让位由堆容器 pointerEvents="none" 承担（deck 对
    背卡整树透明，封面按压体天然不可达），不再需要 isFront 逐层传导。 */
function DeckCoverImage({
    fileKey,
    onPress,
    accessibilityLabel,
}: {
    fileKey: string;
    onPress: () => void;
    accessibilityLabel: string;
}) {
    const uri = useFileUrl(fileKey);
    const canPress = uri != null;
    return (
        // hitSlop 不传（0）：封面视觉盒远超 44，命中盒 == 视觉盒（嵌套于堆卡
        // Pressable 内，命中协商由最内层胜出，卡点击语义不受侵占）
        <BouncyPressable onPress={canPress ? onPress : undefined} scaleTo={0.985}>
            <View
                accessibilityLabel={accessibilityLabel}
                className="w-full overflow-hidden bg-ink-raised dark:bg-inkd-raised"
                style={{ aspectRatio: 16 / 10, maxHeight: 220 }}
            >
                {uri ? <Image source={{ uri }} className="h-full w-full" resizeMode="cover" /> : null}
            </View>
        </BouncyPressable>
    );
}

/** 封面视频占位：不建 player（封面不背播放器开销，MediaThumb 同口径），
    播放钮语义 + 点击 → requestViewer 进 /viewer 全屏播放。后位让位同上。 */
function DeckCoverVideo({ fileKey, onPress }: { fileKey: string; onPress: () => void }) {
    const uri = useFileUrl(fileKey);
    const canPress = uri != null;
    return (
        <BouncyPressable onPress={canPress ? onPress : undefined} scaleTo={0.985}>
            <View
                className="w-full items-center justify-center bg-ink-raised dark:bg-inkd-raised"
                style={{ aspectRatio: 16 / 10, maxHeight: 220 }}
            >
                <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                    <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                </View>
            </View>
        </BouncyPressable>
    );
}

/**
 * 摘要行数预算 hook：onLayout 实测摘要容器高度 → 按整行取整（floor，宁少
 * 勿截半行）。容器高度由 flex-1 决定（与摘要内容无关），实测 → setState 不
 * 构成布局反馈环；实测值不变不 setState（#15：onLayout 只在变化时更新）。
 * 返回 null 表示未实测（首帧保守按 1 行渲染，测量在首帧绘制前完成，无闪跳）。
 */
function useSummaryLineBudget(lineHeight: number) {
    const [maxLines, setMaxLines] = useState<number | null>(null);
    const onLayout = useCallback(
        (event: LayoutChangeEvent) => {
            const next = Math.max(0, Math.floor(event.nativeEvent.layout.height / lineHeight));
            setMaxLines((prev) => (prev === next ? prev : next));
        },
        [lineHeight],
    );
    return { maxLines, onLayout };
}

/** 摘要文本：预算 0 行（极端矮卡）时不渲染，杜绝 numberOfLines=0 的「不限行」语义。 */
function SummaryText({
    maxLines,
    lineClass,
    textClass,
    children,
}: {
    maxLines: number | null;
    lineClass: string;
    textClass: string;
    children: string;
}) {
    if (maxLines === 0) return null;
    return (
        <Text numberOfLines={maxLines ?? 1} className={`${lineClass} ${textClass}`}>
            {children}
        </Text>
    );
}

/**
 * 日记卡（原样式原样保留，2026-11-19 用户澄清）：封面（首图/首视频）+ 日期/
 * 状态 + 摘要 + 媒体字数角标；eyebrow 加「日记」类型前缀（多卡堆里区分实体）。
 * 交互：点击 = 进入内容（/write）；长按 = 日记菜单卡（useBlockActionGestures
 * 手势保留，web 桌面双击同口径）；后卡让位由堆容器 pointerEvents="none"
 * 承担（不再需要卡内逐层传导）。
 */
function JournalCard({
    journal,
    label,
    onOpen,
    onRequestMenu,
}: {
    journal: JournalRow;
    label: ReturnType<typeof formatDateGroupLabel>;
    /** 点击进入内容（由屏层给 router.push('/write')）。 */
    onOpen: () => void;
    /** 长按/双击 → 日记菜单卡。 */
    onRequestMenu: () => void;
}) {
    const palette = usePalette();
    const blocks = useMemo(() => parseBlocks(journal.blocks), [journal]);
    // 封面数据通道（原 deck 卡口径恢复）：仍被正文引用的媒体 id 集 + 首图/首视频
    // 候选（useJournalMedia = journal_media 行解析表；行内孤儿不参与封面候选）
    const mediaRows = useJournalMedia(journal.id);
    const liveMediaIds = useMemo(
        () => new Set((blocks ?? []).filter((block) => block.t === 'media').map((block) => block.mediaId)),
        [blocks],
    );
    const hero = useMemo(
        () =>
            mediaRows.find((row) => row.kind === 'image' && liveMediaIds.has(row.id)) ??
            mediaRows.find((row) => row.kind === 'video' && liveMediaIds.has(row.id)) ??
            null,
        [mediaRows, liveMediaIds],
    );
    // 摘要两级重排（原口径保留）：首段 = 引导行（15px text 色 1 行），其余段落
    // = 正文（muted 13px 预算行数）
    const summaryParts = useMemo(() => {
        const parts = (blocks ?? [])
            .filter((block): block is Extract<JournalBlock, { t: 'p' }> => block.t === 'p' && block.text.trim() !== '')
            .map((block) => block.text.trim());
        const bodyJoined = parts.slice(1).join(' ');
        return {
            lead: parts[0] ?? '',
            body:
                bodyJoined.length > 140
                    ? `${bodyJoined.slice(0, 140)}…`
                    : bodyJoined,
        };
    }, [blocks]);
    const { maxLines, onLayout } = useSummaryLineBudget(20);
    const gestures = useBlockActionGestures({
        enabled: true,
        onBlockAction: onRequestMenu,
        onSinglePress: onOpen,
    });

    return (
        <View className="flex-1 flex-col">
            {hero ? (
                hero.kind === 'image' ? (
                    <DeckCoverImage
                        fileKey={hero.file_key}
                        onPress={() =>
                            requestViewer({ kind: 'image', fileKey: hero.file_key, width: hero.width, height: hero.height })
                        }
                        accessibilityLabel="预览日记图片"
                    />
                ) : (
                    <DeckCoverVideo
                        fileKey={hero.file_key}
                        onPress={() => requestViewer({ kind: 'video', fileKey: hero.file_key })}
                    />
                )
            ) : null}
            {/* 文字区 Pressable（原结构保留） */}
            <Pressable
                onPress={gestures.onPress}
                onLongPress={gestures.onLongPress}
                className="flex-1 flex-col px-6 py-5"
                accessibilityRole="button"
                accessibilityLabel="打开日记，长按操作"
            >
                {/* eyebrow 行：类型前缀（日记）+ 日期 + relative + 状态（原结构，
                    前缀为多卡堆新增的区分标识） */}
                <View className="flex-row items-center justify-between">
                    <Text
                        className="text-[11px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {'日记 · '}
                        {label.monthDay} {label.weekday}
                        {label.relative ? (
                            <Text className="ml-2 text-[11px] font-medium text-ink-accent dark:text-inkd-accent">
                                {label.relative}
                            </Text>
                        ) : null}
                    </Text>
                    <Text
                        className={`text-[11px] ${journal.status === 'open' ? 'text-ink-accent dark:text-inkd-accent' : 'text-ink-muted dark:text-inkd-muted'}`}
                    >
                        {journal.status === 'open' ? '进行中' : '已收笔'}
                    </Text>
                </View>
                {journal.title ? (
                    <Text
                        numberOfLines={1}
                        className="mt-1 text-[16px] font-semibold text-ink-text dark:text-inkd-text"
                    >
                        {journal.title}
                    </Text>
                ) : null}
                <Text
                    numberOfLines={1}
                    className={`mt-2.5 text-[16px] leading-6 ${summaryParts.lead ? 'text-ink-text dark:text-inkd-text' : 'text-ink-muted dark:text-inkd-muted'}`}
                >
                    {summaryParts.lead || '还没写字，插入一张图也算。'}
                </Text>
                <View className="mt-1 min-h-0 flex-1 overflow-hidden" onLayout={onLayout}>
                    {summaryParts.body ? (
                        <SummaryText
                            maxLines={maxLines}
                            lineClass="text-[13px] leading-5"
                            textClass="text-ink-muted dark:text-inkd-muted"
                        >
                            {summaryParts.body}
                        </SummaryText>
                    ) : null}
                </View>
                {/* 底行：字数零值不上屏（「0 字」噪音，指令 7），CTA 恒在右 */}
                <View className="flex-row items-center justify-between pt-3">
                    {journal.word_count > 0 ? (
                        <Text
                            className="text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {journal.word_count} 字
                        </Text>
                    ) : (
                        <View />
                    )}
                    <View className="flex-row items-center">
                        <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            继续写
                        </Text>
                        <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                    </View>
                </View>
            </Pressable>
        </View>
    );
}

/**
 * 行程卡（v0.4.6 指令 4 重样）：封面（首图/首视频/徽章占位）+ eyebrow（类型 +
 * 时间/区间，右端状态片）+ 描述正文 + 统计（计划进度 / 已写天数）——**行程名
 * 不上卡面**（即使命名也不显示：兜底「未命名行程」与真名一并退场，区分度全部
 * 交给日期/节奏/封面/统计；名字只在屏头与详情出现）。首页与 /trips 堆共用本
 * 卡（library-screen 深取，同 DeadEndView 先例）。
 * 交互：点击 → /trip/[id]；onRequestMenu 给出时长按 → 行程菜单卡（首页），
 * 不给时（堆页）卡面无内层按压体，点按由 deck 壳层承担。
 */
export function TripCard({
    trip,
    onOpen,
    onRequestMenu,
}: {
    trip: DeckTrip;
    /** 点击进入行程（屏层给 router.push）。 */
    onOpen: () => void;
    /** 长按/双击 → 行程菜单卡（屏层持 setTripMenu；缺省 = 无菜单面）。 */
    onRequestMenu?: () => void;
}) {
    const palette = usePalette();
    const cover = useTripCover(trip.id);
    const gestures = useBlockActionGestures({
        enabled: onRequestMenu != null,
        onBlockAction: onRequestMenu,
        onSinglePress: onOpen,
    });
    // 时间 eyebrow（R5 常住今天）：持续性行程出发后锚定今天（M月D日 · 第 N 天）
    const todayLabel = tripTodayLabel(trip);
    const desc = trip.description.trim();
    const textZone = (
        <>
            {/* eyebrow 行（11 档）：类型 + 区间/今天节奏在左，状态片在右
                （色彩只上状态数据） */}
            <View className="flex-row items-center justify-between">
                <Text
                    numberOfLines={1}
                    className="mr-2 min-w-0 flex-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {'行程 · '}
                    {todayLabel ?? formatTripSpan(trip)}
                    {todayLabel == null && trip.dayCount != null ? ` · ${trip.dayCount} 天` : ''}
                </Text>
                <StatusChip status={trip.status} />
            </View>
            {/* 描述 = 卡面正文声部（16 档）；空描述是邀请不是空白（文案口径） */}
            <Text
                numberOfLines={3}
                className={`mt-3 text-[16px] leading-6 ${
                    desc ? 'text-ink-text dark:text-inkd-text' : 'text-ink-muted dark:text-inkd-muted'
                }`}
            >
                {desc || '还没写这一页，点开补一句。'}
            </Text>
            <View className="min-h-0 flex-1" />
            {trip.plansTotal > 0 ? (
                <View className="mb-2">
                    <ProgressBar done={trip.plansDone} total={trip.plansTotal} />
                    <Text
                        className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        计划完成 {trip.plansDone}/{trip.plansTotal}
                    </Text>
                </View>
            ) : null}
            <View className="flex-row items-center justify-between">
                <Text
                    className="text-[12px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {trip.dayCount == null
                        ? `已写 ${trip.journalDays} 天`
                        : `已写 ${trip.journalDays}/${trip.dayCount} 天`}
                </Text>
                <View className="flex-row items-center">
                    <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                        查看行程
                    </Text>
                    <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                </View>
            </View>
        </>
    );
    return (
        <View className="flex-1 flex-col">
            {cover ? (
                cover.kind === 'image' ? (
                    <DeckCoverImage
                        fileKey={cover.fileKey}
                        onPress={() => requestViewer({ kind: 'image', fileKey: cover.fileKey })}
                        accessibilityLabel="预览行程照片"
                    />
                ) : (
                    <DeckCoverVideo
                        fileKey={cover.fileKey}
                        onPress={() => requestViewer({ kind: 'video', fileKey: cover.fileKey })}
                    />
                )
            ) : (
                <DeckCoverPlaceholder>
                    <TripBadge icon={trip.icon} size="deck" />
                </DeckCoverPlaceholder>
            )}
            {/* 文字区：首页带长按菜单时内层 Pressable 承担手势（deck 外层
                PanResponder 只认领水平拖拽，两套手势并存的既有口径不变）；
                堆页无菜单时退化为纯 View，点按交给 deck 壳层 */}
            {onRequestMenu ? (
                <Pressable
                    onPress={gestures.onPress}
                    onLongPress={gestures.onLongPress}
                    className="flex-1 flex-col px-6 py-5"
                    accessibilityRole="button"
                    accessibilityLabel="打开行程，长按操作"
                >
                    {textZone}
                </Pressable>
            ) : (
                <View className="flex-1 flex-col px-6 py-5">{textZone}</View>
            )}
        </View>
    );
}

/** 无图封面占位：中性 raised 底 + TripBadge（deck 56 档）锚定行程身份。 */
function DeckCoverPlaceholder({ children }: { children: React.ReactNode }) {
    return (
        <View
            className="w-full items-center justify-center bg-ink-raised dark:bg-inkd-raised"
            style={{ aspectRatio: 16 / 10, maxHeight: 220 }}
        >
            {children}
        </View>
    );
}

/**
 * 计划卡（v0.4.6 指令 7 重样，首页与 /plans 计划堆共用——library 深取）：
 * eyebrow（类型 + 建立日期）→ 题（16 semibold，无题回退「未命名计划」）→
 * 引导行（16 text 1 行 = 描述或正文首段，无则 muted 邀请）→ 正文预算行
 * （13 muted）→ 底部只留打开 CTA。**「更新于 2026-11-25 08:25」「N 字」
 * 两类冗余串退场**（方向文档字阶纪律点名的噪音）——计划身份由名字 +
 * 建立日期 + 内容本身承担，堆里的计划恒为「进行中」，状态词也不重复上卡面。
 */
export function NoteDeckCard({ note }: { note: JournalRow }) {
    const palette = usePalette();
    const blocks = useMemo(() => parseBlocks(note.blocks), [note]);
    // 引导行回退链：描述（未填跳过）→ 正文首段；正文 = 其余段落 13 muted 预算
    const parts = useMemo(
        () =>
            (blocks ?? [])
                .filter((block): block is Extract<JournalBlock, { t: 'p' }> => block.t === 'p' && block.text.trim() !== '')
                .map((block) => block.text.trim()),
        [blocks],
    );
    const lead = note.description?.trim() || parts[0] || '';
    const body = useMemo(() => {
        const rest = note.description?.trim() ? parts.join(' ') : parts.slice(1).join(' ');
        return rest.length > 140 ? `${rest.slice(0, 140)}…` : rest;
    }, [note, parts]);
    const { maxLines, onLayout } = useSummaryLineBudget(20);
    const created = formatDateParts(note.local_date);
    return (
        <View className="flex-1 flex-col">
            <View className="flex-1 flex-col px-6 py-5">
                <Text
                    numberOfLines={1}
                    className="text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {'计划 · '}
                    {created.monthDay} {created.weekday}
                </Text>
                <Text
                    numberOfLines={1}
                    className="mt-1 text-[16px] font-semibold text-ink-text dark:text-inkd-text"
                >
                    {note.title?.trim() || PLAN_TITLE_FALLBACK}
                </Text>
                <Text
                    numberOfLines={1}
                    className={`mt-2.5 text-[16px] leading-6 ${lead ? 'text-ink-text dark:text-inkd-text' : 'text-ink-muted dark:text-inkd-muted'}`}
                >
                    {lead || '还没有内容，点开写一点。'}
                </Text>
                <View className="mt-1 min-h-0 flex-1 overflow-hidden" onLayout={onLayout}>
                    {body ? (
                        <SummaryText
                            maxLines={maxLines}
                            lineClass="text-[13px] leading-5"
                            textClass="text-ink-muted dark:text-inkd-muted"
                        >
                            {body}
                        </SummaryText>
                    ) : null}
                </View>
                <View className="flex-row items-center justify-end pt-3">
                    <View className="flex-row items-center">
                        <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            打开计划
                        </Text>
                        <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                    </View>
                </View>
            </View>
        </View>
    );
}

/**
 * 事件卡（v0.4.6 指令 7 重样）：eyebrow 类型词 + 标题 + 描述 + 打开 CTA。
 * 「更新于 …」时间串与「进行中」（deck 恒为 open 事件，状态零信息量）随
 * 冗余串清理退场。点击 → /events/[id]；无菜单（R3）。
 */
function EventDeckCard({ event }: { event: EventRow }) {
    const palette = usePalette();
    const { maxLines, onLayout } = useSummaryLineBudget(20);
    return (
        <View className="flex-1 flex-col">
            <View className="flex-1 flex-col px-6 py-5">
                <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">事件</Text>
                <Text
                    numberOfLines={2}
                    className="mt-1 text-[16px] font-semibold text-ink-text dark:text-inkd-text"
                >
                    {event.title}
                </Text>
                {event.description?.trim() ? (
                    <View className="mt-2.5 min-h-0 flex-1 overflow-hidden" onLayout={onLayout}>
                        <SummaryText
                            maxLines={maxLines}
                            lineClass="text-[13px] leading-5"
                            textClass="text-ink-secondary dark:text-inkd-secondary"
                        >
                            {event.description}
                        </SummaryText>
                    </View>
                ) : (
                    <View className="min-h-0 flex-1" />
                )}
                <View className="flex-row items-center justify-end pt-3">
                    <View className="flex-row items-center">
                        <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            打开事件
                        </Text>
                        <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                    </View>
                </View>
            </View>
        </View>
    );
}
