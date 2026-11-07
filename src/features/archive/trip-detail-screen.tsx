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
import { crypto } from '@/core/crypto';
import { imagePicker } from '@/core/image-picker';
import {
    BouncyPressable,
    LucideCalendar,
    LucideCheck,
    LucideImage,
    LucidePencil,
    LucidePlus,
    LucideTrash,
} from '@/core/icons';
import { tintIcon } from './ui/editor-icons';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（该文件不在本组改动权限内），
// 域内深取；ui/index.ts 出口扩充时收口（同 editor-icons / close-button 先例）。
import { FieldInput } from './ui/field-input';
import * as db from './db';
import { useArchiveRevision, useArchiveStore } from './store';
import {
    dayDiff,
    decorateTrip,
    formatDateParts,
    formatTripSpan,
    isTripLocked,
    isTripOpenEnded,
    todayLocal,
    tripDayList,
} from './trip-logic';
import { parseBlocks, previewText } from './journal-logic';
import { safeBack } from './ui';
import {
    CloseButton,
    EmptyState,
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
 * - 点卡片 → 该日的笔记式编辑器（/trip/[id]/write/[date]，ensureJournal 自动
 *   建页，UI 即 journal editor，独立绑定该行程）；锁定行程不可进写入口，点卡
 *   改走 /journal/[id] 只读页（沿用 isTripLocked，无日记则无动作）；
 * - 卡片操作入口：长按卡（web 桌面双击，useBlockActionGestures 同媒体块范式）
 *   → 日卡操作卡（写这一天 / 添加计划 / 设置背景 / 清除背景[仅有背景时]），
 *   scrim + 居中卡（禁 RN Modal，条件渲染）。极简口径选长按而非卡角落图标：
 *   卡面保持纯内容（背景卡更是「不显示任何文字」的硬口径，角落图标会破功），
 *   且与媒体块长按操作卡是同一套交互语言；源图在系统相册，清除背景清的是
 *   行程内副本，免确认直接执行；
 * - **添加计划默认不渲染输入框**（用户口径：计划是额外添加的）——长按操作卡
 *   选「添加计划」→ 该卡进入内联输入模式（FieldInput 出现且聚焦，提交落库；
 *   失焦时非空即提交、空则收起，防「点确认钮先 blur」竞态丢字；提交成功/
 *   失焦/Android 返回均收起）。受控于屏级 planAddingDate（FlatList extraData
 *   驱动重渲）；背景卡进输入模式时临时降级渲染文字卡形态；
 * - 锁定（#7）：isTripLocked（已结束）→ 卡片只读（勾选禁用、无添加计划、无
 *   长按操作卡、点卡只读浏览），保持既有锁定轻提示；
 *   store.setTripDayBackground / clearTripDayBackground 均兜底拒绝。
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

/** 日卡操作词表（长按操作卡；仅未锁定可达）。 */
type DayCardAction = 'write' | 'add-plan' | 'set-background' | 'clear-background';

/**
 * 日卡操作卡（长按日卡 → scrim + 居中卡，范式同媒体块操作卡 / InsertMenu，
 * 禁 RN Modal 条件渲染）：写这一天 / 添加计划 / 设置背景 / 清除背景（仅有
 * 背景时）。锁定态入口不存在（长按手势未接），本卡不做锁定判定。
 */
function DayActionCard({
    hasBackground,
    onClose,
    onAction,
}: {
    hasBackground: boolean;
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

    // 行序 = 任务口径：写这一天 → 添加计划 → 设置背景 → 清除背景（仅有背景时）。
    // 行卡片与 InsertMenu MenuRow 同语言：icon 容器 40×40 rounded-control + raised
    // 触感底；行高 ~72 ≥44，不传 hitSlop（0），行距 gap-2.5（10px）为不可点间隙
    const rows: Array<{ action: DayCardAction; icon: React.ReactNode; title: string; hint: string }> = [
        { action: 'write', icon: <LucidePencil size={20} strokeWidth={1.9} />, title: '写这一天', hint: '打开这天的笔记页' },
        { action: 'add-plan', icon: <LucidePlus size={20} strokeWidth={1.9} />, title: '添加计划', hint: '给这天加一条安排' },
        { action: 'set-background', icon: <LucideImage size={20} strokeWidth={1.9} />, title: '设置背景', hint: '从相册选一张，铺满这张卡' },
        ...(hasBackground
            ? [{ action: 'clear-background' as const, icon: <LucideTrash size={20} strokeWidth={1.9} />, title: '清除背景', hint: '移除背景图，恢复文字卡' }]
            : []),
    ];

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭卡片操作"
            >
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            对这张卡做什么？
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>
                    <View className="mt-4 gap-2.5">
                        {rows.map((row) => (
                            <BouncyPressable key={row.action} onPress={() => onAction(row.action)} scaleTo={0.97}>
                                <View className="flex-row items-center gap-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface">
                                    <View
                                        pointerEvents="none"
                                        className="h-10 w-10 items-center justify-center rounded-control bg-ink-raised dark:bg-inkd-raised"
                                    >
                                        {tintIcon(row.icon, palette.secondary)}
                                    </View>
                                    <View className="flex-1">
                                        <Text className="text-[15px] font-medium text-ink-text dark:text-inkd-text">
                                            {row.title}
                                        </Text>
                                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                                            {row.hint}
                                        </Text>
                                    </View>
                                </View>
                            </BouncyPressable>
                        ))}
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

/**
 * 逐日卡片（列表主体，memo）：文字卡（日期 + 目标 + 摘要）/ 背景卡（纯图）双形态。
 * 点卡 → 该日笔记页（未锁定 write/[date]，锁定走 /journal/[id] 只读）；
 * 长按（web 桌面双击）→ 日卡操作卡（onRequestAction，仅未锁定）。
 * 背景图走 useFileUrlState 三态：loading = raised 占位（无文字，纯底）；
 * missing = 降级文字卡（背景文件缺失是可自愈降级，不渲染坏引用）；ready = 纯图。
 */
const DayCard = memo(function DayCard({
    tripId,
    data,
    locked,
    planAdding,
    onChanged,
    onRequestAction,
    onPlanAddingDone,
}: {
    tripId: string;
    data: DayCardData;
    locked: boolean;
    /** 本卡是否处于「添加计划」内联输入模式（受控于屏级 planAddingDate）。 */
    planAdding: boolean;
    onChanged(): void;
    onRequestAction(date: string): void;
    /** 退出内联输入模式（提交成功 / 失焦收起 / Android 返回取消，统一收口）。 */
    onPlanAddingDone(): void;
}) {
    const router = useRouter();
    const palette = usePalette();
    // 添加计划流（受控模式 + 内部 draft；Android 返回先退输入态不退屏）
    const [draft, setDraft] = useState('');
    const [actionError, setActionError] = useState<string | null>(null);
    // 提交防双发 ref：blur 与确认钮按压可能先后触发 submitPlan（点确认钮必先
    // blur 输入框），防重复落库
    const submittingRef = useRef(false);

    const bg = data.background;
    const bgState = useFileUrlState(bg?.file_key ?? null);
    const showBackground = bg != null && bgState.status !== 'missing';

    const { monthDay, weekday } = formatDateParts(data.localDate);
    const isToday = data.localDate === todayLocal();
    const journalBlocks = data.journal ? parseBlocks(data.journal.blocks) : null;

    // 进日页：未锁定 = 笔记式编辑器（ensureJournal 自动建页）；锁定 = 只读浏览
    // （#7 不可进写入口，无日记则无动作——不可写也不可凭空建页）
    const open = useCallback(() => {
        if (!locked) {
            router.push(`/trip/${tripId}/write/${data.localDate}`);
            return;
        }
        if (data.journal) {
            router.push({ pathname: '/journal/[id]', params: { id: data.journal.id } });
        }
    }, [locked, tripId, data.localDate, data.journal, router]);

    // 卡片手势：长按（web 桌面双击）→ 操作卡仅未锁定；锁定仅剩点按（只读路径）
    const gestures = useBlockActionGestures({
        enabled: !locked,
        onBlockAction: !locked ? () => onRequestAction(data.localDate) : undefined,
        onSinglePress: open,
    });
    const canOpen = !locked || data.journal != null;

    // 内联输入模式开启即清上次残留 draft（每次进入都是干净的一条）
    useEffect(() => {
        if (planAdding) setDraft('');
    }, [planAdding]);

    // Android 硬件返回先退出「添加计划」输入态，不直接退屏（写法参照 archive-screen）
    useEffect(() => {
        if (!planAdding) return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onPlanAddingDone();
            return true;
        });
        return () => sub.remove();
    }, [planAdding, onPlanAddingDone]);

    const submitPlan = async () => {
        if (submittingRef.current) return;
        const content = draft.trim();
        if (!content) return;
        submittingRef.current = true;
        try {
            const now = Date.now();
            await db.insertDayPlan({
                id: crypto.randomUUID(),
                trip_id: tripId,
                local_date: data.localDate,
                content,
                // 排序号走 db 收口（同行程同日期内追加到末尾）
                sort_order: await db.nextDayPlanSortOrder(tripId, data.localDate),
                done: 0,
                created_at: now,
                updated_at: now,
            });
            setActionError(null);
            setDraft('');
            // 键盘显式收起：blurOnSubmit=false 时键盘提交不触发 blur，输入框随即
            // 卸载，iOS 可能残留键盘（显式 dismiss 双端兜底）
            Keyboard.dismiss();
            onPlanAddingDone();
            onChanged();
        } catch (caught) {
            // 失败可见：crypto/db 抛错（如 web 非安全上下文）不能静默吞掉，draft 保留不丢输入
            setActionError(`计划添加失败：${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
            submittingRef.current = false;
        }
    };

    const togglePlan = async (plan: db.DayPlanRow) => {
        try {
            await db.setDayPlanDone(plan.id, plan.done === 0);
            setActionError(null);
            onChanged();
        } catch (caught) {
            // 勾选态由父级 reload 数据派生（非乐观更新），失败无需回滚本地状态，但要可见报错
            setActionError(`计划状态更新失败：${caught instanceof Error ? caught.message : String(caught)}`);
        }
    };

    // ── 背景卡形态：铺满 rounded-card16 cover，不渲染任何文字（用户硬口径）。
    //    loading = raised 纯占位；missing 已在上游降级为文字卡；内联添加计划
    //    模式下临时降级文字卡（纯图上无法承载输入，收起后恢复背景卡）──
    if (showBackground && bg && !planAdding) {
        return (
            <View className="mb-4">
                <BouncyPressable
                    onPress={canOpen && !planAdding ? gestures.onPress : undefined}
                    onLongPress={planAdding ? undefined : gestures.onLongPress}
                    scaleTo={0.985}
                >
                    <View
                        className="h-56 w-full overflow-hidden rounded-card bg-ink-raised dark:bg-inkd-raised"
                        accessibilityRole={canOpen ? 'button' : undefined}
                        accessibilityLabel={`D${data.dayNo} ${monthDay} ${weekday}，有背景图${canOpen ? '，点开这一天' : ''}`}
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
            <BouncyPressable
                onPress={canOpen && !planAdding ? gestures.onPress : undefined}
                onLongPress={planAdding ? undefined : gestures.onLongPress}
                scaleTo={0.985}
            >
                <View
                    className="min-h-[150px] rounded-card bg-ink-surface px-6 dark:bg-inkd-surface"
                    accessibilityRole={canOpen && !planAdding ? 'button' : undefined}
                    accessibilityLabel={`D${data.dayNo} ${monthDay} ${weekday}${data.journal ? '，已写' : '，未写'}${canOpen && !planAdding ? '，点开这一天' : ''}`}
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

                    {/* 内联添加计划（planAdding 受控，默认不渲染——计划是额外添加的，
                        入口在长按操作卡）：tone=raised 在 surface 卡上成可见输入井
                        （焦点再深一档）；确认钮 = 主行动近黑（primary-btn 口径）。
                        命中核算：输入与确认钮同高 44、两侧均闭 slop（0），仅 ml-2 =
                        8px 停车距，命中区互不交叠 */}
                    {planAdding && !locked ? (
                        <View className="mb-1 mt-1 flex-row items-center">
                            <FieldInput
                                tone="raised"
                                autoFocus
                                value={draft}
                                onChangeText={setDraft}
                                placeholder="这一天打算做什么？"
                                onSubmitEditing={() => void submitPlan()}
                                onBlur={() => {
                                    // 失焦收起：非空即提交（点确认钮必先 blur，走本通道
                                    // 落库防丢字；submittingRef 防与确认钮 onPress 双发），
                                    // 空则直接收起
                                    if (submittingRef.current) return;
                                    if (draft.trim()) void submitPlan();
                                    else onPlanAddingDone();
                                }}
                                returnKeyType="done"
                                blurOnSubmit={false}
                                containerClassName="flex-1"
                            />
                            <BouncyPressable onPress={() => void submitPlan()} scaleTo={0.9} hitSlop={0}>
                                <View
                                    className="ml-2 h-11 w-11 items-center justify-center rounded-control bg-ink-primary-btn dark:bg-inkd-primary-btn"
                                    accessibilityRole="button"
                                    accessibilityLabel="确认添加计划"
                                >
                                    <LucideCheck size={16} color={palette.onPrimaryBtn} />
                                </View>
                            </BouncyPressable>
                        </View>
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
    const clearTripDayBackground = useArchiveStore((s) => s.clearTripDayBackground);
    const storeError = useArchiveStore((s) => s.error);

    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    const [trip, setTrip] = useState<ReturnType<typeof decorateTrip> | null>(null);
    const [dayCards, setDayCards] = useState<DayCardData[]>([]);
    const [locked, setLocked] = useState(false);

    // 背景设置流守卫（相册 picker 异步窗口防重入；无常驻指示器——picker 自带 UI）
    const [busy, setBusy] = useState(false);
    // 日卡操作流：长按日卡 → 操作卡（date + 打开时刻的背景态，决定「清除背景」行）
    const [dayAction, setDayAction] = useState<{ date: string; hasBackground: boolean } | null>(null);
    // 内联添加计划流：操作卡选「添加计划」→ 该日期卡进入输入模式
    //（受控 date → DayCard planAdding prop；FlatList extraData 驱动重渲）
    const [planAddingDate, setPlanAddingDate] = useState<string | null>(null);

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
                const dateSet = new Set<string>([row.start_date]);
                if (today >= row.start_date) dateSet.add(today);
                for (const plan of planRows) dateSet.add(plan.local_date);
                for (const journal of journalRows) dateSet.add(journal.local_date);
                days = [...dateSet].sort();
            }
            const start = row.start_date;
            setDayCards(
                days.map((localDate) => ({
                    localDate,
                    dayNo: Math.max(1, dayDiff(start, localDate) + 1),
                    plans: plansByDate.get(localDate) ?? [],
                    journal: journalsByDate.get(localDate)?.[0] ?? null,
                    mediaCount: mediaCountByDate.get(localDate) ?? 0,
                    background: backgrounds.get(localDate) ?? null,
                })),
            );
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

    /** 长按日卡 → 操作卡；hasBackground 取打开时刻的卡片数据（决定清除行显隐）。 */
    const openDayAction = useCallback(
        (date: string) => {
            setDayAction({
                date,
                hasBackground: dayCards.some((card) => card.localDate === date && card.background != null),
            });
        },
        [dayCards],
    );

    /** 设置背景：权限 → 选图 → store.setTripDayBackground（成功 revision 自动 reload）。 */
    const runSetBackground = async (date: string) => {
        setDayAction(null);
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

    /** 清除背景：store 摘指针 + 行软删 + 文件尽力清理（源图在系统相册，免确认）。 */
    const runClearBackground = async (date: string) => {
        setDayAction(null);
        if (!trip) return;
        try {
            await clearTripDayBackground(trip.id, date);
        } catch (caught) {
            useArchiveStore.setState({
                error: `背景清除失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        }
    };

    /** 退出内联添加计划（DayCard 提交成功 / 失焦收起 / Android 返回，统一收口）。 */
    const finishPlanAdding = useCallback(() => setPlanAddingDate(null), []);

    if (loading) return <LoadingView />;

    if (missing || !trip) {
        return (
            <View className="flex-1 bg-ink-base dark:bg-inkd-base" style={{ paddingTop: insets.top }}>
                <ScreenHeader title="行程" />
                <EmptyState
                    icon={<LucideCalendar size={40} color={palette.muted} strokeWidth={1.5} />}
                    title="找不到这个行程"
                    hint="它可能已被删除。回到 Archive 看看其他内容。"
                    actionLabel="返回"
                    onAction={safeBack}
                />
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
                            {trip.title}
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
                    // planAddingDate 翻转不触碰 data，需 extraData 驱动 memo DayCard 重渲
                    extraData={planAddingDate}
                    ListHeaderComponent={
                        <View className="pt-1">
                            {trip.video_key ? (
                                <View className="mb-4">
                                    <TripCoverVideo fileKey={trip.video_key} height={190} />
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
                    renderItem={({ item }) => (
                        <DayCard
                            tripId={trip.id}
                            data={item}
                            locked={locked}
                            planAdding={planAddingDate === item.localDate}
                            onChanged={reload}
                            onRequestAction={openDayAction}
                            onPlanAddingDone={finishPlanAdding}
                        />
                    )}
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 32,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 668,
                    }}
                />
            </View>
            {/* 覆盖层（条件渲染，禁 Modal）：日卡操作卡单件——媒体动作/拍摄/录音/
                删除确认四件随「行程媒体」时间线退役 */}
            {dayAction ? (
                <DayActionCard
                    hasBackground={dayAction.hasBackground}
                    onClose={() => setDayAction(null)}
                    onAction={(action) => {
                        if (action === 'set-background') {
                            void runSetBackground(dayAction.date);
                            return;
                        }
                        if (action === 'clear-background') {
                            void runClearBackground(dayAction.date);
                            return;
                        }
                        if (action === 'add-plan') {
                            // 关操作卡 → 该日卡进入内联输入模式（默认无输入框的
                            // 添加计划流，见 DayCard / planAddingDate 注释）
                            setDayAction(null);
                            setPlanAddingDate(dayAction.date);
                            return;
                        }
                        setDayAction(null);
                        router.push(`/trip/${trip.id}/write/${dayAction.date}`);
                    }}
                />
            ) : null}
        </View>
    );
}
