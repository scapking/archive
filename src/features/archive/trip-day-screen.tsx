import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    BackHandler,
    FlatList,
    Image,
    Keyboard,
    Platform,
    Pressable,
    Switch,
    Text,
    View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { imagePicker } from '@/core/image-picker';
import {
    LucideArchive,
    LucideCheck,
    LucideClock,
    LucideImage,
    LucidePackageCheck,
    LucideTrash,
    LucideVideo,
} from '@/core/icons';
import { haptics } from '@/core/haptics';
import * as db from './db';
// 屏层数据编排（行程项 mutation 与错误/revision 通道）+ 时刻纯函数
// （tripItemDueAt：通知时间闸与 deck 排序的单一事实源，屏层禁止另写时刻组合；
// isValidTripItemTime 校验收口 store 层——表单时间走滚轮值域恒合法，屏层不再复检）。
import {
    tripItemDueAt,
    useArchiveRevision,
    useArchiveStore,
} from './store';
// 滚轮几何换算与时刻拼装（纯函数，node 测试直接覆盖——吸附正确性收口在此）
import {
    normalizeWheelTime,
    wheelIndexFromOffset,
    wheelOffsetForIndex,
    WHEEL_PAD_ROWS,
} from './trip-item-form-logic';
// 阶段机与 deck 排序（纯函数，node 测试直接覆盖；排序即优先级见模块头注）
import {
    orderTripItems,
    TRIP_ITEM_PHASE_LABEL,
    tripItemPhaseMap,
    type TripItemPhase,
} from './trip-item-logic';
import {
    formatDateParts,
    isTripLocked,
    isValidLocalDate,
    todayLocal,
    tripDisplayTitle,
} from './trip-logic';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（该文件不在本组改动权限内），
// 域内深取；ui/index.ts 出口扩充时收口（同 editor-icons / close-button 先例）。
import { FieldInput } from './ui/field-input';
import { safeBack } from './ui';
import {
    ActionMenuCard,
    CardDeck,
    CloseButton,
    ComposeFab,
    EmptyState,
    LoadingView,
    PrimaryButton,
    useFileUrlState,
    usePalette,
    type DeckItem,
} from './ui';
// 深路径注记：DeadEndView（死路页共享视图）宿主在 journal-edit-screen——
// 消费屏域内深取（trip-detail-screen 同款先例），journal-edit 不反向依赖
// 本屏，无 require 环。
import { DeadEndView } from './journal-edit-screen';

/**
 * 行程表页（v9，/trip/[id]/day/[date]）：某一天的全部行程项 = 左右堆叠 deck，
 * **排序即优先级**——
 *
 * - deck 前卡 = 「当前应进行的项」（ongoing 段最早到点在前；v0.4.4 阶段机，
 *   见 trip-item-logic）；进入收尾/到点自动完成后该项沉入收尾段，前卡自动
 *   前进到下一项（deck 以卡序签名重挂收口，见 deckEpoch）；
 * - 卡面：eyebrow = `${time} · 状态文案`（当前进行中 accent 色）；标题 15
 *   semibold；描述（留言/备注）；有关联图片时显示首图封面（useFileUrlState
 *   三态，缺文件降级不渲染）。当前进行中的卡面铺 ongoing 深蓝渐变（色彩只上
 *   数据纪律——蓝只上「当前」这一数据态，不上 chrome；端点收在 theme.ts
 *   堆叠同族色阶，见 TripItemCardFace 注）；
 * - 长按前卡 → 操作卡（ActionMenuCard）：进入收尾（done）/ 结束收尾（wrap）/
 *   添加图片 / 添加视频（done 与 wrap 都可补媒体，用户指令 #8）/ 删除此行程
 *   ——手动「标记完成/失败」退役（v0.4.4），阶段由 trip-item-logic 派生；
 *   锁定行程 isTripLocked 时长按与 FAB 入口全部关断，整页只读）；
 * - `+` FAB → 创建行程项表单卡（分步引导式，v0.4.2 用户指令「带交互的」：时间
 *   双滚轮 → 标题（自动聚焦）→ 备注可选可跳过；已完成步回显为可点行回改）→
 *   store.createTripItem（成功后自动调度本地通知，权限被拒静默降级）；
 * - **应用内闹钟**（页内 useEffect 定时检查）：前台期间某 pending 项的时刻
 *   （local_date + time）到达时弹确认卡——标题「行程时间到」+ 正文（时间 +
 *   标题 + 描述）+「知道了」；确认后本次不再弹（dismissedAlarmIds 会话集），
 *   下一项到点再弹。任何覆盖层展开期间闹钟顺延（scrim 互斥，关闭后下一拍
 *   继续检查）；
 * - 数据面：行程项不进 store.loadAll 状态，mutation 成功 bump revision，本屏
 *   按 useArchiveRevision 局部重载（对齐事件/计划的刷新口径）；媒体挂
 *   trip_media 既有链路（item_id 关联），上传复用 attachTripMedia 管线。
 */

