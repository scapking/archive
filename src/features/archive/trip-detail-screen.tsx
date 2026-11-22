import { memo, useCallback, useEffect, useRef, useState } from 'react';
import {
    BackHandler,
    FlatList,
    Image,
    Keyboard,
    Pressable,
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
    LucideImage,
    LucidePenLine,
    LucideTrash,
    LucideVideo,
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
import { parseBlocks, previewText } from './journal-logic';
import { safeBack } from './ui';
import {
    ActionMenuCard,
    CloseButton,
    LoadingView,
    ProgressBar,
    ProgressLabel,
    ScreenHeader,
    StatusChip,
    TripBadge,
    TripCoverVideo,
    useBlockActionGestures,
    useFileUrlState,
    usePalette,
} from './ui';
// 深路径注记：DeadEndView（死路页共享视图，2026-11-10 反馈二轮）宿主在
// journal-edit-screen——两处消费屏均在本组改动权限内、单一实现源（同语言同
// 实现的收口取舍见 DeadEndView 注），未入 ui/index.ts 出口（该文件无本组
// 改动权限），域内深取；barrel 出口扩充时迁走收口（editor-icons /
// field-input 先例）。journal-edit 不反向依赖本屏，无 require 环。
import { DeadEndView } from './journal-edit-screen';

/**
 * 行程详情 = 逐日卡片列表（行程逐日卡重构，v6——媒体时间线退役 + 日卡现代化）：
 *
 * - 信息架构：屏头 + 列表头（封面视频 / 描述 / 计划总进度）+ 一天一张日卡
 *   （FlatList，稳定 key = localDate，可一直滑动；固定区间 tripDayList 出
 *   D1…Dn，持续性行程走内容驱动口径 ∪ 出发日 ∪ 今天）。**「行程媒体」横滑
 *   时间线整体移除**（用户口径：只要卡片；trip_media 数据不动——日卡背景与
 *   deck 封面仍消费），添加/删除媒体入口与确认卡随之退役；
 * - 日卡两个形态：
 *   ①文字卡（现代化视觉：base 上 surface 卡 tone 分层、无描边无阴影，卡内
 *     分区靠留白不靠线；数字位 tabular-nums）：日期行（D 序号 + M月D日 +
 *     星期 + 今天角标）→ 该日 plans 勾选行 → 摘要（journal previewText +
 *     meta 行：媒体计数 + 收笔状态）→ 未写邀请态。颜色只上数据：今天/进行中/
 *     勾选完成态用 accent，其余中性灰阶；
 *   ②背景卡：长按 → 操作卡设置背景后，该卡 = 纯背景图（铺满 rounded-card16、
 *     cover，不渲染日期/目标/描述等任何文字，仅保留点按进日页）；背景文件
 *     缺失（三态 missing）时降级回文字卡；
 * - 点卡片 → 该日的「行程表」页（2026-11-19 重构：/trip/[id]/day/[date]，deck
 *   浏览当天行程项，不再直达日记编辑器；写日记入口保留在长按操作卡「写这一天」，
 *   write 路由原样保留）；锁定行程点卡：已有日记仍走 /journal/[id] 只读页
 *   （保持只读内容原访问路径），无日记则落行程表页只读浏览（无写入口）；
 * - 卡片操作入口：长按卡（web 桌面双击，useBlockActionGestures 同媒体块范式）
 *   → 日卡操作卡（写这一天 / 设置背景；2026-11-20 用户指令收窄——添加计划
 *   与清除背景两行退役），scrim + 居中卡（禁 RN Modal，条件渲染）。极简口径
 *   选长按而非卡角落图标：卡面保持纯内容（背景卡更是「不显示任何文字」的
 *   硬口径，角落图标会破功），且与媒体块长按操作卡是同一套交互语言。计划的
 *   创建入口在行程表页（/trip/[id]/day/[date]「添加行程项」）；背景设置后无
 *   卡片级清除入口，换图直接再设一次（旧图由 setTripDayBackground 清理）；
 * - **计划长按删除（2026-11-11 反馈三）**：计划行（未锁定）长按 → 删除操作卡
 *   （scrim + 居中卡，同范式；卡内预览计划原文）→ 直接删（db.softDeleteDayPlan
 *   软删，屏层直连 db 不经 store——轻量行级取径，同本屏 setDayPlanDone 的既有
 *   变体）+ 屏级横幅可见反馈（4s 自动消退）+ store revision 推进（订阅链桥接
 *   广播；notifyDataRevision 直发不在本屏订阅链，历史踩坑勿回填）；
 *   与勾选点按并存（Pressability 长按触发后不补发 onPress）；计划勾/删均
 *   广播数据版本，首页 deck 的计划完成度统计不再滞留旧值；
 * - 锁定（#7）：isTripLocked（已结束）→ 卡片只读（勾选禁用、无长按操作卡、
 *   点卡只读浏览），保持既有锁定轻提示；store.setTripDayBackground 兜底拒绝。
 */

/** 逐日卡片数据（FlatList 项，key = localDate 稳定）。 */
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
 * 全新行对象（引用必不同），DayCard（memo）要跳过「数据没变的日」就必须按值
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
 *  其余日的 plans 内容不变 → 沿用旧引用，整列重渲就此收口到单卡。 */
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
    // 行卡片与 InsertMenu MenuRow 同语言：icon 容器 40×40 rounded-control + raised
    // 触感底；行高 ~72 ≥44，不传 hitSlop（0），行距 gap-2.5（10px）为不可点间隙
    // 从简口径（2026-11-19 用户指令）：行副标描述全线退役，标题自释
    const rows: Array<{ action: DayCardAction; icon: React.ReactNode; title: string }> = [
        { action: 'write', icon: <LucidePenLine size={20} strokeWidth={1.9} />, title: '写这一天' },
        { action: 'set-background', icon: <LucideImage size={20} strokeWidth={1.9} />, title: '设置背景' },
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
 *   （icon 容器 40×40 raised 底 + 题 + hint），颜色只上语义不上装饰。
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
 * 逐日卡片（列表主体，memo）：文字卡（日期 + 目标 + 摘要）/ 背景卡（纯图）双形态。
 * 点卡 → 该日行程表页（未锁定 /trip/[id]/day/[date]；锁定且已有日记走
 * /journal/[id] 只读，无日记同样落行程表页只读浏览）；
 * 长按（web 桌面双击）→ 日卡操作卡（onRequestAction，仅未锁定）。
 * 背景图走 useFileUrlState 三态：loading = raised 占位（无文字，纯底）；
 * missing = 降级文字卡（背景文件缺失是可自愈降级，不渲染坏引用）；ready = 纯图。
 */
const DayCard = memo(function DayCard({
    tripId,
    data,
    locked,
    onChanged,
    onRequestAction,
    onRequestPlanDelete,
}: {
    tripId: string;
    data: DayCardData;
    locked: boolean;
    onChanged(): void;
    onRequestAction(date: string): void;
    /** 长按计划行 → 删除操作卡（屏级 PlanActionCard；仅未锁定可达，锁定态
     *  计划行是非按压 View，入口天然不存在）。 */
    onRequestPlanDelete(plan: db.DayPlanRow): void;
}) {
    const router = useRouter();
    const palette = usePalette();
    const [actionError, setActionError] = useState<string | null>(null);

    const bg = data.background;
    const bgState = useFileUrlState(bg?.file_key ?? null);
    const showBackground = bg != null && bgState.status !== 'missing';

    const { monthDay, weekday } = formatDateParts(data.localDate);
    const isToday = data.localDate === todayLocal();
    const journalBlocks = data.journal ? parseBlocks(data.journal.blocks) : null;

    // 进日页（2026-11-19 行程表重构）：未锁定 = 「行程表」页（/trip/[id]/day/[date]，
    // 当天行程项 deck），不再直达日记编辑器——写日记入口保留在长按操作卡「写这一
    // 天」（write 路由原样保留）；锁定 = 已有日记走 /journal/[id] 只读页（只读
    // 内容原访问路径不变），无日记则落行程表页只读浏览（无写入口，不凭空建页）
    const open = useCallback(() => {
        if (!locked || !data.journal) {
            router.push(`/trip/${tripId}/day/${data.localDate}`);
            return;
        }
        router.push({ pathname: '/journal/[id]', params: { id: data.journal.id } });
    }, [locked, tripId, data.localDate, data.journal, router]);

    // 卡片手势：长按（web 桌面双击）→ 操作卡仅未锁定；锁定仅剩点按（只读路径）
    const gestures = useBlockActionGestures({
        enabled: !locked,
        onBlockAction: !locked ? () => onRequestAction(data.localDate) : undefined,
        onSinglePress: open,
    });

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

    // ── 背景卡形态：铺满 rounded-card16 cover，不渲染任何文字（用户硬口径）。
    //    loading = raised 纯占位；missing 已在上游降级为文字卡 ──
    if (showBackground && bg) {
        return (
            <View className="mb-4">
                <BouncyPressable onPress={gestures.onPress} onLongPress={gestures.onLongPress} scaleTo={0.985}>
                    <View
                        className="h-56 w-full overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
                        accessibilityRole="button"
                        accessibilityLabel={`D${data.dayNo} ${monthDay} ${weekday}，有背景图，点开这一天`}
                    >
                        {bgState.status === 'ready' && bgState.uri ? (
                            <Image source={{ uri: bgState.uri }} className="h-full w-full" resizeMode="cover" />
                        ) : null}
                    </View>
                </BouncyPressable>
            </View>
        );
    }

    // ── 文字卡形态（现代化：base 上 surface tone 分层，无描边无阴影；卡内
    //    分区靠留白不靠线；色彩只上数据——今天/进行中/勾选完成态 accent）。
    //    内边距口径（#尺寸组反馈）：水平 px-6（24，内容距卡缘 ≥20 档的上档）；
    //    垂直日期行 pt-5（20）/ 摘要区 pb-5（20），顶底留白均 ≥18；min-h-[150px]
    //    默认体量（空/未写邀请态卡不干瘪，内容不足时由卡体撑住）──
    return (
        <View className="mb-4">
            <BouncyPressable onPress={gestures.onPress} onLongPress={gestures.onLongPress} scaleTo={0.985}>
                <View
                    className="min-h-[150px] rounded-card bg-ink-surface px-6 dark:bg-inkd-surface"
                    accessibilityRole="button"
                    accessibilityLabel={`D${data.dayNo} ${monthDay} ${weekday}${data.journal ? '，已写' : '，未写'}，点开这一天`}
                >
                    {/* 日期行（「时间」槽：数据无独立时刻字段，日期 + 序日即时间轴）。
                        数字位 tabular-nums 建立节奏；今天角标 = 数据状态上 accent；
                        pt-5（20）顶留白：卡内首元素距卡缘 ≥18 口径（原 pt-4=16 贴边） */}
                    <View className="flex-row items-baseline pt-5">
                        <Text
                            className="text-[12px] text-ink-secondary dark:text-inkd-secondary"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`D${data.dayNo}`}
                        </Text>
                        <Text className="ml-2.5 text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            {monthDay}
                        </Text>
                        <Text className="ml-2 text-[12px] text-ink-muted dark:text-inkd-muted">{weekday}</Text>
                        {isToday ? (
                            <Text className="ml-2 text-[11px] font-medium text-ink-accent dark:text-inkd-accent">
                                今天
                            </Text>
                        ) : null}
                    </View>

                    {/* 行程目标（该日 day_plans）：锁定 = 只读行（不可按压，避免「点了
                        禁用框却跳页」的语义错位）；未锁定 = 可勾选（复用 setDayPlanDone）。
                        44px 命中行：行本体垫高（py-3 + min-h 双保险）而非 hitSlop——相邻
                        行间距小于 2×slop 会命中区交叠误触；勾选框 rounded-thumb（8）在
                        半径 token 体系内，完成态 accent 填充（色只上数据） */}
                    {data.plans.map((plan) =>
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
                                    className={`ml-2.5 flex-1 text-[14px] ${
                                        plan.done === 1
                                            ? 'text-ink-muted line-through dark:text-inkd-muted'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                >
                                    {plan.content}
                                </Text>
                            </View>
                        ) : (
                            <Pressable
                                key={plan.id}
                                onPress={() => void togglePlan(plan)}
                                // 长按 → 删除操作卡（PlanActionCard，屏级单件）：与勾选
                                // 点按并存于同一 Pressable——Pressability 语义长按触发后
                                // 本次松手不补发 onPress，勾选与删除天然二选一；行本体
                                // min-h-11（44）即命中盒，长按目标区与勾选区一致
                                onLongPress={() => onRequestPlanDelete(plan)}
                                // 按压反馈补齐（一致性收敛轮）：勾选态非乐观更新（落库后
                                // reload 才变），行本体给 active 底色即时反馈，语言同
                                // Me/搜索行卡（active:bg-ink-raised）
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
                                    className={`ml-2.5 flex-1 text-[14px] ${
                                        plan.done === 1
                                            ? 'text-ink-muted line-through dark:text-inkd-muted'
                                            : 'text-ink-text dark:text-inkd-text'
                                    }`}
                                >
                                    {plan.content}
                                </Text>
                            </Pressable>
                        ),
                    )}

                    {actionError ? (
                        <Text className="pt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {actionError}
                        </Text>
                    ) : null}

                    {/* 摘要区（该日 journal）：previewText 2-3 行 + meta 一行（媒体计数
                        角标 + 收笔状态，一处 meta 收口、密度克制）；未写 = 邀请态
                        （空态是行动邀请，不是 mood 板）；pb-5（20）底留白：卡内末元素
                        距卡缘 ≥18 口径（原 pb-4=16 贴边） */}
                    <View className="pb-5 pt-3.5">
                        {data.journal && journalBlocks ? (
                            <>
                                <Text
                                    numberOfLines={3}
                                    className="text-[14px] leading-6 text-ink-secondary dark:text-inkd-secondary"
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
                        ) : (
                            <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                                {locked ? '未写' : '未写，点开写这一天'}
                            </Text>
                        )}
                    </View>
                </View>
            </BouncyPressable>
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
    // 每次重载都换新引用，DayCard（memo）被击穿、勾选/删除一 plans 行整列重渲）
    const dayCardsRef = useRef<DayCardData[]>([]);

    // 背景设置流守卫（相册 picker 异步窗口防重入；无常驻指示器——picker 自带 UI）
    const [busy, setBusy] = useState(false);
    // 日卡操作流：长按日卡 → 操作卡（单件，date 定位目标日）
    const [dayActionDate, setDayActionDate] = useState<string | null>(null);
    // 计划删除流：长按计划行 → 操作卡（id + 计划原文，卡内预览删的是什么）
    const [planAction, setPlanAction] = useState<{ id: string; content: string } | null>(null);
    // 封面视频管理菜单（长按封面视频 → 更换/移除，2026-11-19 用户指令「行程 ui
    // 长按视频封面没有办法更改删除」）：仅未锁定可达
    const [coverMenu, setCoverMenu] = useState(false);
    // 删除可见反馈横幅（软删+可见反馈口径）：ListHeader 呈现，at 供自动消退
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
            // 查询都是新引用，逐字段全等的日沿用旧对象引用——DayCard（memo）据此
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
        } catch {
            // db 抛错：走「行程不存在」降级态（可重试语义），不能永久卡 Loading + unhandled rejection
            setMissing(true);
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        void reload();
    }, [reload, revision]);

    // ── 日卡背景流（长按操作卡 → 相册选图 / 直接清除）──

    /**
     * 长按日卡 → 操作卡（回调身份恒定——openDayAction 传给每张 DayCard，若随
     * dayCards 重载换引用，DayCard（memo）会被击穿，计划勾选整列重渲的根因
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

    // 行渲染收口（useCallback 恒定）：配合 DayCardData 恒等复用 + 全稳定回调，
    // 计划勾选/删除后 DayCard（memo）只重渲数据变化的单卡——修前 renderItem
    // 内联新建 + openDayAction 随 dayCards 换引用，每次重载整列重渲（已修）。
    // trip 未就绪时占位空串（仅影响类型完备性，此时列表不渲染任何行）。
    const renderDayCard = useCallback(
        ({ item }: { item: DayCardData }) => (
            <DayCard
                tripId={trip?.id ?? ''}
                data={item}
                locked={locked}
                onChanged={reload}
                onRequestAction={openDayAction}
                onRequestPlanDelete={requestPlanDelete}
            />
        ),
        [trip?.id, locked, reload, openDayAction, requestPlanDelete],
    );

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
                            className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
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
                                    <LucidePenLine size={16} strokeWidth={1.9} color={palette.secondary} />
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
                            className="min-w-0 flex-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
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
                <FlatList
                    data={dayCards}
                    keyExtractor={(item) => `day-${item.localDate}`}
                    keyboardShouldPersistTaps="handled"
                    ListHeaderComponent={
                        <View className="pt-1">
                            {trip.video_key ? (
                                <View className="mb-4">
                                    {/* 长按封面 → 封面管理菜单（更换/移除；锁定态长按
                                        入口关断，#7 只读） */}
                                    <TripCoverVideo
                                        fileKey={trip.video_key}
                                        height={190}
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
                                <Text className="mb-4 text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
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
                            {/* store.error 通道（背景设置/清除失败等）统一在此可见 */}
                            {storeError ? (
                                <Text className="mb-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                                    {storeError}
                                </Text>
                            ) : null}
                            {/* 计划删除成功横幅（软删+可见反馈口径，4s 自动消退，
                                见 deleteNotice）：与 storeError 同槽位分行，中性
                                secondary 色——完成态确认不是错误也不是行动邀请 */}
                            {deleteNotice ? (
                                <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">
                                    {deleteNotice.text}
                                </Text>
                            ) : null}
                            {/* 逐日区头：日卡列的开场白（open 无固定分母不报天数） */}
                            <View className="mb-2.5 mt-1 flex-row items-baseline">
                                <Text className="text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
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
                        </View>
                    }
                    renderItem={renderDayCard}
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 32,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 668,
                    }}
                />
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
                        const { id, content } = planAction;
                        setPlanAction(null);
                        void runDeletePlan(id, content);
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
