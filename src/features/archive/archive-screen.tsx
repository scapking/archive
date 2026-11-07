import { cloneElement, isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Image, Pressable, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    BouncyPressable,
    LucideBookOpen,
    LucideCalendar,
    LucideChevronRight,
    LucidePlay,
} from '@/core/icons';
import { useArchiveRevision, useArchiveStore } from './store';
import { getJournalByDate, listTripMediaByTrip } from './db';
import {
    formatDateGroupLabel,
    isEditable,
    mediaCount,
    parseBlocks,
    previewText,
} from './journal-logic';
import { formatTripSpan, pickDeckTrip, todayLocal } from './trip-logic';
// useDeckSlotFront 走 ui 域内直连（域内直连模块与 ./db、./trip-logic 同纪律；
// CloseButton 已收口进 ui/index.ts 出口，不再深取）
import { useDeckSlotFront } from './ui/deck';
import { requestViewer } from './viewer-request';
import {
    CardDeck,
    CloseButton,
    ComposeFab,
    EmptyState,
    LoadingView,
    ProgressBar,
    RenameCard,
    StatusChip,
    TripBadge,
    useBlockActionGestures,
    useFileUrl,
    useJournalMedia,
    usePalette,
} from './ui';
import type { JournalRow } from './db';

/**
 * Archive 首页：行程与当前日记两张卡，重叠、左右若隐若现（deck 几何/交互归
 * ui/deck.tsx，本屏只组装卡片内容）。
 *
 * 卡片结构（DEV.md #3 垂直大重构）：**图上文下**——封面媒体区（行程首图/
 * 日记首图，全出血贴卡顶）在上，文字区（标题/区间/状态/摘要）在下。理由：
 * 1. taste-skill 法则「一张主导图胜过六张小图」：封面占卡高约半，识别度最高；
 * 2. 露条识别度：后卡露出的 76px 竖条里，图片切片比文字切片更具可辨识度，
 *    「点露条换位」的核心交互因此更可发现；
 * 3. Apple Journal 卡片节奏：图像块 + 文字块两段式，段间靠留白不靠细线。
 *
 * 容量自适应（DEV.md #3）：两卡高度由 deck 槽位几何恒等（top/bottom 0，前卡
 * 即基准），文字摘要区 flex-1 实测可用高度（onLayout）→ 摘要行数按整行取整
 * （floor，宁少勿截半行）；实测值不变不 setState（#15 防重渲）。
 *
 * 全屏预览：deck 封面点击 → requestViewer()（viewer-request 中立层）→ root
 * Stack 的 transparentModal 路由 /viewer 渲染 fullscreen-viewer。屏级 viewer
 * state（#16）随之退役——路由屏是 (tabs) 之上的窗口级容器，tabBar 条带
 * 盖不住的根因（tab 屏 screens 容器 overflow:hidden + tabBar 后绘）在路由层
 * 消除，本屏不再渲染任何全屏层。卡内命中区也由 64px 缩略图升级为整块封面
 * （≥44 口径远超）。
 *
 * 点前卡进内容 / 点后卡（露条）换位的 deck 交互不变；封面点击 = 预览媒体、
 * 文字区点击 = 进入内容（媒体可进全屏是既定口径，两者按区域分工不互斥）。
 * **空态导航（对齐笔记卡口径）**：行程侧空卡（还没有行程）点击 → /trip/new
 * 创建（此前空态点击无动作，是「点了没反应」的反馈根因），有行程 → /trip/[id]；
 * 笔记侧空卡/有内容均 → /write（编辑器自带建页语义，本来就可点）。
 * 笔记卡文字区**长按**（web 桌面双击，与媒体块同口径）→ 重命名设置卡
 * （条件渲染 scrim + 居中卡，同块操作卡范式；已收笔不可改，#7 入口先挡）。
 */

/** 封面区比例与高度上限：窄屏按宽度收敛（16:10），宽屏不无限拉高（封顶 220）。 */
const COVER_RATIO = 16 / 10;
const COVER_MAX_HEIGHT = 220;

/** 摘要行高（与 leading-6 / leading-5 成对）：行数预算按整行取整，宁少勿截半行。 */
const JOURNAL_SUMMARY_LINE_HEIGHT = 24;
const TRIP_SUMMARY_LINE_HEIGHT = 20;