/** deck 卡高（与首页 deck 同档 430；行程项卡体量适中，不放长卡）。 */
const DECK_HEIGHT = 430;

/** 应用内闹钟的检查节拍（ms）：到点检测粒度，15s 对「分钟级」的行程时刻足够。 */
const ALARM_TICK_MS = 15_000;

/** 行程项时刻 → epoch ms（本地时区；store 同源纯函数的轻量包装，读法统一）。 */
function itemDueAt(item: db.TripItemRow): number {
    return tripItemDueAt(item.local_date, item.time);
}

/**
 * 行程项卡面（deck item.node）：deck 统一绘制 surface 圆角壳，本卡面只负责
 * 内容填充；当前进行中的卡面铺 accent 淡底（bg-ink-accent-bg）盖住壳底色。
 */
const TripItemCardFace = memo(function TripItemCardFace({
    item,
    phase,
    isCurrent,
    cover,
}: {
    item: db.TripItemRow;
    /** 派生阶段（tripItemPhaseMap，与 deck 排序同源）。 */
    phase: TripItemPhase;
    /** 前卡（当前应进行的项）：eyebrow accent + 卡面 accent 淡底。 */
    isCurrent: boolean;
    /** 首图封面媒体行（无关联图片为 null，不渲染封面）。 */
    cover: db.TripMediaRow | null;
}) {
    const coverState = useFileUrlState(cover?.file_key ?? null);
    const palette = usePalette();

    // 渐变底按阶段（v0.4.5 色阶重做：端点全部收进 theme.ts 堆叠 deck 同族
    // token，2026-11-19 用户指令「颜色渐变色」保留、v0.4.4「与整体 deck 颜色
    // 不协调」的散落 hex 渐变废止）：
    // - 进行中（isCurrent）= ongoingFrom→ongoingTo：accent-deep 蓝坠入墨黑/夜面
    //   + 白字家族（蓝是「进行中」数据色，房规允许；旧方案的 tailwind-gray
    //   偏移蓝黑端点离族，正是「与整体 deck 不协调」的根因）；
    // - 完成/收尾/终态 = settledFrom→settledTo：从 border/deckEdge 沉到 deckEdge
    //   /border——完成的卡半沉进堆叠，暗端与背卡露条同色，整套 deck 一个收口；
    // - 待进行 = pendingFrom→pendingTo：纸白/raised 亮面收到 surface 一档，
    //   克制不抢当前项；
    // 三态渐变同方向（左上亮、右下沉，光源恒定）。LinearGradient 内联 style
    //（Animated/第三方组件 className web 静默丢弃坑），colors 保持二元组标注。
    const isSettled = phase === 'done' || phase === 'wrap' || phase === 'terminal';
    const gradientColors: [string, string] = isCurrent
        ? [palette.ongoingFrom, palette.ongoingTo]
        : isSettled
          ? [palette.settledFrom, palette.settledTo]
          : [palette.pendingFrom, palette.pendingTo];
    const faceTone = isCurrent ? 'accent' : 'token';
    const eyebrowTone = isCurrent
        ? 'text-white/80'
        : phase === 'terminal'
          ? 'text-ink-muted dark:text-inkd-muted'
          : phase === 'wrap'
            ? 'text-ink-accent dark:text-inkd-accent'
            : isSettled
              ? 'text-ink-muted dark:text-inkd-muted'
              : 'text-ink-secondary dark:text-inkd-secondary';
    const titleTone = isCurrent ? 'text-white' : 'text-ink-text dark:text-inkd-text';
    const bodyTone = isCurrent ? 'text-white/85' : 'text-ink-secondary dark:text-inkd-secondary';
    const metaTone = isCurrent ? 'text-white/75' : 'text-ink-muted dark:text-inkd-muted';

    const content = (
        <>
            <Text
                className={`text-[12px] font-medium ${eyebrowTone}`}
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {`${item.time} · ${TRIP_ITEM_PHASE_LABEL[phase]}`}
            </Text>
            <Text numberOfLines={2} className={`mt-2 text-[15px] font-semibold ${titleTone}`}>
                {item.title}
            </Text>
            {item.description ? (
                <Text numberOfLines={3} className={`mt-1.5 text-[13px] leading-5 ${bodyTone}`}>
                    {item.description}
                </Text>
            ) : null}
            {cover != null && coverState.status === 'ready' && coverState.uri ? (
                // 首图封面（useFileUrlState 三态：loading/missing 不渲染，降级为纯卡面）
                <Image
                    source={{ uri: coverState.uri }}
                    className="mt-3 h-36 w-full rounded-thumb"
                    resizeMode="cover"
                />
            ) : null}
        </>
    );

    return (
        <LinearGradient
            colors={gradientColors}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, paddingHorizontal: 24, paddingTop: 20, paddingBottom: 12 }}
        >
            {content}
        </LinearGradient>
    );
});

