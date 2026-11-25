import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    BackHandler,
    Dimensions,
    Image,
    Keyboard,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { imagePicker } from '@/core/image-picker';
import {
    BouncyPressable,
    LucideCalendar,
    LucideCheck,
    LucideChevronRight,
    LucidePenLine,
    LucidePencil,
    LucideTrash,
    LucideVideo,
    LucideWallpaper,
} from '@/core/icons';
import { haptics } from '@/core/haptics';
import { tintIcon } from './ui/editor-icons';
import * as db from './db';
// 屏层直连 db 的数据变化广播（同 me-screen 头像先例）：计划增/勾/删走屏层直连
// db 的轻量行级取径，落库后推进 store revision（useArchiveStore.setState——屏层
// 直连 db 的行级操作必须走这条：notifyDataRevision 直发不在本屏订阅链上，历史
// 踩坑；store 订阅者内部桥接 notifyDataRevision，两条通道同源不漂移）。
import { useArchiveRevision, useArchiveStore } from './store';
import {
    dayDiff,
    daysInclusiveRange,
    decorateTrip,
    formatDateParts,
    formatTripSpan,
    isTripLocked,
    isTripOpenEnded,
    todayLocal,
    tripDayList,
    tripDisplayTitle,
} from './trip-logic';
import {
    dayDeckHeight,
    dayFaceTags,
    dayFacePlanPreview,
    tripDayTarget,
} from './trip-day-deck-logic';
import { parseBlocks, previewText } from './journal-logic';
import { safeBack } from './ui';
import {
    ActionMenuCard,
    CardDeck,
    CloseButton,
    LoadingView,
    ProgressBar,
    ProgressLabel,
    ScreenHeader,
    StatusChip,
    TripBadge,
    TripCoverVideo,
    useFileUrlState,
    usePalette,
    type DeckItem,
} from './ui';
// 深路径注记：DeadEndView（死路页共享视图，2026-11-10 反馈二轮）宿主在
// journal-edit-screen——两处消费屏均在本组改动权限内、单一实现源（同语言同
// 实现的收口取舍见 DeadEndView 注），未入 ui/index.ts 出口（该文件无本组
// 改动权限），域内深取；barrel 出口扩充时迁走收口（editor-icons /
// field-input 先例）。journal-edit 不反向依赖本屏，无 require 环。
import { DeadEndView } from './journal-edit-screen';

/**
 * 行程详情 = **日卡左右堆**（v0.4.7 行程域重构令 1：「进入行程列表后不再是
 * 垂直容器卡片，而是左右堆叠」——逐日 FlatList 整层退役）：
 *
 * - 信息架构：屏头 + 一条极短的「当日之外」滚动带（封面视频 / 描述 / 计划
 *   总进度 / 通知横幅）+ 日卡堆（CardDeck，与首页/堆页同一台机器同一 props，
 *   横向跟手翻、点背卡提前、露条堆影分层）。堆高走 trip-day-deck-logic 的
 *   视口比例夹紧档（无 onLayout 反馈环）；
 * - 卡面 = 那一天（DayDeckFace，v0.4.7 词表/预览口径由纯逻辑文件收口并有
 *   node 单测把关）：日期行（D 序号 20 tabular + 月日 16 + 星期 12 + 今天/
 *   出发/返程徽章）→ 计划预览 ≤3 行（勾选 + 长按删与旧形态同语义）→ 日记
 *   摘要 2 行或未写态（v0.4.9 令 2 占位文案块退场；v0.5.0 残存的「+」细边
 *   邀请也整体删除——可写空日卡中腹纯留白，锁定态一行「未写」状态事实）
 *   → 底行「当日行程 ›」行动提示。**「行程
 *   名称」依旧不上卡面**（0.4.7 既定：名称只进屏头）；
 * - 点前卡 → 该日的「行程表」页（/trip/[id]/day/[date]）；锁定行程点卡：
 *   已有日记走 /journal/[id] 只读页，无日记落行程表页只读浏览；长按（web
 *   桌面按住）→ 日卡操作卡（写这一天 / 设置背景）；
 * - 背景卡形态保留（长按设置背景后 = 纯图铺满卡面，页码走 light 色调；
 *   文件缺失三态 missing 降级回文字卡）；
 * - **纵向滚动卡顿的结构性消解**（v0.4.7 令 4）：旧形态 23 张日卡全靠一条
 *   垂直 FlatList 承载，逐帧行回收 + 每卡卡影 + 背景图解码同帧进场是「上下
 *   滑动特别卡」的主通道；新形态逐日区不再滚动——堆一次挂 ≤3 张真实卡面
 *   （deck 挂载纪律，agent A 域），页面本身只剩一条不滚也够用的短带；
 * - 载入容错（v0.4.7 修）：db 瞬时失败（启动期单运行者锁竞态等）不再一次
 *   异常就落「找不到这个行程」死路——自动重试一次（700ms 后）再降级；
 *   真删除（getTrip 返回空行）仍即时死路；
 * - 锁定（#7）：isTripLocked（已结束）→ 只读（勾选禁用、无长按操作卡、
 *   点卡只读浏览），保持既有锁定轻提示；store.setTripDayBackground 兜底拒绝。
 */

/** 逐日卡数据（堆项，稳定 key = localDate）。 */
interface DayCardData {
    localDate: string;
    /** D 序号（出发日起算；内容驱动口径下可跳号，是持续性行程的诚实呈现）。 */
    dayNo: number;
    plans: db.DayPlanRow[];
    /** 该日日记（同日唯一索引保证 ≤1 行；取首行，数组仅防御旧数据）。 */
    journal: db.JournalRow | null;
    /** 该日日记媒体计数（角标，journal_media 实际行数）。 */
    mediaCount: number;
    /** 日卡背景媒体行（无指针 / 指针悬挂 → null = 文字卡）。 */
    background: db.TripMediaRow | null;
}