export function ArchiveScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const ready = useArchiveStore((s) => s.ready);
    const error = useArchiveStore((s) => s.error);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const revision = useArchiveRevision();
    const chooserTint = usePalette().secondary;

    const [todayJournal, setTodayJournal] = useState<JournalRow | null>(null);
    const [chooserOpen, setChooserOpen] = useState(false);
    // 行程封面（首图优先、无图取首视频）：deck 数据在屏侧组装，deck 保持纯展示
    const [tripCover, setTripCover] = useState<{ kind: 'image' | 'video'; fileKey: string } | null>(null);
    // 重命名设置卡（笔记卡长按入口）：非 null = 正在重命名该篇（设置卡挂屏根，
    // 条件渲染 scrim + 居中卡，同 chooser / 块操作卡范式）
    const [renamingJournalId, setRenamingJournalId] = useState<string | null>(null);

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
        getJournalByDate(null, todayLocal())
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

    // 选卡与 store.deck() 同口径（trip-logic.pickDeckTrip：进行中 > 最近的计划中 >
    // 刚结束）；trips[0] 只按 start_date DESC，存在进行中行程时会显示错对象。
    // useMemo：trips 引用不变不重算（#15 deck 数据组装防重渲）
    const deckTrip = useMemo(() => pickDeckTrip(trips), [trips]);

    // 行程封面查询：行程 id 或数据版本变化时重查（#15）；revision 参与依赖是
    // 因为 attachTripMedia 等 mutation 只 bump revision 不 reload trips，首图
    // 可能从无到有。**换行程才先清旧封面**（防串卡）；同行程 revision 重查
    // 不清——否则写日记/存笔记的每次 revision bump 都会让封面闪回占位。
    const deckTripId = deckTrip?.id ?? null;
    const loadedTripIdRef = useRef<string | null>(null);
    useEffect(() => {
        if (!deckTripId) {
            loadedTripIdRef.current = null;
            setTripCover(null);
            return;
        }
        if (loadedTripIdRef.current !== deckTripId) {
            loadedTripIdRef.current = deckTripId;
            setTripCover(null);
        }
        let active = true;
        listTripMediaByTrip(deckTripId)
            .then((rows) => {
                if (!active) return;
                // 封面取首图；纯视频行程取首视频（播放钮占位可点进全屏），
                // 音频不作封面（无视觉帧）。不建 player：封面不背播放器开销。
                const firstImage = rows.find((row) => row.kind === 'image');
                const firstVideo = rows.find((row) => row.kind === 'video');
                const next = firstImage
                    ? { kind: 'image' as const, fileKey: firstImage.file_key }
                    : firstVideo
                        ? { kind: 'video' as const, fileKey: firstVideo.file_key }
                        : null;
                // 同值短路（#15）：结果未变不触发渲染
                setTripCover((prev) =>
                    prev?.kind === next?.kind && prev?.fileKey === next?.fileKey ? prev : next,
                );
            })
            .catch(() => {
                if (active) setTripCover(null);
            });
        return () => {
            active = false;
        };
    }, [deckTripId, revision]);

    // today 与 journalLabel 不随 trips/媒体变化，无需 memo（廉价字符串）
    const today = todayLocal();
    const journalLabel = formatDateGroupLabel(today, today);

    if (!ready) return <LoadingView />;

    const noContent = !todayJournal && !deckTrip;

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-1 pt-2">
                    <Text className="text-[20px] font-semibold text-ink-text dark:text-inkd-text">
                        Archive
                    </Text>
                    <Text
                        className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {metrics.streak > 0
                            ? `连续记录 ${metrics.streak} 天 · 点卡片进入内容`
                            : '行程与今天的一页，都在这里'}
                    </Text>
                    {error ? (
                        <Text className="mt-1 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}
                </View>

                {noContent ? (
                    <EmptyStateIcon />
                ) : (
                    // 屏边距 px-6（24）：与屏头 / Me / 搜索 / 行程详情同一屏边距口径
                    //（原 px-5(20) 是与日卡 px-6 档并存的双轨，一致性收敛轮归一）
                    <View className="px-6">
                        <View className="mx-auto w-full max-w-[560px]">
                            <CardDeck
                                a={{
                                    id: 'journal',
                                    node: (
                                        <JournalCard
                                            journal={todayJournal}
                                            label={journalLabel}
                                            onOpen={() => router.push('/write')}
                                            onRename={() =>
                                                setRenamingJournalId(todayJournal?.id ?? null)
                                            }
                                        />
                                    ),
                                }}
                                b={{
                                    id: 'trip',
                                    node: <TripCard trip={deckTrip} cover={tripCover} />,
                                }}
                                onPressCard={(id, isFront) => {
                                    if (!isFront) return;
                                    if (id === 'journal') {
                                        // 笔记侧：空/有内容都进 /write（编辑器自带建页语义）
                                        router.push('/write');
                                        return;
                                    }
                                    // 行程侧（参考笔记卡的可点口径）：没有行程 →
                                    // 创建页（空态卡不再是死区），有行程 → 对应详情
                                    if (deckTrip) {
                                        router.push({ pathname: '/trip/[id]', params: { id: deckTrip.id } });
                                    } else {
                                        router.push('/trip/new');
                                    }
                                }}
                            />
                            <View className="mt-3 flex-row items-center justify-center gap-1.5">
                                <View className="h-1.5 w-1.5 rounded-full bg-ink-accent dark:bg-inkd-accent" />
                                <View className="h-1.5 w-1.5 rounded-full bg-ink-faint dark:bg-inkd-faint" />
                            </View>
                        </View>
                    </View>
                )}
            </View>

            <ComposeFab onPress={() => setChooserOpen(true)} accessibilityLabel="新建" />

            {/* 重命名设置卡（笔记卡长按入口，共享组件 ui/rename-card）：条件渲染
                scrim + 居中卡挂屏根（zIndex 50 压过 FAB/deck；卡内不可见挂 deck
                槽位里——槽位是 absolute 定位容器，浮层会被约束在卡内）。落库通道
                经 onSave 注入（store.updateJournalTitle，锁定预检 #7 兜底）；
                Android 返回键由卡片自身 BackHandler 关闭（同块操作卡范式）。 */}
            {renamingJournalId && todayJournal ? (
                <RenameCard
                    initialTitle={todayJournal.title ?? ''}
                    onSave={(title) =>
                        useArchiveStore.getState().updateJournalTitle(renamingJournalId, title)
                    }
                    onClose={() => setRenamingJournalId(null)}
                    errorText={error}
                />
            ) : null}

            {/* + 选择器：写日记 / 建行程——条件渲染遮罩而非 RN Modal：
                Modal 是独立原生窗口，Expo Go(Fabric) 上其内容触摸概率性失效
                （实测弹窗选项点击无响应）；条件渲染层与普通视图同机制，行为一致。 */}
            {chooserOpen ? (
                <View className="absolute inset-0 z-50">
                    <Pressable
                        className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                        onPress={() => setChooserOpen(false)}
                    >
                        {/* 卡片本体：无边框规范（#13）——border 零，base 底 + 圆角卡
                            （#8 打磨轮：与 insert-menu / 块操作卡同一卡片语言）；
                            卡头 = 题 + 右上关闭钮（关闭语言统一，scrim/返回键之外
                            的显式出口） */}
                        <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                            <View className="flex-row items-center justify-between">
                                <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                                    开始什么？
                                </Text>
                                {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                                <CloseButton onPress={() => setChooserOpen(false)} />
                            </View>
                            <View className="mt-4 gap-2.5">
                                {/* 两行均自带 p-4 完整视觉盒（高 ~72px ≥44）：不传 hitSlop（0），
                                    命中盒 == 视觉盒；行距 gap-2.5(10px) 为不可点间隙——旧默认
                                    hitSlop 10 时两行命中区恰好重叠（10 < 10+10），已随默认收敛解除 */}
                                <BouncyPressable
                                    onPress={() => {
                                        setChooserOpen(false);
                                        router.push('/write');
                                    }}
                                    scaleTo={0.97}
                                >
                                    <ChooserRow
                                        icon={<LucideBookOpen size={20} strokeWidth={1.9} />}
                                        title="今天的日记"
                                        hint="连续写，24:00 自动收笔"
                                        tint={chooserTint}
                                    />
                                </BouncyPressable>
                                <BouncyPressable
                                    onPress={() => {
                                        setChooserOpen(false);
                                        router.push('/trip/new');
                                    }}
                                    scaleTo={0.97}
                                >
                                    <ChooserRow
                                        icon={<LucideCalendar size={20} strokeWidth={1.9} />}
                                        title="新的行程"
                                        hint="图标、视频、逐日骨架"
                                        tint={chooserTint}
                                    />
                                </BouncyPressable>
                            </View>
                        </Pressable>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
}

/** 空态：图标配色统一走 palette（empty-state 组件自带布局）。 */
function EmptyStateIcon() {
    const palette = usePalette();
    const router = useRouter();
    return (
        <EmptyState
            icon={<LucideBookOpen size={40} color={palette.muted} strokeWidth={1.5} />}
            title="一切都还没开始"
            hint="写下今天的第一页，或先建一个行程。"
            actionLabel="写今天的日记"
            onAction={() => router.push('/write')}
        />
    );
}

/** 选择器行（#8 打磨轮：与 insert-menu MenuRow 同一行语言——icon 容器 40×40
    rounded-control + raised 触感底，无边框规范 border 零；按压反馈统一由
    外层 BouncyPressable 承担，行 View 不用 active: 伪类（css-interop 会把
    View 升级成 Pressable 首帧后 remount、触摸中途被杀，见 insert-menu 注）。 */
function ChooserRow({
    icon,
    title,
    hint,
    tint,
}: {
    icon: React.ReactNode;
    title: string;
    hint: string;
    tint: string;
}) {
    return (
        <View className="flex-row items-center gap-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface">
            <View
                pointerEvents="none"
                className="h-10 w-10 items-center justify-center rounded-control bg-ink-raised dark:bg-inkd-raised"
            >
                {withTint(icon, tint)}
            </View>
            <View className="flex-1">
                <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">{title}</Text>
                <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">{hint}</Text>
            </View>
        </View>
    );
}

/** 调用点的 icon 只给形状，色统一在这里补（缺色时原样渲染）。 */
function withTint(node: React.ReactNode, color: string): React.ReactNode {
    if (!isValidElement(node)) return node;
    const element = node as React.ReactElement<{ color?: string }>;
    return element.props.color !== undefined ? node : cloneElement(element, { color });
}

// ─── deck 卡片（垂直结构：封面在上 / 文字在下）─────────────────────────────

/**
 * 卡壳：垂直两段式（封面全出血贴顶 + 文字区），overflow-hidden 让封面裁进
 * rounded-card（16）圆角；无阴影（房规）；surface-on-base tone 分层（#13
 * 无边框规范收敛：卡片级描边清除，与 trip-detail 日卡同一卡片语言）。
 */
function CardShell({ children }: { children: React.ReactNode }) {
    return (
        <View className="h-full flex-col overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
            {children}
        </View>
    );
}

/** 封面实图：cover 裁切铺满 16:10（高封顶 220）；点击 → requestViewer 进 /viewer
    全屏路由预览。文件缺失时静默降级为 raised 底（use-file-url 文档化降级口径，
    封面不打断浏览）。后位让位（deck 契约）：封面右缘落在后卡露条命中区，
    后位时置空 onPress——穿透依赖 BouncyPressable 的 disabled 传导（2026-11
    修复，仅置空回调不构成穿透；见 bouncy-pressable 文件头行为矩阵），
    触摸这才真正落到 deck 卡 Pressable → 点露条换位。 */
function DeckCoverImage({
    fileKey,
    onPress,
    accessibilityLabel,
}: {
    fileKey: string;
    onPress: () => void;
    accessibilityLabel: string;
}) {
    const isFront = useDeckSlotFront();
    const uri = useFileUrl(fileKey);
    const canPress = uri != null && isFront;
    return (
        // hitSlop 不传（0）：封面视觉盒远超 44，命中盒 == 视觉盒（嵌套于 deck 卡
        // Pressable 内，命中协商由最内层胜出，卡点击语义不受侵占）
        <BouncyPressable onPress={canPress ? onPress : undefined} scaleTo={0.985}>
            <View
                accessibilityLabel={accessibilityLabel}
                className="w-full overflow-hidden bg-ink-raised dark:bg-inkd-raised"
                style={{ aspectRatio: COVER_RATIO, maxHeight: COVER_MAX_HEIGHT }}
            >
                {uri ? <Image source={{ uri }} className="h-full w-full" resizeMode="cover" /> : null}
            </View>
        </BouncyPressable>
    );
}

/** 封面视频占位：不建 player（封面不背播放器开销，MediaThumb 同口径），
    播放钮语义 + 点击 → requestViewer 进 /viewer 全屏播放（路由屏内
    FullscreenVideoViewer 自带 controls）。后位让位同 DeckCoverImage。 */
function DeckCoverVideo({ fileKey, onPress }: { fileKey: string; onPress: () => void }) {
    const isFront = useDeckSlotFront();
    const uri = useFileUrl(fileKey);
    const canPress = uri != null && isFront;
    return (
        <BouncyPressable onPress={canPress ? onPress : undefined} scaleTo={0.985}>
            <View
                className="w-full items-center justify-center bg-ink-raised dark:bg-inkd-raised"
                style={{ aspectRatio: COVER_RATIO, maxHeight: COVER_MAX_HEIGHT }}
            >
                <View className="h-12 w-12 items-center justify-center rounded-full bg-black/40">
                    <LucidePlay size={20} color="#FFFFFF" strokeWidth={2.2} />
                </View>
            </View>
        </BouncyPressable>
    );
}

/** 无图封面占位：中性 raised 底 + TripBadge（deck 56 档）锚定行程身份。 */
function DeckCoverPlaceholder({ children }: { children: React.ReactNode }) {
    return (
        <View
            className="w-full items-center justify-center bg-ink-raised dark:bg-inkd-raised"
            style={{ aspectRatio: COVER_RATIO, maxHeight: COVER_MAX_HEIGHT }}
        >
            {children}
        </View>
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
 * 日记卡：封面（首图/首视频）+ 日期/状态 + 摘要 + 媒体字数角标。
 *
 * 文字区交互（不与 deck 导航冲突）：
 * - 点击 = 进入内容（前卡语义与 deck onPressCard('journal', true) 等价）；
 * - 长按 = 重命名设置卡（native/web 触屏；web 桌面 = 双击，与媒体块同口径）；
 * - 后卡整体让位：Pressable disabled（仅置空 handlers 仍会抢 responder，
 *   必须 disabled 触摸才穿透 deck 卡 Pressable）→ 点露条换位语义不变；
 * - 已收笔（closed）标题锁定（#7）：长按入口先挡，store.updateJournalTitle 兜底。
 * 封面点击 = 预览媒体（requestViewer 进 /viewer），长按封面仍走封面自身语义
 * （BouncyPressable 无 onLongPress，按住松开 = 预览，不弹重命名卡）。
 */
function JournalCard({
    journal,
    label,
    onOpen,
    onRename,
}: {
    journal: JournalRow | null;
    label: ReturnType<typeof formatDateGroupLabel>;
    /** 点击进入内容（前卡；由屏层给 router.push('/write')）。 */
    onOpen: () => void;
    /** 长按/双击 → 重命名设置卡（仅 open 状态启用）。 */
    onRename: () => void;
}) {
    const palette = usePalette();
    // hooks 规则：无条件调用——journal 在 null ↔ 有值翻转时 hooks 数量必须恒定
    // （条件后调 hook 会在"写完今天第一篇"时炸 Invalid hook call，web 真机双端实证）
    const isFront = useDeckSlotFront();
    const mediaRows = useJournalMedia(journal?.id ?? null);
    const blocks = useMemo(() => (journal ? parseBlocks(journal.blocks) : null), [journal]);
    // 仍被正文引用的媒体 id 集（#10 封面陈旧根因）：编辑器删块是「移块不删行」
    // 的软删语义（journal-logic.removeBlock），journal_media 行会保留——封面若
    // 直接按媒体行取，已删除的图/视频仍会霸占首页卡片。封面数据源必须与正文
    // 同源（blocks），媒体行只做 fileKey/尺寸的解析表；行内孤儿（块已删）一律
    // 不参与封面候选。角标 mediaCount 与摘要 previewText 本就按 blocks 计，同口径。
    const liveMediaIds = useMemo(
        () => new Set((blocks ?? []).filter((block) => block.t === 'media').map((block) => block.mediaId)),
        [blocks],
    );
    // 封面取首图，无图取首视频，纯音频无封面（日记卡文字优先，省出摘要空间）
    const hero = useMemo(
        () =>
            mediaRows.find((row) => row.kind === 'image' && liveMediaIds.has(row.id)) ??
            mediaRows.find((row) => row.kind === 'video' && liveMediaIds.has(row.id)) ??
            null,
        [mediaRows, liveMediaIds],
    );
    const summary = useMemo(
        () => (blocks ? previewText(blocks) || '还没写字，插入一张图也算。' : ''),
        [blocks],
    );
    const { maxLines, onLayout } = useSummaryLineBudget(JOURNAL_SUMMARY_LINE_HEIGHT);
    const canRename = isFront && journal != null && isEditable(journal.status);
    // 与媒体块同一套手势解析：长按（native/web 触屏）/双击（web 桌面）→ 重命名，
    // 单击放行导航。onBlockAction 按 canRename 门控（#7 收笔锁定：长按入口在
    // 手势源头关断，而不是等重命名卡打开后再由 store 兜底报错）；后卡的让位
    // 不在手势层做，而在下方 Pressable 显式 disabled（触摸穿透 deck 卡 → 换位）
    const gestures = useBlockActionGestures({
        enabled: canRename,
        onBlockAction: canRename ? onRename : undefined,
        onSinglePress: onOpen,
    });

    if (!journal || !blocks) {
        // 空态卡 = 行动邀请（taste-skill：空态给方向，不是 mood 板）：留白居中 +
        // 轻 CTA（accent 文字 + chevron，同有内容卡的 footer 语言，不堆框不加钮）。
        // 点击语义在 deck 卡 Pressable（→ /write），卡内不放嵌套按压体——
                // 保持 deck 触摸面纯净铁律（卡体 Pressable 零 className）
        return (
            <CardShell>
                {/* 卡内边距 px-6 py-5：对齐日卡「水平 24 / 垂直 20」口径（同层级同值） */}
                <View className="flex-1 items-center justify-center gap-2 px-6 py-5">
                    <LucideBookOpen size={34} color={palette.muted} strokeWidth={1.5} />
                    <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                        {label.monthDay} {label.weekday}
                    </Text>
                    <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                        今天的一页还没写
                    </Text>
                    <View className="mt-1 flex-row items-center">
                        <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            开始写
                        </Text>
                        <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                    </View>
                </View>
            </CardShell>
        );
    }
    return (
        <CardShell>
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
                        onPress={() =>
                            requestViewer({ kind: 'video', fileKey: hero.file_key, width: hero.width, height: hero.height })
                        }
                    />
                )
            ) : null}
            {/* 文字区 Pressable：handler 恒挂接（#8 双击清查——条件挂接在状态翻转
                瞬间会让 Pressability 重配置吞首点；让位语义全部收敛到一个开关）。
                后卡让位用 **pointerEvents="none"** 而非 Pressable disabled（2026-11
                终验修复）：disabled 在 web 被 RN-web 落成原生 <button disabled>，
                Chrome 对 disabled 表单控件抑制全部指针事件——触摸根本不进 React
                事件系统，更不会冒泡到 deck 卡 Pressable，「点露条文字段换位」在
                后卡=日记卡时整段失效（native 的「disabled 不认领 → 穿透」语义在
                web 被 DOM 吞掉）。pointerEvents="none" 双端同语义：整个子树对触摸
                透明，事件直接落到父级 deck 卡 Pressable → 换位；前卡恢复 'auto'
                时 Pressability 无需重配置（prop 翻转 ≠ 挂接翻转，无 #8 吞首点窗口）。
                长按触发后 Pressability 不补发 onPress，导航与重命名天然二选一；
                web 桌面双击消歧窗口内单击导航延迟 320ms（同媒体块口径）。 */}
            <Pressable
                pointerEvents={isFront ? 'auto' : 'none'}
                onPress={gestures.onPress}
                onLongPress={gestures.onLongPress}
                // 文字区卡内边距 px-6 py-5：对齐 trip-detail 日卡口径（水平 24 / 垂直 20）
                className="flex-1 flex-col px-6 py-5"
                accessibilityRole="button"
                accessibilityLabel={canRename ? '打开笔记，长按重命名' : '打开笔记'}
            >
                <View className="flex-row items-center justify-between">
                    <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
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
                {/* 标题（#6 重命名落点）：重命名卡的可见结果——未命名不占位，
                    有题一行截断；15px semibold = 卡题档（字号阶：与行程卡标题、
                    选择器行题同一档，一致性收敛轮从阶外 17px 归一） */}
                {journal.title ? (
                    <Text
                        numberOfLines={1}
                        className="pt-0.5 text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                    >
                        {journal.title}
                    </Text>
                ) : null}
                {/* 摘要区：flex-1 实测高度 → 行数 clamp（宁少勿截半行），overflow-hidden 兜底 */}
                <View className="min-h-0 flex-1 overflow-hidden" onLayout={onLayout}>
                    <SummaryText
                        maxLines={maxLines}
                        lineClass="text-[14px] leading-6"
                        textClass="text-ink-secondary dark:text-inkd-secondary"
                    >
                        {summary}
                    </SummaryText>
                </View>
                <View className="flex-row items-center justify-between pt-3">
                    <Text
                        className="text-[11px] text-ink-muted dark:text-inkd-muted"
                        style={{ fontVariant: ['tabular-nums'] }}
                    >
                        {mediaCount(blocks) > 0 ? `${mediaCount(blocks)} 个媒体 · ` : ''}
                        {journal.word_count} 字
                    </Text>
                    <View className="flex-row items-center">
                        <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            继续写
                        </Text>
                        <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                    </View>
                </View>
            </Pressable>
        </CardShell>
    );
}

/** 行程卡：封面（首图/首视频/徽章占位）+ 标题/状态 + 区间 + 摘要 + 进度。 */
function TripCard({
    trip,
    cover,
}: {
    trip: ReturnType<typeof useArchiveStore.getState>['trips'][number] | null;
    cover: { kind: 'image' | 'video'; fileKey: string } | null;
}) {
    const palette = usePalette();
    const { maxLines, onLayout } = useSummaryLineBudget(TRIP_SUMMARY_LINE_HEIGHT);
    if (!trip) {
        // 空态卡（对齐日记空卡语言）：留白 + 轻 CTA；点击语义在 deck 卡
        // Pressable（→ /trip/new，见 onPressCard 行程侧分支），卡内不放嵌套
        // 按压体——deck 触摸面纯净铁律不变
        return (
            <CardShell>
                {/* 卡内边距 px-6 py-5：对齐日卡口径（同层级同值） */}
                <View className="flex-1 items-center justify-center gap-2 px-6 py-5">
                    <LucideCalendar size={34} color={palette.muted} strokeWidth={1.5} />
                    <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                        还没有行程
                    </Text>
                    <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                        计划中的每一天，从这里开始
                    </Text>
                    <View className="mt-1 flex-row items-center">
                        <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            创建行程
                        </Text>
                        <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                    </View>
                </View>
            </CardShell>
        );
    }
    return (
        <CardShell>
            {cover ? (
                cover.kind === 'image' ? (
                    <DeckCoverImage
                        fileKey={cover.fileKey}
                        onPress={() =>
                            requestViewer({ kind: 'image', fileKey: cover.fileKey })
                        }
                        accessibilityLabel="预览行程照片"
                    />
                ) : (
                    <DeckCoverVideo
                        fileKey={cover.fileKey}
                        onPress={() =>
                            requestViewer({ kind: 'video', fileKey: cover.fileKey })
                        }
                    />
                )
            ) : (
                <DeckCoverPlaceholder>
                    <TripBadge icon={trip.icon} size="deck" />
                </DeckCoverPlaceholder>
            )}
            {/* 文字区卡内边距 px-6 py-5：对齐日卡口径（水平 24 / 垂直 20） */}
            <View className="flex-1 flex-col px-6 py-5">
                <View className="flex-row items-center justify-between">
                    <Text
                        numberOfLines={1}
                        className="mr-2 flex-1 text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                    >
                        {trip.title}
                    </Text>
                    <StatusChip status={trip.status} />
                </View>
                {/* 区间文案走 formatTripSpan（持续性感知）：open 端不可用 formatTripRange */}
                <Text
                    className="pt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {formatTripSpan(trip)}
                    {trip.dayCount != null ? ` · ${trip.dayCount} 天` : ''}
                </Text>
                {/* 摘要区：同日记卡口径；tone 对齐 trip-detail 描述行（secondary）——
                    同一数据（trip.description）跨屏同值（原 muted 是双轨漂移） */}
                <View className="min-h-0 flex-1 overflow-hidden" onLayout={onLayout}>
                    <SummaryText
                        maxLines={maxLines}
                        lineClass="text-[13px] leading-5"
                        textClass="text-ink-secondary dark:text-inkd-secondary"
                    >
                        {trip.description}
                    </SummaryText>
                </View>
                <View className="pt-3">
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
                            className="text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {/* 持续性行程无固定天数（dayCount = null），不渲染假分母 */}
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
                </View>
            </View>
        </CardShell>
    );
}

/**
 * 重命名设置卡（首页笔记卡长按入口）：实现收口到共享组件 ui/rename-card
 * RenameCard（与 journal-edit 屏头编辑钮入口同一语义；此前两处逐行重复的
 * 卡实现已合并）。落库通道经 onSave 注入 store.updateJournalTitle。
 */