/** 滚轮单行高与可见行数：5 行窗口（上下各 2 行空区把首末项滚到中线）。 */
const WHEEL_ITEM_H = 44;
const WHEEL_VISIBLE_ROWS = 5;
/** 滚轮值域：时 0-23；分 5 分钟步进（00-55，行程项粒度口径，与通知分钟对齐）。 */
const WHEEL_HOURS = Array.from({ length: 24 }, (_, i) => i);
const WHEEL_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 创建行程项表单卡（v0.4.4 同卡渐进式，用户指令「标题下一步后在时间和标题
 * 输入框下面再加一个输入框」）：时间双滚轮 + 标题常显同卡，「下一步」把备注
 * 输入框**追加**在下方（不换屏不替换），「添加」提交。时间滚轮值域恒合法、
 * 标题空值关住提交——本地正则校验退场，仅剩 store 失败（error 通道）就地
 * 展示可重试。scrim + 居中卡，ActionMenuCard/RenameCard 同语言，禁 RN Modal
 * 条件渲染。
 */
function TripItemFormCard({
    onSubmit,
    onClose,
    errorText,
}: {
    /** 提交通道（store.createTripItem）：resolve false = 失败（卡片保持打开）。 */
    onSubmit(input: { time: string; title: string; description: string; withAlarm: boolean }): Promise<boolean>;
    onClose(): void;
    /** store.error 就地文案（失败后展示，避免陈旧错误串场）。 */
    errorText: string | null;
}) {
    // 时间初值 = 「下一个可选的整 5 分钟」（滚轮需要确定初值；59→60 归零进位）。
    // 一次取 now 定格快照，两个 useState 共用（分取两次 Date 会跨分钟漂移）。
    const [initialTime] = useState(() => {
        const now = new Date();
        const rolled = Math.ceil(now.getMinutes() / 5) * 5;
        return {
            hour: (now.getHours() + (rolled >= 60 ? 1 : 0)) % 24,
            minute: rolled % 60,
        };
    });
    const [hour, setHour] = useState(initialTime.hour);
    const [minute, setMinute] = useState(initialTime.minute);
    const [title, setTitle] = useState('');
    const [note, setNote] = useState('');
    const [noteOpen, setNoteOpen] = useState(false);
    // 系统闹钟（用户指令 #9「创建时支持自定义创建系统闹钟」）：默认开（行程
    // 提醒是核心场景），开关行随手关——iOS/web 模块缺失时开关仍在（提交后
    // 由 core/alarm 门面 no-op，不给平台差异摆 UI）。
    const [withAlarm, setWithAlarm] = useState(true);
    const [saveFailed, setSaveFailed] = useState(false);
    const submittingRef = useRef(false);

    const timeLabel = normalizeWheelTime(hour, minute);
    const palette = usePalette();

    // 打开即收键盘准备输入；Android 返回键关闭（替代 Modal onRequestClose 语义）
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

    /** 下一步：标题非空才前进（按钮 disabled 同闸），备注框追加在本卡下方。 */
    const openNote = () => {
        if (title.trim().length === 0) return;
        haptics.impact('light');
        setNoteOpen(true);
    };

    const submit = async () => {
        if (submittingRef.current) return;
        setSaveFailed(false);
        submittingRef.current = true;
        try {
            const ok = await onSubmit({
                time: timeLabel,
                title: title.trim(),
                description: note.trim(),
                withAlarm,
            });
            if (!ok) setSaveFailed(true);
            else onClose();
        } catch {
            // store 正常路径不 throw（防御环境异常，同 RenameCard 口径）
            setSaveFailed(true);
        } finally {
            submittingRef.current = false;
        }
    };

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭添加行程项"
            >
                {/* 卡体拦截冒泡：点卡不关（同 ActionMenuCard 卡体结构） */}
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-4 dark:bg-inkd-base">
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            添加行程项
                        </Text>
                        {/* 44 视觉盒：左邻题文字非按压体，右缘贴卡内边距，无重叠核算项 */}
                        <CloseButton onPress={onClose} />
                    </View>

                    {/* 时间双滚轮（常显）+ 标题（常显，自动聚焦）——同卡渐进，
                        备注由「下一步」追加在标题下方（v0.4.4 用户指令） */}
                    <View className="mt-3 flex-row gap-3">
                        <TimeWheelColumn
                            label="时"
                            values={WHEEL_HOURS}
                            index={hour}
                            onSelect={setHour}
                            accessibilityLabel="小时"
                        />
                        <TimeWheelColumn
                            label="分"
                            values={WHEEL_MINUTES}
                            index={minute}
                            onSelect={setMinute}
                            accessibilityLabel="分钟"
                        />
                    </View>
                    <Text className="mt-3 text-[12px] text-ink-muted dark:text-inkd-muted">
                        标题
                    </Text>
                    <FieldInput
                        tone="surface"
                        autoFocus
                        value={title}
                        onChangeText={setTitle}
                        placeholder="这段时间做什么？"
                        maxLength={40}
                        returnKeyType="next"
                        onSubmitEditing={openNote}
                        containerClassName="mt-1.5"
                        accessibilityLabel="行程项标题"
                    />
                    {/* 备注框（「下一步」后追加，autoFocus 接管输入；点键盘 next
                        同走追加） */}
                    {noteOpen ? (
                        <>
                            <Text className="mt-3 text-[12px] text-ink-muted dark:text-inkd-muted">
                                备注（选填）
                            </Text>
                            <FieldInput
                                tone="surface"
                                autoFocus
                                multiline
                                value={note}
                                onChangeText={setNote}
                                placeholder="留言或备注"
                                containerClassName="mt-1.5"
                                accessibilityLabel="行程项备注"
                            />
                        </>
                    ) : null}
                    {/* 系统闹钟开关（用户指令 #9，创建时可选）：默认开。Android
                        到点 = 真闹钟（全屏响铃，锁屏可关）；iOS/web 无加闹钟
                        API，提交后由 core/alarm 门面 no-op（强提醒走既有通知
                        链），开关本身不做平台差异摆位 */}
                    <View className="mt-3 flex-row items-center justify-between rounded-control bg-ink-surface px-3 py-2.5 dark:bg-inkd-surface">
                        <View className="min-w-0 flex-1 pr-2">
                            <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                                到点响铃
                            </Text>
                            <Text className="mt-0.5 text-[11px] text-ink-muted dark:text-inkd-muted">
                                注册系统闹钟，到点全屏提醒
                            </Text>
                        </View>
                        <Switch
                            value={withAlarm}
                            onValueChange={setWithAlarm}
                            trackColor={{ false: palette.border, true: palette.accent }}
                            ios_backgroundColor={palette.border}
                        />
                    </View>
                    <View className="mt-4">
                        <PrimaryButton
                            label={noteOpen ? '添加' : '下一步'}
                            disabled={title.trim().length === 0}
                            onPress={noteOpen ? () => void submit() : openNote}
                        />
                    </View>

                    {saveFailed && errorText ? (
                        <Text className="mt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {errorText}
                        </Text>
                    ) : null}
                </Pressable>
            </Pressable>
        </View>
    );
}