/**
 * db 行逐字段浅比较（DayCardData 恒等复用的比较基元）：reload 每次查询都产出
 * 全新行对象（引用必不同），DayDeckFace（memo）要跳过「数据没变的日」就必须按值
 * 比较。行结构全部为原始类型列（schema 约定），键集长度 + 逐键 === 即全等；
 * null 与 null 相等（无日记/无背景），仅一侧 null 不等（内容出现/消失）。
 */
function sameDbRow<T extends object>(a: T | null, b: T | null): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    const aRecord = a as Record<string, unknown>;
    const bRecord = b as Record<string, unknown>;
    return aKeys.every((key) => aRecord[key] === bRecord[key]);
}

/** 计划行列表全等（长度恒等 + 逐行 sameDbRow）：勾选/新增/删除只动目标日，
 *  其余日的 plans 内容不变 → 沿用旧引用，整堆重建就此收口到单卡。 */
function samePlanList(a: db.DayPlanRow[], b: db.DayPlanRow[]): boolean {
    if (a === b) return true;
    if (a.length !== b.length) return false;
    return a.every((plan, index) => sameDbRow(plan, b[index]));
}

/** 日卡操作词表（长按操作卡；仅未锁定可达）。 */
type DayCardAction = 'write' | 'set-background';

/**
 * 日卡操作卡（长按日卡 → scrim + 居中卡，范式同媒体块操作卡 / InsertMenu，
 * 禁 RN Modal 条件渲染）：写这一天 / 设置背景（2026-11-20 用户指令：添加
 * 计划与清除背景两行退役）。锁定态入口不存在（长按手势未接），本卡不做
 * 锁定判定。
 */