/**
 * 滚轮列（纯 RN 实现，不引选择器依赖——date-input 同款三端可用性纪律）：
 * **FlatList 定高行 + 手动吸附**（v0.4.4 用户反馈「滑动不丝滑」）——
 * snapToInterval 是 iOS 专属（Android ScrollView/FlatList 不支持），旧版
 * Android 完全没有吸附回正，行会停在任意位置且滚动链路额外抖；改 FlatList
 * 定高行（getItemLayout 零测量）+ iOS snapToInterval / Android momentum 末
 * 手动 scrollToOffset 吸附。上下各 2 行填充区把首末项滚到中线。中带高亮垫
 * 在行下（raised 亮度一档），选中行字色加重（settle 时才更新，滚动期零
 * per-frame setState）。挂载用 initialScrollIndex 直接落位（无飞行感），
 * 值由父层 state 持有。
 */
function TimeWheelColumn({
    label,
    values,
    index,
    onSelect,
    accessibilityLabel,
}: {
    label: string;
    values: number[];
    index: number;
    onSelect(index: number): void;
    accessibilityLabel: string;
}) {
    const listRef = useRef<FlatList<number | null> | null>(null);
    // settle 里读最新 index 的通道（闭包冻结防陈旧值误判「无变化」）
    const indexRef = useRef(index);
    indexRef.current = index;
    // momentum 未到的兜底计时器（Android 慢拖可能不发 momentum 事件）
    const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(
        () => () => {
            if (settleTimerRef.current != null) clearTimeout(settleTimerRef.current);
        },
        [],
    );

    const data = useMemo<(number | null)[]>(() => [null, null, ...values, null, null], [values]);

    /** 吸附：选最近行（父层 state 更新高亮）+ 偏移未对齐行时回正。 */
    const settle = (offset: number) => {
        const next = wheelIndexFromOffset(offset, WHEEL_ITEM_H, values.length);
        if (next !== indexRef.current) onSelect(next);
        const target = wheelOffsetForIndex(next, WHEEL_ITEM_H);
        if (Math.abs(target - offset) > 1) {
            listRef.current?.scrollToOffset({ offset: target, animated: true });
        }
    };

    return (
        <View className="flex-1">
            <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">{label}</Text>
            <View className="mt-1.5 overflow-hidden rounded-control bg-ink-surface dark:bg-inkd-surface">
                {/* 中带高亮（先铺 → 行滚动其上）：绝对定位 raised 条，pointerEvents
                    none 不挡滚动 */}
                <View
                    pointerEvents="none"
                    className="absolute left-0 right-0 bg-ink-raised dark:bg-inkd-raised"
                    style={{
                        top: WHEEL_PAD_ROWS * WHEEL_ITEM_H,
                        height: WHEEL_ITEM_H,
                    }}
                />
                <FlatList
                    ref={listRef}
                    data={data}
                    keyExtractor={(item, i) => (item == null ? `pad-${i}` : String(item))}
                    getItemLayout={(_, i) => ({
                        length: WHEEL_ITEM_H,
                        offset: WHEEL_ITEM_H * i,
                        index: i,
                    })}
                    initialScrollIndex={index + WHEEL_PAD_ROWS}
                    renderItem={({ item, index: i }: { item: number | null; index: number }) =>
                        item == null ? (
                            <View style={{ height: WHEEL_ITEM_H }} />
                        ) : (
                            <View
                                className="items-center justify-center"
                                style={{ height: WHEEL_ITEM_H }}
                            >
                                <Text
                                    className={
                                        i - WHEEL_PAD_ROWS === index
                                            ? 'text-[22px] font-medium text-ink-text dark:text-inkd-text'
                                            : 'text-[22px] text-ink-muted dark:text-inkd-muted'
                                    }
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {pad2(item)}
                                </Text>
                            </View>
                        )
                    }
                    style={{ height: WHEEL_VISIBLE_ROWS * WHEEL_ITEM_H }}
                    showsVerticalScrollIndicator={false}
                    bounces={false}
                    decelerationRate="fast"
                    overScrollMode="never"
                    nestedScrollEnabled
                    snapToInterval={Platform.OS === 'ios' ? WHEEL_ITEM_H : undefined}
                    onMomentumScrollEnd={(e) => {
                        if (settleTimerRef.current != null) {
                            clearTimeout(settleTimerRef.current);
                            settleTimerRef.current = null;
                        }
                        settle(e.nativeEvent.contentOffset.y);
                    }}
                    onScrollEndDrag={(e) => {
                        if (Platform.OS !== 'android') return;
                        // Android 慢拖可能不发 momentum：拖拽结束 ~180ms 仍无
                        // momentum 事件则视为已静止，就地吸附（momentum 到达会
                        // 先清计时器，不重复吸附）
                        if (settleTimerRef.current != null) clearTimeout(settleTimerRef.current);
                        const offset = e.nativeEvent.contentOffset.y;
                        settleTimerRef.current = setTimeout(() => settle(offset), 180);
                    }}
                    accessibilityLabel={accessibilityLabel}
                />
            </View>
        </View>
    );
}

/**
 * 应用内闹钟确认卡（scrim + 居中卡，ActionMenuCard 语言）：某 pending 行程项
 * 时刻到达时的前台提醒——标题「行程时间到」+ 正文（时间 + 标题 + 描述）+
 * 「知道了」。scrim 点按与 Android 返回键同走确认出口（点按即「本次不再弹」，
 * 不留「关了还弹」的歧义路径）。
 */
function TripItemAlarmCard({
    item,
    onAcknowledge,
}: {
    item: db.TripItemRow;
    onAcknowledge(): void;
}) {
    // Android 返回键 = 确认关闭（替代 Modal onRequestClose 语义，同各覆盖层）
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            onAcknowledge();
            return true;
        });
        return () => sub.remove();
    }, [onAcknowledge]);

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onAcknowledge}
                accessibilityLabel="确认行程提醒"
            >
                {/* 卡体拦截冒泡：点卡不关（同 ActionMenuCard 卡体结构） */}
                <Pressable className="w-full max-w-sm rounded-card bg-ink-base p-3 dark:bg-inkd-base">
                    <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                        行程时间到
                    </Text>
                    <View className="mt-3 rounded-control bg-ink-surface p-3 dark:bg-inkd-surface">
                        <Text
                            className="text-[14px] text-ink-text dark:text-inkd-text"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`${item.time} ${item.title}`}
                        </Text>
                        {item.description ? (
                            <Text className="mt-1.5 text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                {item.description}
                            </Text>
                        ) : null}
                    </View>
                    <View className="mt-4">
                        <PrimaryButton label="知道了" onPress={onAcknowledge} />
                    </View>
                </Pressable>
            </Pressable>
        </View>
    );
}