function DayActionCard({
    onClose,
    onAction,
}: {
    onClose: () => void;
    onAction: (action: DayCardAction) => void;
}) {
    const palette = usePalette();

    // 打开即收键盘；Android 返回键关闭（替代 Modal onRequestClose 语义）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    // 行序：写这一天 → 设置背景（2026-11-20 用户指令：添加计划/清除背景退役）。
    // 行卡片与 InsertMenu MenuRow 同语言：icon 容器走 tintIcon 收口；行高 48 ≥44，
    // 不传 hitSlop（0），行距 gap-2.5（10px）为不可点间隙从简口径（2026-11-19
    // 用户指令）：行副标描述全线退役，标题自释
    const rows: Array<{ action: DayCardAction; icon: React.ReactNode; title: string }> = [
        { action: 'write', icon: <LucidePenLine size={20} strokeWidth={1.9} />, title: '写这一天' },
        { action: 'set-background', icon: <LucideWallpaper size={20} strokeWidth={1.9} />, title: '设置背景' },
    ];

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭卡片操作"
            >
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            日卡
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    {/* 单容器行组（+ 菜单同语言，2026-11-19 统一口径） */}
                    <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                        {rows.map((row) => (
                            <Pressable
                                key={row.action}
                                onPress={() => onAction(row.action)}
                                className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
                                accessibilityRole="button"
                                accessibilityLabel={row.title}
                            >
                                <View pointerEvents="none">{tintIcon(row.icon, palette.secondary)}</View>
                                <Text className="flex-1 text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                    {row.title}
                                </Text>
                            </Pressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

/**
 * 计划操作卡（长按计划行 → scrim + 居中卡，范式同 DayActionCard / 首页 chooser，
 * 禁 RN Modal 条件渲染）：单动作「删除计划」（negative）。
 * - 卡头直接以「删除计划」开题 + 计划原文预览：长按目标行在视觉上没有
 *   选中态，删的是什么必须说在卡里（预览 = surface 井 + 计划行同字号 14px）；
 * - 无二次确认步：计划是低频轻量条目、随时可重新添加，确认步的成本高于误删
 *   成本（软删落库 + 屏级横幅可见反馈，见 runDeletePlan 取舍注）；
 * - 危险语义全部走 negative 色（icon/题文），行结构与其余操作卡行同语言
 *   （icon 容器 + 题 + hint），颜色只上语义不上装饰。
 */
function PlanActionCard({
    content,
    onClose,
    onDelete,
}: {
    content: string;
    onClose: () => void;
    onDelete: () => void;
}) {
    const palette = usePalette();

    // 打开即收键盘（长按可能发生在内联输入态旁）；Android 返回键关闭
    //（替代 Modal onRequestClose 语义，同 DayActionCard）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose]);

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭计划操作"
            >
                {/* 卡体拦截冒泡：点卡不关（同 DayActionCard / chooser 卡体结构） */}
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            删除
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    <View className="mt-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface">
                        <Text className="text-[14px] text-ink-text dark:text-inkd-text">{content}</Text>
                    </View>
                    {/* 删除行（negative，单容器行组同语言） */}
                    <View className="mt-3 overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface">
                        <Pressable
                            onPress={onDelete}
                            className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
                            accessibilityRole="button"
                            accessibilityLabel="删除计划"
                        >
                            <View pointerEvents="none">
                                <LucideTrash size={18} strokeWidth={1.9} color={palette.negative} />
                            </View>
                            <Text className="flex-1 text-[15px] font-medium text-ink-negative dark:text-inkd-negative">
                                删除计划
                            </Text>
                        </Pressable>
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

/**
 * 日卡卡面（堆项 node，memo）：文字卡（日期行 + 计划预览 + 摘要/未写态）/
 * 背景卡（纯图铺满，deck 壳已负责圆角/纸面/卡影，卡面不再自套卡壳——
 * v0.4.6「卡体零自壳」堆纪律）。点卡/长按语义在 deck 壳层（DeckItem），
 * 卡面内部只保留计划行的勾选与长按删除。
 * 背景图走 useFileUrlState 三态：loading = raised 占位（无文字，纯底）；
 * missing = 降级文字卡（背景文件缺失是可自愈降级，不渲染坏引用）；ready = 纯图。
 * memo 生效前提（与旧 DayCard 同一契约）：data 引用恒等复用（reload 比较器）
 * + 回调全稳定——计划勾选/删除后整堆重建只重渲数据变化的单卡。
 */
const DayDeckFace = memo(function DayDeckFace({
    data,
    locked,
    endDate,
    onChanged,
    onRequestPlanDelete,
}: {
    data: DayCardData;
    locked: boolean;
    /** 固定行程的结束日（open 行程 null）——「返程」徽章判定（纯逻辑收口）。 */
    endDate: string | null;
    onChanged(): void;
    /** 长按计划行 → 删除操作卡（屏级 PlanActionCard；仅未锁定可达，锁定态
     *  计划行是非按压 View，入口天然不存在）。 */
    onRequestPlanDelete(plan: db.DayPlanRow): void;
}) {
    const palette = usePalette();
    const [actionError, setActionError] = useState<string | null>(null);

    const bg = data.background;
    const bgState = useFileUrlState(bg?.file_key ?? null);
    const showBackground = bg != null && bgState.status !== 'missing';

    const { monthDay, weekday } = formatDateParts(data.localDate);
    const tags = dayFaceTags({
        dayNo: data.dayNo,
        localDate: data.localDate,
        endDate,
        today: todayLocal(),
    });
    const journalBlocks = data.journal ? parseBlocks(data.journal.blocks) : null;
    const planPreview = dayFacePlanPreview(data.plans);

    const togglePlan = async (plan: db.DayPlanRow) => {
        try {
            await db.setDayPlanDone(plan.id, plan.done === 0);
            setActionError(null);
            onChanged();
            // store revision 推进（屏层直连 db 取径的配套，订阅链桥接广播）：计划
            // 完成度变化上浮到首页 deck 统计
            useArchiveStore.setState((s) => ({ revision: s.revision + 1 }));
        } catch (caught) {
            // 勾选态由父级 reload 数据派生（非乐观更新），失败无需回滚本地状态，但要可见报错
            setActionError(`计划状态更新失败：${caught instanceof Error ? caught.message : String(caught)}`);
        }
    };

    // ── 背景卡形态：纯图铺满卡面（用户硬口径：不渲染任何文字，点卡走 deck
    //    壳层 onPress）。loading = raised 纯占位；missing 已在上游降级文字卡 ──
    if (showBackground && bg) {
        return bgState.status === 'ready' && bgState.uri ? (
            <Image source={{ uri: bgState.uri }} className="h-full w-full" resizeMode="cover" />
        ) : (
            <View className="h-full w-full bg-ink-raised dark:bg-inkd-raised" />
        );
    }

    // ── 文字卡形态（v0.4.7 堆纪律：卡面无自壳，内边距即纸面留白 p-5=20；
    //    色彩只上数据——今天/进行中/勾选完成态 accent，字阶 20/16/12/11）──
    return (
        <View className="flex-1 flex-col p-5">
            {/* 日期行：D 序号是卡面的「大字锚」（堆叠扫读的节奏点），tabular
                数字位；徽章（今天/出发/返程）11 档 pill，accent 只上「今天」
                这枚数据事实 */}
            <View className="flex-row items-center">
                <Text
                    className="text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {`D${data.dayNo}`}
                </Text>
                <Text className="ml-2.5 text-[16px] font-semibold text-ink-text dark:text-inkd-text">
                    {monthDay}
                </Text>
                <Text className="ml-2 text-[12px] text-ink-muted dark:text-inkd-muted">{weekday}</Text>
                {tags.map((tag) => (
                    <Text
                        key={tag}
                        className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            tag === '今天'
                                ? 'bg-ink-accent-bg text-ink-accent dark:bg-inkd-accent-bg dark:text-inkd-accent'
                                : 'bg-ink-raised text-ink-secondary dark:bg-inkd-raised dark:text-inkd-secondary'
                        }`}
                    >
                        {tag}
                    </Text>
                ))}
            </View>

            {/* 计划预览（≤DAY_FACE_PLAN_LIMIT 行，勾选/长按删与旧形态同语义）；
                完成统计含隐藏行——「+N 项」说的是去向不是口径。
                44dp 命中行沿用旧口径：行本体垫高（py-3 + min-h-11 双保险）而非
                hitSlop；勾选框 accent 填充只在完成态（色只上数据） */}
            {planPreview.visible.length > 0 ? (
                <View className="mt-2">
                    {planPreview.visible.map((plan) =>
                        locked ? (
                            <View key={plan.id} className="flex-row items-center py-3 min-h-11">
                                <View
                                    className={`h-5 w-5 items-center justify-center rounded-thumb border ${
                                        plan.done === 1
                                            ? 'border-ink-accent bg-ink-accent dark:border-inkd-accent dark:bg-inkd-accent'
                                            : 'border-ink-control bg-ink-surface dark:border-inkd-control dark:bg-inkd-surface'
                                    }`}
                                >
                                    {plan.done === 1 ? (
                                        <LucideCheck size={13} color={palette.onAccent} strokeWidth={2.5} />
                                    ) : null}
                                </View>
                                <Text
                                    className={`ml-2.5 flex-1 text-[15px] ${
                                        plan.done === 1
                                            ? 'text-ink-muted line-through dark:text-inkd-muted'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                    numberOfLines={1}
                                >
                                    {plan.content}
                                </Text>
                            </View>
                        ) : (
                            <Pressable
                                key={plan.id}
                                onPress={() => void togglePlan(plan)}
                                // 长按 → 删除操作卡（与勾选点按并存于同一 Pressable：
                                // Pressability 语义长按触发后本次松手不补发 onPress；
                                // 行本体 min-h-11（44）即命中盒）
                                onLongPress={() => onRequestPlanDelete(plan)}
                                // 按压反馈（勾选态非乐观更新，active 底色即时反馈）
                                className="flex-row items-center rounded-control py-3 min-h-11 active:bg-ink-raised dark:active:bg-inkd-raised"
                                accessibilityRole="checkbox"
                                accessibilityLabel={`计划：${plan.content}`}
                                accessibilityState={{ checked: plan.done === 1 }}
                            >
                                <View
                                    className={`h-5 w-5 items-center justify-center rounded-thumb border ${
                                        plan.done === 1
                                            ? 'border-ink-accent bg-ink-accent dark:border-inkd-accent dark:bg-inkd-accent'
                                            : 'border-ink-control bg-ink-surface dark:border-inkd-control dark:bg-inkd-surface'
                                    }`}
                                >
                                    {plan.done === 1 ? (
                                        <LucideCheck size={13} color={palette.onAccent} strokeWidth={2.5} />
                                    ) : null}
                                </View>
                                <Text
                                    className={`ml-2.5 flex-1 text-[15px] ${
                                        plan.done === 1
                                            ? 'text-ink-muted line-through dark:text-inkd-muted'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                    numberOfLines={1}
                                >
                                    {plan.content}
                                </Text>
                            </Pressable>
                        ),
                    )}
                    {planPreview.hidden > 0 ? (
                        <Text
                            className="py-2 text-[12px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`+${planPreview.hidden} 项 · 当日完成 ${planPreview.done}/${data.plans.length}`}
                        </Text>
                    ) : null}
                </View>
            ) : null}

            {actionError ? (
                // 卡内失败反馈（settings 同源 tinted 横幅语言）
                <View className="mt-2 rounded-control bg-ink-negative-bg px-3 py-2 dark:bg-inkd-negative-bg">
                    <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                        {actionError}
                    </Text>
                </View>
            ) : null}

            {/* 摘要区贴底（flex-1 弹垫把「那一天写了什么」压到卡面下半——
                堆叠扫读时先见日期再见内容）；未写 = v0.5.0 口径（用户点名）：
                0.4.9 的可写态「+」细边邀请整体删除——不留占位文案、不留图标、
                不留空井，可写空日卡中腹纯留白（写入口仍由点卡/长按操作卡承载）；
                锁定态无写入口，留一行状态事实 */}
            <View className="min-h-0 flex-1 justify-end">
                {data.journal && journalBlocks ? (
                    <>
                        <Text
                            numberOfLines={2}
                            className="text-[15px] leading-6 text-ink-secondary dark:text-inkd-secondary"
                        >
                            {previewText(journalBlocks) || '[图片与视频]'}
                        </Text>
                        <View className="mt-2 flex-row items-center gap-2">
                            {data.mediaCount > 0 ? (
                                <Text
                                    className="text-[11px] text-ink-muted dark:text-inkd-muted"
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {`${data.mediaCount} 条媒体`}
                                </Text>
                            ) : null}
                            <Text
                                className={`text-[11px] ${
                                    data.journal.status === 'open'
                                        ? 'text-ink-accent dark:text-inkd-accent'
                                        : 'text-ink-muted dark:text-inkd-muted'
                                }`}
                            >
                                {data.journal.status === 'open' ? '进行中' : '已收笔'}
                            </Text>
                        </View>
                    </>
                ) : locked ? (
                    // 锁定只读：无写入口，留一行状态事实
                    <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">未写</Text>
                ) : null}
            </View>

            {/* 底行行动提示：点卡去向说清楚——未锁定/无日记读「当日行程」，
                锁定有日记读「查看日记」（提示与 tripDayTarget 分流同源，不
                撒谎）；accent 是导航语义不是装饰；D 序号/状态词上文已占位，
                此行不再复读（字阶纪律：一行只说一件事） */}
            <View className="mt-3 flex-row items-center justify-end">
                <Text className="text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                    {locked && data.journal ? '查看日记' : '当日行程'}
                </Text>
                <View pointerEvents="none">
                    <LucideChevronRight size={13} color={palette.accent} strokeWidth={2} />
                </View>
            </View>
        </View>
    );
});

export function TripDetailScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const revision = useArchiveRevision();
    const palette = usePalette();
    const setTripDayBackground = useArchiveStore((s) => s.setTripDayBackground);
    const storeError = useArchiveStore((s) => s.error);

    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    const [trip, setTrip] = useState<ReturnType<typeof decorateTrip> | null>(null);
    const [dayCards, setDayCards] = useState<DayCardData[]>([]);
    const [locked, setLocked] = useState(false);
    // dayCards 镜像（reload 内最新值）：①恒等复用比较的基准；②openDayAction
    // 免依赖读取——回调身份不随 dayCards 变化（修前 useCallback 依赖 dayCards，
    // 每次重载都换新引用，卡面（memo）被击穿、勾选/删除一 plans 行整堆重渲）
    const dayCardsRef = useRef<DayCardData[]>([]);
    // 载入瞬时失败自动重试闸（v0.4.7 修）：启动期单运行者锁竞态等瞬时 db 失败
    // 不再一次异常即落「找不到这个行程」死路（CDP 基线实测踩中）；成功/真删
    // 清除计数，重试预算 2 次（700ms / 1600ms 递增退避——真实设备锁释放的
    // 尾部时长会越过单发 700ms，双档覆盖；死路语义仍是最终可重试降级）
    const loadRetryRef = useRef(0);
    const loadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 背景设置流守卫（相册 picker 异步窗口防重入；无常驻指示器——picker 自带 UI）
    const [busy, setBusy] = useState(false);
    // 日卡操作流：长按日卡 → 操作卡（单件，date 定位目标日）
    const [dayActionDate, setDayActionDate] = useState<string | null>(null);
    // 计划删除流：长按计划行 → 操作卡（id + 计划原文，卡内预览删的是什么）
    const [planAction, setPlanAction] = useState<{ id: string; content: string } | null>(null);
    // 封面视频管理菜单（长按封面视频 → 更换/移除，2026-11-19 用户指令「行程 ui
    // 长按视频封面没有办法更改删除」）：仅未锁定可达
    const [coverMenu, setCoverMenu] = useState(false);
    // 删除可见反馈横幅（软删+可见反馈口径）：短带呈现，at 供自动消退
    // effect 精确复位（连删两条同文计划时计时器也能正确重启）
    const [deleteNotice, setDeleteNotice] = useState<{ text: string; at: number } | null>(null);

    // 删除横幅自动消退（4s）：删除是即时完成态，横幅是「发生了什么」的一次性
    // 确认而非常驻状态（DeadEndView 6s 自动返回同类的轻量定时收口）
    useEffect(() => {
        if (!deleteNotice) return;
        const timer = setTimeout(() => setDeleteNotice(null), 4000);
        return () => clearTimeout(timer);
    }, [deleteNotice]);

    const reload = useCallback(async () => {
        if (typeof id !== 'string') {
            setMissing(true);
            setLoading(false);
            return;
        }
        try {
            const row = await db.getTrip(id);
            if (!row) {
                setMissing(true);
                return;
            }
            const [planRows, journalRows, backgrounds] = await Promise.all([
                db.listDayPlansByTrip(id),
                db.listJournalsByTrip(id),
                db.getTripDayBackgroundsByTrip(id),
            ]);
            const mediaByJournal = await db.mediaByJournalIds(journalRows.map((j) => j.id));
            const plansByDate = new Map<string, db.DayPlanRow[]>();
            for (const plan of planRows) {
                const bucket = plansByDate.get(plan.local_date);
                if (bucket) bucket.push(plan);
                else plansByDate.set(plan.local_date, [plan]);
            }
            const journalsByDate = new Map<string, db.JournalRow[]>();
            for (const journal of journalRows) {
                const bucket = journalsByDate.get(journal.local_date);
                if (bucket) bucket.push(journal);
                else journalsByDate.set(journal.local_date, [journal]);
            }
            // 日记媒体计数角标（按日聚合 journal_media 实际行数）
            const mediaCountByDate = new Map<string, number>();
            for (const journal of journalRows) {
                const n = mediaByJournal.get(journal.id)?.length ?? 0;
                if (n === 0) continue;
                mediaCountByDate.set(journal.local_date, (mediaCountByDate.get(journal.local_date) ?? 0) + n);
            }
            const today = todayLocal();
            // 逐日骨架：固定区间走 tripDayList（open 安全入口，内部才调 daysInclusiveRange；
            // 直接调会对 open 抛 RangeError → 被 catch 误判「行程不存在」）；持续性行程
            // 改走内容驱动口径（有内容的日子 ∪ 出发日 ∪ 今天），tripDayList 返回 null。
            // 遗留越界数据（跨度 >366 天）令 tripDayList 抛错时同样降级为内容驱动，
            // 不把数据问题放大成「行程不存在」。
            let days: string[] | null = null;
            if (!isTripOpenEnded(row)) {
                try {
                    days = tripDayList(row);
                } catch {
                    days = null;
                }
            }
            if (days === null) {
                // 持续性行程（R2「每天自动创建第二天的行程卡片」）：出发日到今天
                // **逐日枚举**——每天自动长出新一格，不再依赖「有内容才出现」；
                // 跨度超 366 天上限（daysInclusiveRange 抛 RangeError）或出发日在
                // 未来时，降级为内容驱动口径（出发日 ∪ 今天 ∪ 有内容的日子），
                // 不把数据规模问题放大成「行程不存在」。枚举结果仍并入内容日：
                // 起点被改晚等边界数据里 [start, today] 窗口外的旧内容不丢。
                let enumerated: string[] | null = null;
                if (today >= row.start_date) {
                    try {
                        enumerated = daysInclusiveRange(row.start_date, today);
                    } catch {
                        enumerated = null;
                    }
                }
                if (enumerated) {
                    const dateSet = new Set<string>(enumerated);
                    for (const plan of planRows) dateSet.add(plan.local_date);
                    for (const journal of journalRows) dateSet.add(journal.local_date);
                    days = [...dateSet].sort();
                } else {
                    const dateSet = new Set<string>([row.start_date]);
                    if (today >= row.start_date) dateSet.add(today);
                    for (const plan of planRows) dateSet.add(plan.local_date);
                    for (const journal of journalRows) dateSet.add(journal.local_date);
                    days = [...dateSet].sort();
                }
            }
            const start = row.start_date;
            // DayCardData 恒等复用（#15：计划勾选/删除/添加只重渲目标日）：db 行每次
            // 查询都是新引用，逐字段全等的日沿用旧对象引用——DayDeckFace（memo）据此
            // 跳过未变日的重渲；行程日期变化经 dayNo/骨架 keys 差异自然失效，不吞更新
            const prevByDate = new Map(dayCardsRef.current.map((card) => [card.localDate, card]));
            const nextCards: DayCardData[] = days.map((localDate) => {
                const plans = plansByDate.get(localDate) ?? [];
                const journal = journalsByDate.get(localDate)?.[0] ?? null;
                const mediaCount = mediaCountByDate.get(localDate) ?? 0;
                const background = backgrounds.get(localDate) ?? null;
                const dayNo = Math.max(1, dayDiff(start, localDate) + 1);
                const prev = prevByDate.get(localDate);
                if (
                    prev &&
                    prev.dayNo === dayNo &&
                    prev.mediaCount === mediaCount &&
                    samePlanList(prev.plans, plans) &&
                    sameDbRow(prev.journal, journal) &&
                    sameDbRow(prev.background, background)
                ) {
                    return prev;
                }
                return { localDate, dayNo, plans, journal, mediaCount, background };
            });
            dayCardsRef.current = nextCards;
            setDayCards(nextCards);
            // 时间线摘除背景图的旧逻辑随媒体时间线退役；trip_media 行仅剩日卡
            // 背景（getTripDayBackgroundsByTrip）与 deck 封面（屏外消费）两个出口
            setLocked(isTripLocked(row, today));
            setTrip(decorateTrip(row, today));
            setMissing(false);
            loadRetryRef.current = 0;
        } catch {
            // db 抛错区分两类：瞬时失败（启动竞态/锁）自动重试一次；再失败才走
            // 「行程不存在」降级态（可重试语义，不能永久卡 Loading + unhandled
            // rejection）。真删除在上面按 row==null 即时死路，不占本重试预算。
            if (loadRetryRef.current < 2) {
                loadRetryRef.current += 1;
                clearTimeout(loadRetryTimerRef.current);
                loadRetryTimerRef.current = setTimeout(() => void reload(), loadRetryRef.current === 1 ? 700 : 1600);
                return;
            }
            setMissing(true);
            setLoading(false);
        } finally {
            if (loadRetryRef.current === 0) setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void reload();
    }, [reload, revision]);
    // 重试定时器卸载收口（导航离开后不得再触 setState 链）
    useEffect(
        () => () => {
            clearTimeout(loadRetryTimerRef.current);
        },
        [],
    );

    // ── 日卡背景流（长按操作卡 → 相册选图 / 直接清除）──

    /**
     * 长按日卡 → 操作卡（回调身份恒定——openDayAction 传给每个堆项，若随
     * dayCards 重载换引用，卡面（memo）会被击穿，计划勾选整堆重渲的根因
     * 之一，已修）。
     */
    const openDayAction = useCallback((date: string) => {
        setDayActionDate(date);
    }, []);

    /** 长按计划行 → 删除操作卡（屏级单件；回调恒定，同 openDayAction 稳定性口径）。 */
    const requestPlanDelete = useCallback((plan: db.DayPlanRow) => {
        setPlanAction({ id: plan.id, content: plan.content });
    }, []);

    /**
     * 删除计划：**直接删 + 横幅，无二次确认步**（取舍：计划是低频轻量条目、
     * 随时可在当天重新添加，确认步的打断成本高于误删成本；软删落库 + 屏级
     * 横幅可见反馈，不采用「可撤销」——撤销需引入行复活通道，成本不匹配）。
     * 落库 = 屏层直连 db.softDeleteDayPlan（软删域约定，轻量行级操作不经
     * store——同本屏 setDayPlanDone 的既有取径变体）；
     * 刷新 = onChanged 本屏列表重载（同计划添加/勾选通道）+
     * store revision 推进（首页 deck 统计、use-file-url 等订阅者
     * 复验；store mutation 的广播由 store 内部转发，两条通道同源）。
     * 失败走 store.error 通道（同背景设置/清除失败口径），行未删不弹横幅。
     */
    const runDeletePlan = useCallback(
        async (planId: string, content: string) => {
            try {
                await db.softDeleteDayPlan(planId, Date.now());
                setDeleteNotice({ text: `已删除计划「${content}」`, at: Date.now() });
                void reload();
                useArchiveStore.setState((s) => ({ revision: s.revision + 1 }));
            } catch (caught) {
                useArchiveStore.setState({
                    error: `计划删除失败：${caught instanceof Error ? caught.message : String(caught)}`,
                });
            }
        },
        [reload],
    );

    /** 设置背景：权限 → 选图 → store.setTripDayBackground（成功 revision 自动 reload）。 */
    const runSetBackground = async (date: string) => {
        setDayActionDate(null);
        if (!trip || locked) return;
        if (busy) {
            useArchiveStore.setState({ error: '上一个操作还在保存，稍等一下。' });
            return;
        }
        setBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    useArchiveStore.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                quality: 1,
                exif: false,
            });
            if (result.canceled || result.assets.length === 0) return;
            const asset = result.assets[0];
            await setTripDayBackground(trip.id, date, asset.uri, asset.width ?? null, asset.height ?? null);
        } catch (caught) {
            useArchiveStore.setState({
                error: `背景设置失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setBusy(false);
        }
    };

    /** 更换封面视频：相册权限 → 选视频 → store.attachTripVideo（key 规则
        trip-video/<id>.mp4，成功 revision 自动 reload）。未锁定可达（locked
        时长按入口已关断）。 */
    const runReplaceCoverVideo = async () => {
        setCoverMenu(false);
        if (!trip || locked || busy) {
            useArchiveStore.setState({ error: '上一个操作还在保存，稍等一下。' });
            return;
        }
        setBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) {
                    useArchiveStore.setState({ error: '没有相册权限，去系统设置里开一下。' });
                    return;
                }
            }
            const result = await imagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 });
            if (result.canceled || result.assets.length === 0) return;
            await useArchiveStore.getState().attachTripVideo(trip.id, result.assets[0].uri);
        } catch (caught) {
            useArchiveStore.setState({
                error: `封面视频更换失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setBusy(false);
        }
    };

    /** 移除封面视频：store.updateTrip videoKey = null（原文件清理随软删链路）。 */
    const runRemoveCoverVideo = async () => {
        setCoverMenu(false);
        if (!trip || locked) return;
        try {
            await useArchiveStore.getState().updateTrip(trip.id, { videoKey: null });
        } catch (caught) {
            useArchiveStore.setState({
                error: `封面视频移除失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        }
    };

    /** 点前卡 → 当日行程表页（锁定分流见 tripDayTarget 注）。 */
    const openDay = useCallback(
        (card: DayCardData) => {
            if (!trip) return;
            const target = tripDayTarget(locked, card.journal);
            if (target.kind === 'journal') {
                router.push({ pathname: '/journal/[id]', params: { id: target.id } });
                return;
            }
            router.push(`/trip/${trip.id}/day/${card.localDate}`);
        },
        [locked, trip, router],
    );

    // ── 堆项装配（v0.4.7 重构核心）──
    // 引用稳定纪律同旧 renderDayCard：dayCards（恒等复用）+ locked + trip 变化
    // 才重建数组；face（memo）按 data/回调恒等跳过未变日。背景卡页码走 light
    // 色调（deck 契约：渐变/图片卡面白页码）。
    const deckItems = useMemo<DeckItem[]>(() => {
        if (!trip) return [];
        const endDate = isTripOpenEnded(trip) ? null : trip.end_date;
        return dayCards.map((card) => {
            const { monthDay, weekday } = formatDateParts(card.localDate);
            const hasBg = card.background != null;
            return {
                key: `day-${card.localDate}`,
                accessibilityLabel: `D${card.dayNo} ${monthDay} ${weekday}${
                    hasBg ? '，有背景图' : card.journal ? '，已写' : '，未写'
                }，点开这一天`,
                pageLabelTone: hasBg ? ('light' as const) : undefined,
                onPress: () => openDay(card),
                onLongPress: locked ? undefined : () => openDayAction(card.localDate),
                node: (
                    <DayDeckFace
                        data={card}
                        locked={locked}
                        endDate={endDate}
                        onChanged={reload}
                        onRequestPlanDelete={requestPlanDelete}
                    />
                ),
            };
        });
    }, [trip, dayCards, locked, openDay, openDayAction, requestPlanDelete, reload]);

    // 堆高：视口比例夹紧档（纯函数有单测；旋转/窗口变化经 Dimensions 读取，
    // 详情屏低频重挂，不走 useWindowDimensions 常驻订阅——滚动页不需要
    // 每帧高度响应，那正是旧 FlatList 反馈环要防的东西）
    const deckHeight = dayDeckHeight(Dimensions.get('window').height);

    if (loading) return <LoadingView />;

    if (missing || !trip) {
        return (
            // 外层 insets.top 口径保持不动（屏头带与正常视图逐 dp 对齐）；
            // 内容块整体下移一档（2026-11-09 反馈）保留：屏头之下 pt-8 呼吸带。
            // 死路页交互重做（2026-11-10 反馈二轮）：与 journal-edit 载入失败
            // 视图同一实现（DeadEndView 共享组件，取舍与行为矩阵见其注）——
            // 动作区与内容间距 24→48dp（净增 24dp）、整页点按回首页、6s 无操作
            // 自动返回；「返回」钮仍 safeBack（点按即停倒计时，导航卸载收口）
            <View className="flex-1 bg-ink-base dark:bg-inkd-base" style={{ paddingTop: insets.top }}>
                <ScreenHeader title="行程" />
                <View className="flex-1 pt-8">
                    <DeadEndView
                        icon={<LucideCalendar size={40} color={palette.muted} strokeWidth={1.5} />}
                        title="找不到这个行程"
                        hint="它可能已被删除。回到 Archive 看看其他内容。"
                        actionLabel="返回"
                        onAction={safeBack}
                    />
                </View>
            </View>
        );
    }

    const openEnded = isTripOpenEnded(trip);
    const writtenDays = dayCards.filter((card) => card.journal != null).length;
    // 「已写」口径：open 行程无固定分母（trip.dayCount = null），不做 N/M 假分母
    const writtenLabel = openEnded ? `已写 ${writtenDays} 天` : `已写 ${writtenDays}/${dayCards.length} 天`;
    const plansTotal = dayCards.reduce((sum, card) => sum + card.plans.length, 0);
    const plansDone = dayCards.reduce((sum, card) => sum + card.plans.filter((p) => p.done === 1).length, 0);

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头内联（几何同 ScreenHeader：px-6 pb-3 pt-2 / h-11 行）：ScreenHeader 的
                    title 槽只收 string，装不下 TripBadge 徽章，故按其规格展开。
                    命中区核算：返回钮 = CloseButton 44 圆形触感底盒（#8 打磨轮：
                    裸图标箭头升级，替代旧 36 盒 + hitSlop 10）；编辑钮 = 36 视觉盒 +
                    hitSlop 10 → 56×56 ≥44 规范；返回钮 44 盒（无 slop）与右邻徽章 40
                    为非按压体（间距 ml-2 停车距），标题 flex-1 收缩让位。锁定态编辑
                    钮整体不渲染（#7 只读），标题独占行尾。 */}
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <View className="ml-2">
                            <TripBadge icon={trip.icon} size="detail" />
                        </View>
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[24px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {tripDisplayTitle(trip.title)}
                        </Text>
                        {!locked ? (
                            <BouncyPressable
                                onPress={() =>
                                    router.push({ pathname: '/trip/[id]/edit', params: { id: trip.id } })
                                }
                                scaleTo={0.9}
                                hitSlop={10}
                            >
                                {/* 无障碍属性挂内层 View（BouncyPressable 契约不透传） */}
                                <View
                                    accessibilityRole="button"
                                    accessibilityLabel="编辑行程"
                                    className="h-9 w-9 items-center justify-center rounded-control border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface"
                                >
                                    <LucidePencil size={16} strokeWidth={1.9} color={palette.secondary} />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>
                    {/* 核心内容主体行：状态片（颜色只上状态这一数据）+ formatTripSpan
                        （区间文案唯一入口，open 行程安全）+ 已写口径 */}
                    <View className="mt-1.5 flex-row items-center gap-2">
                        <StatusChip status={trip.status} />
                        <Text
                            numberOfLines={1}
                            className="min-w-0 flex-1 text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`${formatTripSpan(trip)} · ${writtenLabel}`}
                        </Text>
                    </View>
                    {locked ? (
                        // #7 锁定轻提示：只读浏览的显式声明（不放图标，一行弱文本足够）
                        <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">
                            行程已完成，内容锁定
                        </Text>
                    ) : null}
                </View>

                {/* 当日之外的短滚动带（v0.4.7 重构：日卡本体进堆、不占滚动；
                    本带只装封面/描述/进度/横幅——整页位移 ≤一屏，纵向滚动从
                    「23 张卡的回收风暴」退化为「几乎不用滚」，卡顿主通道就此
                    结构关闭）。单级 ScrollView，无嵌套容器。 */}
                <ScrollView
                    className="flex-1"
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 28,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 668,
                    }}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    {storeError ? (
                        // store.error 通道（背景设置/清除失败等）统一在此可见：
                        // v0.4.7 令 3 对齐 settings——tinted 横幅卡，不再裸行
                        <View className="mb-3 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                            <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                {storeError}
                            </Text>
                        </View>
                    ) : null}
                    {deleteNotice ? (
                        // 计划删除成功横幅（软删+可见反馈口径，4s 自动消退）：
                        // settings 完成横幅同款 surface 卡 + secondary 字——完成态
                        // 确认不是错误也不是行动邀请
                        <View className="mb-3 rounded-control bg-ink-surface px-4 py-3 dark:bg-inkd-surface">
                            <Text className="text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                {deleteNotice.text}
                            </Text>
                        </View>
                    ) : null}
                    {trip.video_key ? (
                        <View className="mb-4">
                            {/* 长按封面 → 封面管理菜单（更换/移除；锁定态长按
                                入口关断，#7 只读） */}
                            <TripCoverVideo
                                fileKey={trip.video_key}
                                height={160}
                                onCoverAction={
                                    locked
                                        ? undefined
                                        : () => {
                                              haptics.impact('medium');
                                              setCoverMenu(true);
                                          }
                                }
                            />
                        </View>
                    ) : null}
                    {trip.description ? (
                        <Text className="mb-4 text-[16px] leading-6 text-ink-secondary dark:text-inkd-secondary">
                            {trip.description}
                        </Text>
                    ) : null}
                    {plansTotal > 0 ? (
                        <View className="mb-4">
                            <ProgressBar done={plansDone} total={plansTotal} />
                            <View className="mt-1">
                                <ProgressLabel done={plansDone} total={plansTotal} />
                            </View>
                        </View>
                    ) : null}

                    {/* 逐日区头：堆叠的开场白（open 无固定分母不报天数）+
                        右注操作提示（左右翻 · 点卡进当日——新形态的读法一句话说清） */}
                    <View className="mb-3 flex-row items-baseline justify-between">
                        <View className="flex-row items-baseline">
                            <Text className="text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                逐日
                            </Text>
                            {!openEnded ? (
                                <Text
                                    className="ml-2 text-[11px] text-ink-muted dark:text-inkd-muted"
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {`共 ${dayCards.length} 天`}
                                </Text>
                            ) : null}
                        </View>
                        <Text className="text-[11px] text-ink-faint dark:text-inkd-faint">左右翻 · 点卡看当日</Text>
                    </View>

                    {/* 日卡左右堆（deck 现 props 消费，卡面无自壳；水平居中
                        阅读列 + 屏边距与首页/堆页同构图） */}
                    <CardDeck items={deckItems} height={deckHeight} />
                </ScrollView>
            </View>
            {/* 覆盖层（条件渲染，禁 Modal）：日卡操作卡单件（写这一天 / 设置背景）
                ——媒体动作/拍摄/录音/删除确认随「行程媒体」时间线退役，添加计划/
                清除背景 2026-11-20 用户指令退役 */}
            {dayActionDate ? (
                <DayActionCard
                    onClose={() => setDayActionDate(null)}
                    onAction={(action) => {
                        setDayActionDate(null);
                        if (action === 'set-background') {
                            void runSetBackground(dayActionDate);
                            return;
                        }
                        router.push(`/trip/${trip.id}/write/${dayActionDate}`);
                    }}
                />
            ) : null}
            {/* 覆盖层（条件渲染，禁 Modal）：计划删除操作卡（长按计划行入口）——
                与日卡操作卡互斥可达（scrim 盖屏时另一入口不可触） */}
            {planAction ? (
                <PlanActionCard
                    content={planAction.content}
                    onClose={() => setPlanAction(null)}
                    onDelete={() => {
                        const { id: deadPlanId, content } = planAction;
                        setPlanAction(null);
                        void runDeletePlan(deadPlanId, content);
                    }}
                />
            ) : null}
            {/* 封面视频管理菜单（长按封面入口，单容器 ActionMenuCard） */}
            {coverMenu && trip ? (
                <ActionMenuCard
                    title="封面"
                    rows={[
                        {
                            key: 'replace',
                            icon: <LucideVideo size={18} strokeWidth={1.9} />,
                            title: '更换视频',
                        },
                        {
                            key: 'remove',
                            icon: <LucideTrash size={18} strokeWidth={1.9} />,
                            title: '移除视频',
                            danger: true,
                        },
                    ]}
                    onAction={(key) => {
                        if (key === 'replace') void runReplaceCoverVideo();
                        else void runRemoveCoverVideo();
                    }}
                    onClose={() => setCoverMenu(false)}
                />
            ) : null}
        </View>
    );
}