export function TripDayScreen({ tripId, date }: { tripId: string; date: string }) {
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const revision = useArchiveRevision();
    const storeError = useArchiveStore((s) => s.error);
    const createTripItem = useArchiveStore((s) => s.createTripItem);
    const startTripItemWrap = useArchiveStore((s) => s.startTripItemWrap);
    const closeTripItemWrap = useArchiveStore((s) => s.closeTripItemWrap);
    const deleteTripItem = useArchiveStore((s) => s.deleteTripItem);
    const attachTripItemMedia = useArchiveStore((s) => s.attachTripItemMedia);

    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    const [trip, setTrip] = useState<db.TripRow | null>(null);
    const [locked, setLocked] = useState(false);
    const [items, setItems] = useState<db.TripItemRow[]>([]);
    /** 行程项 → 关联媒体（trip_media.item_id 分组；仅图片作封面候选）。 */
    const [mediaByItem, setMediaByItem] = useState<Map<string, db.TripMediaRow[]>>(new Map());
    /** 到点检查时钟（前台节拍 + 排序的「已到时间」判据）。 */
    const [now, setNow] = useState(() => Date.now());
    /** 创建表单卡（+ FAB 入口；锁定态无 FAB）。 */
    const [createOpen, setCreateOpen] = useState(false);
    /** 长按操作卡目标（行程项；锁定态长按入口关断）。 */
    const [actionItem, setActionItem] = useState<db.TripItemRow | null>(null);
    /** 应用内闹钟目标（到点未确认的最早一项；确认后本次不再弹）。 */
    const [alarmItem, setAlarmItem] = useState<db.TripItemRow | null>(null);
    /** 本次会话已确认的闹钟（「本次不再弹，下一项到点再弹」的会话集）。 */
    const dismissedAlarmIds = useRef<Set<string>>(new Set());
    /** 媒体选图/选视频流程守卫（picker 异步窗口防重入，同 trip-detail 口径）。 */
    const [busy, setBusy] = useState(false);

    // 本屏数据重载：trip + 该天行程项 + 行程媒体（item_id 分组）。revision 漂移
    // （本屏 mutation 或其他屏的数据变化）自动重载；行程项不进 store.loadAll。
    const reload = useCallback(async () => {
        if (typeof tripId !== 'string' || tripId.length === 0 || !isValidLocalDate(date)) {
            setMissing(true);
            setLoading(false);
            return;
        }
        try {
            const row = await db.getTrip(tripId);
            if (!row) {
                setMissing(true);
                return;
            }
            const [itemRows, mediaRows] = await Promise.all([
                db.listTripItemsByDay(tripId, date),
                db.listTripMediaByTrip(tripId),
            ]);
            const grouped = new Map<string, db.TripMediaRow[]>();
            for (const media of mediaRows) {
                if (media.item_id == null) continue;
                const bucket = grouped.get(media.item_id);
                if (bucket) bucket.push(media);
                else grouped.set(media.item_id, [media]);
            }
            setItems(itemRows);
            setMediaByItem(grouped);
            setTrip(row);
            setLocked(isTripLocked(row, todayLocal()));
            setMissing(false);
        } catch {
            // db 抛错：走「行程不存在」降级态（可重试语义，对齐 trip-detail 口径）
            setMissing(true);
        } finally {
            setLoading(false);
        }
    }, [tripId, date]);

    useEffect(() => {
        void reload();
    }, [reload, revision]);

    // 前台时钟：应用内闹钟到点检查 + deck 排序的「已到时间」判据（15s 节拍，
    // 分钟级时刻足够；卸载即收口）
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), ALARM_TICK_MS);
        return () => clearInterval(timer);
    }, []);

    // deck 排序（排序即优先级，见 orderTripItems）；前卡 = items[0]
    const orderedItems = useMemo(() => orderTripItems(items, now), [items, now]);

    // 逐项阶段表（与排序同一推导，tripItemPhaseMap 单源）：卡面 eyebrow、
    // 操作卡行动作、应用内闹钟条件共用
    const phaseById = useMemo(() => tripItemPhaseMap(items, now), [items, now]);
    /** 操作卡目标项的阶段（行动作出牌依据）。 */
    const actionPhase: TripItemPhase | null = actionItem
        ? (phaseById.get(actionItem.id) ?? 'pending')
        : null;

    // deck 重挂纪元：卡序签名变化（阶段迁移、到点排序前进、增删项）
    // 时整组重挂 → deck 前卡恒为 items[0]（当前应进行的项），不被内部翻卡指针
    // 带偏；纯数据重载（如媒体上传）签名不变，翻卡位置得以保留。
    const orderKey = useMemo(() => orderedItems.map((item) => item.id).join('|'), [orderedItems]);
    const orderKeyRef = useRef(orderKey);
    const [deckEpoch, setDeckEpoch] = useState(0);
    useEffect(() => {
        if (orderKeyRef.current !== orderKey) {
            orderKeyRef.current = orderKey;
            setDeckEpoch((epoch) => epoch + 1);
        }
    }, [orderKey]);

    // 应用内闹钟：进行中（ongoing）且未被本会话确认的最早一项弹确认卡。任何
    // 覆盖层（表单/操作卡/已有闹钟）展开期间顺延，关掉后下一拍继续；锁定行程
    // 整页只读，不再弹闹钟（终态行程无「该动手了」的语义）。
    useEffect(() => {
        if (locked || alarmItem || createOpen || actionItem) return;
        const due = orderedItems.find(
            (item) =>
                phaseById.get(item.id) === 'ongoing' &&
                !dismissedAlarmIds.current.has(item.id),
        );
        if (due) {
            haptics.impact('medium');
            setAlarmItem(due);
        }
    }, [now, orderedItems, phaseById, alarmItem, createOpen, actionItem, locked]);

    /** 闹钟确认出口（按钮/scrim/Android 返回统一收口）：本次不再弹。 */
    const acknowledgeAlarm = useCallback(() => {
        const current = alarmItem;
        setAlarmItem(null);
        if (current) dismissedAlarmIds.current.add(current.id);
    }, [alarmItem]);

    const coverFor = useCallback(
        (itemId: string): db.TripMediaRow | null =>
            (mediaByItem.get(itemId) ?? []).find((media) => media.kind === 'image') ?? null,
        [mediaByItem],
    );

    // deck items（node = TripItemCardFace；onPress 不挂——点背卡 = deck 内建
    // 提前到前位，前卡点按无动作；长按 = 操作卡入口，锁定态关断）
    const deckItems: DeckItem[] = useMemo(
        () =>
            orderedItems.map((item, index) => ({
                key: item.id,
                // 当前项（前卡）页码走白字（渐变底），其余 muted（素面）
                pageLabelTone: index === 0 ? ('light' as const) : ('muted' as const),
                node: (
                    <TripItemCardFace
                        item={item}
                        phase={phaseById.get(item.id) ?? 'pending'}
                        isCurrent={index === 0}
                        cover={coverFor(item.id)}
                    />
                ),
                onLongPress: locked
                    ? undefined
                    : () => {
                          haptics.impact('medium');
                          setActionItem(item);
                      },
                accessibilityLabel: `${item.time} ${item.title}，${TRIP_ITEM_PHASE_LABEL[phaseById.get(item.id) ?? 'pending']}`,
            })),
        [orderedItems, phaseById, locked, coverFor],
    );

    /** 创建表单提交通道：store 校验失败 resolve false（表单就地展示可重试）。 */
    const runCreateTripItem = useCallback(
        async (input: { time: string; title: string; description: string; withAlarm: boolean }): Promise<boolean> => {
            const row = await createTripItem({
                tripId,
                date,
                time: input.time,
                title: input.title,
                description: input.description,
                withAlarm: input.withAlarm,
            });
            return row != null;
        },
        [createTripItem, tripId, date],
    );

    /** 进入收尾/结束收尾（长按操作卡）：时间闸与幂等在 store 层兜底。 */
    const runStartWrap = useCallback(
        async (itemId: string) => {
            setActionItem(null);
            await startTripItemWrap(itemId);
        },
        [startTripItemWrap],
    );
    const runCloseWrap = useCallback(
        async (itemId: string) => {
            setActionItem(null);
            await closeTripItemWrap(itemId);
        },
        [closeTripItemWrap],
    );

    /** 删除行程项（长按操作卡）：软删 + 摘媒体关联 + 取消通知（store 编排）。 */
    const runDelete = useCallback(
        async (itemId: string) => {
            setActionItem(null);
            await deleteTripItem(itemId);
        },
        [deleteTripItem],
    );

    /** 添加图片/视频（长按操作卡 → 相册选图/选视频 → attachTripItemMedia 管线）。 */
    const runAttachMedia = useCallback(
        async (item: db.TripItemRow, kind: 'image' | 'video') => {
            setActionItem(null);
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
                    mediaTypes: kind === 'video' ? ['videos'] : ['images'],
                    quality: 1,
                    exif: false,
                });
                if (result.canceled || result.assets.length === 0) return;
                const asset = result.assets[0];
                await attachTripItemMedia(
                    item.id,
                    kind,
                    asset.uri,
                    asset.width ?? null,
                    asset.height ?? null,
                );
            } catch (caught) {
                useArchiveStore.setState({
                    error: `媒体上传失败：${caught instanceof Error ? caught.message : String(caught)}`,
                });
            } finally {
                setBusy(false);
            }
        },
        [attachTripItemMedia, busy],
    );

    if (loading) return <LoadingView />;

    if (missing || !trip || !isValidLocalDate(date)) {
        return (
            // 外层 insets.top 口径与 trip-detail 死路页逐 dp 对齐
            <View className="flex-1 bg-ink-base dark:bg-inkd-base" style={{ paddingTop: insets.top }}>
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <Text className="ml-2.5 text-[20px] font-semibold text-ink-text dark:text-inkd-text">
                            行程
                        </Text>
                    </View>
                </View>
                <View className="flex-1 pt-8">
                    <DeadEndView
                        icon={<LucideClock size={40} color={palette.muted} strokeWidth={1.5} />}
                        title="找不到这一天的行程表"
                        hint="行程可能已被删除，或日期链接不完整。回到行程详情看看其他日子。"
                        actionLabel="返回"
                        onAction={safeBack}
                    />
                </View>
            </View>
        );
    }

    const { monthDay, weekday } = formatDateParts(date);

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 屏头（几何同 ScreenHeader / trip-detail 内联屏头：px-6 pb-3 pt-2
                    + h-11 行 + CloseButton 44 圆形触感底盒）：日期大标题（M月D日
                    周X）+ 所属行程名小字副行 */}
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[20px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {`${monthDay} ${weekday}`}
                        </Text>
                    </View>
                    <Text
                        numberOfLines={1}
                        className="mt-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                    >
                        {tripDisplayTitle(trip.title)}
                    </Text>
                    {locked ? (
                        // #7 锁定轻提示（对齐 trip-detail）：只读浏览的显式声明
                        <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">
                            行程已完成，内容锁定
                        </Text>
                    ) : null}
                </View>
                {/* store.error 通道（时间闸拒绝/上传失败等）统一在此可见 */}
                {storeError ? (
                    <Text className="mb-2 px-6 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {storeError}
                    </Text>
                ) : null}
                {/* 行程表 deck（key = 卡序签名纪元：排序迁移时整组重挂，前卡恒为
                    当前应进行的项，见 deckEpoch 注） */}
                <View className="mx-auto w-full max-w-[560px] flex-1 px-6">
                    <CardDeck
                        key={deckEpoch}
                        items={deckItems}
                        height={DECK_HEIGHT}
                        emptyState={
                            <EmptyState
                                icon={<LucideClock size={40} color={palette.muted} strokeWidth={1.5} />}
                                title="这一天还没有安排"
                                hint={locked ? '行程已结束，内容只读' : undefined}
                            />
                        }
                    />
                </View>
                {!locked ? (
                    <ComposeFab
                        onPress={() => {
                            haptics.impact('light');
                            setCreateOpen(true);
                        }}
                        accessibilityLabel="添加行程项"
                    />
                ) : null}
            </View>
            {/* 覆盖层（条件渲染，禁 Modal，互斥可达：scrim 盖屏时其他入口不可触） */}
            {createOpen ? (
                <TripItemFormCard
                    onSubmit={runCreateTripItem}
                    onClose={() => setCreateOpen(false)}
                    errorText={storeError}
                />
            ) : null}
            {actionItem ? (
                <ActionMenuCard
                    title="行程项"
                    rows={[
                        // 动作按阶段出牌（v0.4.4 阶段机）：done = 进入收尾；wrap =
                        // 结束收尾；done 与 wrap 都可补图补视频（用户指令 #8）；终态
                        // 只剩删除。手动「标记完成/失败」退役。
                        ...(actionPhase === 'done'
                            ? [
                                  {
                                      key: 'start-wrap',
                                      icon: <LucidePackageCheck size={18} strokeWidth={1.9} />,
                                      title: '进入收尾',
                                  },
                              ]
                            : []),
                        ...(actionPhase === 'wrap'
                            ? [
                                  {
                                      key: 'close-wrap',
                                      icon: <LucideArchive size={18} strokeWidth={1.9} />,
                                      title: '结束收尾',
                                  },
                              ]
                            : []),
                        ...(actionPhase === 'done' || actionPhase === 'wrap'
                            ? [
                                  {
                                      key: 'image',
                                      icon: <LucideImage size={18} strokeWidth={1.9} />,
                                      title: '添加图片',
                                  },
                                  {
                                      key: 'video',
                                      icon: <LucideVideo size={18} strokeWidth={1.9} />,
                                      title: '添加视频',
                                  },
                              ]
                            : []),
                        {
                            key: 'delete',
                            icon: <LucideTrash size={18} strokeWidth={1.9} />,
                            title: '删除此行程',
                            danger: true,
                        },
                    ]}
                    onAction={(key) => {
                        if (!actionItem) return;
                        if (key === 'start-wrap') {
                            void runStartWrap(actionItem.id);
                            return;
                        }
                        if (key === 'close-wrap') {
                            void runCloseWrap(actionItem.id);
                            return;
                        }
                        if (key === 'image') {
                            void runAttachMedia(actionItem, 'image');
                            return;
                        }
                        if (key === 'video') {
                            void runAttachMedia(actionItem, 'video');
                            return;
                        }
                        void runDelete(actionItem.id);
                    }}
                    onClose={() => setActionItem(null)}
                />
            ) : null}
            {alarmItem ? (
                // 闹钟卡盖在其余覆盖层之上渲染（条件互斥 + 后绘优先，双保险）
                <TripItemAlarmCard item={alarmItem} onAcknowledge={acknowledgeAlarm} />
            ) : null}
        </View>
    );
}
