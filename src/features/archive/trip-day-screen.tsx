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
    Image,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { imagePicker } from '@/core/image-picker';
import {
    LucideArchive,
    LucideBell,
    LucideClock,
    LucideImage,
    LucidePackageCheck,
    LucideStickyNote,
    LucideTrash,
    LucideVideo,
} from '@/core/icons';
import { haptics } from '@/core/haptics';
import * as db from './db';
// 屏层数据编排（行程项 mutation 与错误/revision 通道）+ 时刻纯函数
// （tripItemDueAt：通知时间闸与 deck 排序的单一事实源，屏层禁止另写时刻组合；
// isValidTripItemTime 校验收口 store 层——表单步进值域（5 分量化 + 24h 取模）
// 恒合法，屏层不再复检）。
import {
    tripItemDueAt,
    useArchiveRevision,
    useArchiveStore,
} from './store';
// 时刻拼装（纯函数，node 测试直接覆盖）。v0.4.7 时间选择重做后本屏不再消费
// 滚轮几何换算函数（点选网格无需滚动换算；该组旧导出暂留在
// trip-item-form-logic 与其测试里，清理与否归主控裁决）。
import { normalizeWheelTime } from './trip-item-form-logic';
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
    PAPER_FLOAT_SHADOW,
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
 * - 卡面（v0.4.9「纸 × 墨 2.1」：整面渐变退场，用户判深蓝渐变丑）：30px
 *   tabular 报时 + 18 semibold 标题 + 16 备注两行截断 + 首图封面 +
 *   mt-auto meta 行（状态字 + 备注/图/视频小记号）填实版面（稀疏即罪）。
 *   三态记号**绑阶段不绑槽位**（CDP 实拍证伪旧 index===0 绑定：待进行前卡
 *   谎报进行中）：ongoing = 亮档纸 + accent 细边 + 圆点（无论落哪个层位），
 *   pending = surface 素面，settled = 沉一档同版式弱化；卡面文字恒走
 *   text/secondary/accent 三档（AA 把关见 deck-stack-colors）；
 * - 长按前卡 → 操作卡（ActionMenuCard）：进入收尾（done）/ 结束收尾（wrap）/
 *   添加图片 / 添加视频（done 与 wrap 都可补媒体，用户指令 #8）/ 删除此行程
 *   ——手动「标记完成/失败」退役（v0.4.4），阶段由 trip-item-logic 派生；
 *   锁定行程 isTripLocked 时长按与 FAB 入口全部关断，整页只读）；
 * - `+` FAB → 创建行程项**底部弹层**（v0.4.9 重构，用户令「居中卡丑、操作不
 *   方便」：贴键盘底部 sheet + 单行步进器改时（±5 分 / ±1 小时，「此刻」快捷）
 *   + 标题即写即提交（主按钮恒在，两步「下一步→添加」砍除）+ 备注/响铃收进
 *   次级 chip 行）→ store.createTripItem（成功后自动调度本地通知，权限被拒
 *   静默降级）；
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

/** 无媒体项的稳定空表引用（memo 契约：每次新建 [] 会让卡面白重渲）。 */
const NO_MEDIA: readonly db.TripMediaRow[] = [];

/** 行程项时刻 → epoch ms（本地时区；store 同源纯函数的轻量包装，读法统一）。 */
function itemDueAt(item: db.TripItemRow): number {
    return tripItemDueAt(item.local_date, item.time);
}

/** rounded-card 半径档同值 inline（细边层要贴壳的 overflow-hidden 圆角裁切）。 */
const FACE_EDGE_RADIUS = 16;

/**
 * 行程项卡面（deck item.node）：deck 统一绘制 surface 圆角壳，本卡面只负责
 * 内容填充。**v0.4.9「纸 × 墨 2.1」三态语言（用户判「渐变深蓝太丑」，整面
 * 渐变全域退场）**：
 * - 状态记号绑定**阶段**而非堆叠槽位（CDP 实拍证伪旧 index===0 绑定的谎报：
 *   前卡是「待进行」也挂蓝边、真 ongoing 在背位却零信号）——ongoing 恒 =
 *   ongoingFace 亮档纸 + accent 细边（1.5px 周线绝对层，零布局影响）+ meta
 *   行 accent 圆点/文字；全 pending（无 ongoing）日任何卡都无蓝；
 * - 待进行 = pendingFace（= 壳色 surface 素面，克制不抢当前项）；
 * - 完成/收尾/终态 = settledFace（从纸面沉一档），同版式弱一档（报时落
 *   secondary 档，仍 AA）；
 * - 填实版式（稀疏即罪，430 高卡不再只有两行）：30px tabular 报时 → 18
 *   semibold 标题（2 行截断）→ 16 正文备注（2 行截断）→ 首图封面 →
 *   mt-auto meta 行贴底（状态字 + 备注/图片/视频小记号）；
 * - 卡面文字只允许 text/secondary/accent 三档（muted 与旧渐变白字退役——
 *   muted 在任何纸面档上不足 AA，tests/deck-stack-colors 按新契约把关）。
 * 三档底色走 inline palette（禁散写 hex，色值收口 theme.ts）。
 */
const TripItemCardFace = memo(function TripItemCardFace({
    item,
    phase,
    cover,
    media,
}: {
    item: db.TripItemRow;
    /** 派生阶段（tripItemPhaseMap，与 deck 排序同源）；卡面记号唯一依据。 */
    phase: TripItemPhase;
    /** 首图封面媒体行（无关联图片为 null，不渲染封面）。 */
    cover: db.TripMediaRow | null;
    /** 该项全部媒体行（meta 行图/视频记号计数；无媒体传稳定空表）。 */
    media: readonly db.TripMediaRow[];
}) {
    const coverState = useFileUrlState(cover?.file_key ?? null);
    const palette = usePalette();

    // 记号唯一依据 = 派生阶段（与 deck 排序同源，槽位不参与判定）
    const isCurrent = phase === 'ongoing';
    const isSettled = phase === 'done' || phase === 'wrap' || phase === 'terminal';
    const faceBg = isCurrent
        ? palette.ongoingFace
        : isSettled
          ? palette.settledFace
          : palette.pendingFace;
    // 报时主角：settled 弱一档到 secondary（三档纸面上仍 AA），不再降 muted
    const timeTone = isSettled ? palette.secondary : palette.text;
    // 状态字：accent 只上「进行中/收尾」两个待办态（wrap = 已 done 未归档，
    // 仍是待办信号），done/terminal/pending 落 secondary
    const phaseTone = isCurrent || phase === 'wrap'
        ? 'text-ink-accent dark:text-inkd-accent'
        : 'text-ink-secondary dark:text-inkd-secondary';
    const imageCount = media.filter((mediaRow) => mediaRow.kind === 'image').length;
    const videoCount = media.filter((mediaRow) => mediaRow.kind === 'video').length;

    return (
        <View
            style={{
                flex: 1,
                paddingHorizontal: 24,
                paddingTop: 24,
                paddingBottom: 30,
                backgroundColor: faceBg,
            }}
        >
            {/* 报时主角（30px tabular，日记卡日期刻度同感；负字距收紧数字） */}
            <Text
                style={{
                    fontSize: 30,
                    fontWeight: '600',
                    letterSpacing: -0.5,
                    color: timeTone,
                    fontVariant: ['tabular-nums'],
                }}
            >
                {item.time}
            </Text>
            <Text
                numberOfLines={2}
                className="mt-2 text-[18px] font-semibold text-ink-text dark:text-inkd-text"
            >
                {item.title}
            </Text>
            {item.description ? (
                <Text
                    numberOfLines={2}
                    className="mt-2 text-[16px] leading-6 text-ink-secondary dark:text-inkd-secondary"
                >
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
            {/* meta 行贴卡底（mt-auto；deck 页码居中在更下方底缘，不冲突）：
                状态字（ongoing 圆点+accent）+ 内容小记号（备注/图/视频） */}
            <View className="mt-auto flex-row items-center justify-between" style={{ paddingTop: 16 }}>
                <View className="flex-row items-center">
                    {isCurrent ? (
                        <View
                            className="mr-1.5 h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: palette.accent }}
                        />
                    ) : null}
                    <Text className={`text-[12px] font-medium ${phaseTone}`}>
                        {TRIP_ITEM_PHASE_LABEL[phase]}
                    </Text>
                </View>
                <View className="flex-row items-center" style={{ gap: 10 }}>
                    {item.description ? (
                        <LucideStickyNote size={13} strokeWidth={1.9} color={palette.secondary} />
                    ) : null}
                    {imageCount > 0 ? (
                        <LucideImage size={13} strokeWidth={1.9} color={palette.secondary} />
                    ) : null}
                    {videoCount > 0 ? (
                        <LucideVideo size={13} strokeWidth={1.9} color={palette.secondary} />
                    ) : null}
                </View>
            </View>
            {/* ongoing accent 细边：绑阶段不绑槽位；绝对铺满层（pointerEvents
                none 不挡卡面），半径与壳的 rounded-card 同值贴裁切边成周线 */}
            {isCurrent ? (
                <View
                    pointerEvents="none"
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        borderRadius: FACE_EDGE_RADIUS,
                        borderWidth: 1.5,
                        borderColor: palette.faceAccentEdge,
                    }}
                />
            ) : null}
        </View>
    );
});

/* ------------------------------------------------------------------ */
/* 时间编辑（v0.4.9 重构：24+12 点选芯片网格退场 → 单行步进器）           */
/* ------------------------------------------------------------------ */

/**
 * 选时间的真实动作不是「从 36 个值里挑一个」而是「在默认值上微调」——默认已是
 * 下一个 5 分钟档，用户站在「此刻」附近，修正量典型 ≤2 小时、校准步是 5 分
 * 倍数。旧点选网格把全值域的视觉扫描成本塞给用户（24+12 芯片吃半屏，v0.4.7
 * 「滚轮丑」只是把滚动仲裁换成了扫描负担）。新方案 = 单行步进器：中央大号
 * 时刻回显，左 −1h/−5、右 +5/+1h——四钮覆盖小时级定位 + 分钟级校准两档频率，
 * 单手拇指可达、零滚动、零键盘；值域 = 5 分量化 + 24h 环内取模，恒合法
 *（store 契约不变）。触控口径（animate-expo）：视觉 40dp + hitSlop 2 = 44dp
 * 命中，按钮 raised 纸面 + secondary 字（控件级中性档——accent 只上数据/选中
 * 语义，+/− 按钮不是数据态，不抢主按钮视觉重量）。
 */
const TIME_STEP = 5;
const TIME_HOUR = 60;
/** 步进钮视觉边长 / 命中外扩 / 圆角（rounded-control 档同值 inline）。 */
const STEP_BTN = 40;
const STEP_BTN_SLOP = 2;
const STEP_BTN_RADIUS = 12;

/** 下一个可选 5 分钟档（表单初值与「此刻」快捷共用；跨时进位取 24 模）。 */
function nextFiveMinuteSlot(now: Date): { hour: number; minute: number } {
    const rolled = Math.ceil(now.getMinutes() / 5) * 5;
    return {
        hour: (now.getHours() + (rolled >= 60 ? 1 : 0)) % 24,
        minute: rolled % 60,
    };
}

/**
 * 分钟偏移（−5/+5/±60 共用）：总分钟环上取模、恒落 5 分档（入参与步长都是
 * 5 的倍数），跨 0 点回卷。
 */
function shiftFiveMinuteSlot(
    hour: number,
    minute: number,
    delta: number,
): { hour: number; minute: number } {
    const total = (((hour * 60 + minute + delta) % 1440) + 1440) % 1440;
    return { hour: Math.floor(total / 60), minute: total % 60 };
}

/**
 * 步进钮：raised 纸面 + secondary 字；按压透明度一档 + selection tick（旧芯片
 * 的触感口径保留）。
 */
function TimeStepButton({
    label,
    a11yLabel,
    onPress,
}: {
    label: string;
    a11yLabel: string;
    onPress(): void;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={() => {
                haptics.selection();
                onPress();
            }}
            hitSlop={STEP_BTN_SLOP}
            accessibilityRole="button"
            accessibilityLabel={a11yLabel}
            style={({ pressed }) => ({
                width: STEP_BTN,
                height: STEP_BTN,
                borderRadius: STEP_BTN_RADIUS,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: palette.raised,
                opacity: pressed ? 0.6 : 1,
            })}
        >
            <Text
                style={{
                    fontSize: 13,
                    fontWeight: '600',
                    color: palette.secondary,
                    fontVariant: ['tabular-nums'],
                }}
            >
                {label}
            </Text>
        </Pressable>
    );
}

/**
 * 描边 ghost chip（「此刻」快捷 / 「加备注」展开共用）：accent 文字 + 透明底 +
 * 1.5 描边——快捷动作不伪装成值选项/固定控件（填充/描边语法区分）；禁用态
 * （已在目标档）降透明不发没效果的拍（诚实降级）。
 */
function GhostChip({
    label,
    a11yLabel,
    disabled = false,
    onPress,
}: {
    label: string;
    a11yLabel: string;
    disabled?: boolean;
    onPress(): void;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={() => {
                if (disabled) return;
                haptics.impact('light');
                onPress();
            }}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={a11yLabel}
            accessibilityState={{ disabled }}
            style={({ pressed }) => ({
                height: 36,
                paddingHorizontal: 14,
                borderRadius: STEP_BTN_RADIUS,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1.5,
                borderColor: disabled ? palette.border : palette.accent,
                opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
            })}
        >
            <Text
                style={{
                    fontSize: 13,
                    fontWeight: '600',
                    color: disabled ? palette.secondary : palette.accent,
                }}
            >
                {label}
            </Text>
        </Pressable>
    );
}

/**
 * 到点响铃 chip 开关（v0.4.9：整行 surface 井退场——两态开关不值得占一块
 * 说明区）：StatusChip 的淡底描边 + 图标语法——on = accent 淡底描边 + 铃铛
 * accent，off = raised 纸面 + secondary；点按即切换（accessibilityRole switch
 * 带 checked 态）。默认开与语义同旧 Switch（用户指令 #9；iOS/web 无闹钟 API
 * 时由 core/alarm 门面 no-op，平台差异不摆 UI）。
 */
function AlarmToggleChip({ value, onToggle }: { value: boolean; onToggle(): void }) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={() => {
                haptics.selection();
                onToggle();
            }}
            hitSlop={STEP_BTN_SLOP}
            accessibilityRole="switch"
            accessibilityLabel={value ? '到点响铃：已开启（注册系统闹钟，到点全屏提醒）' : '到点响铃：已关闭'}
            accessibilityState={{ checked: value }}
            className={`h-10 flex-row items-center rounded-control border px-3 ${
                value
                    ? 'border-ink-accent bg-ink-accent-bg dark:border-inkd-accent dark:bg-inkd-accent-bg'
                    : 'border-transparent bg-ink-raised dark:bg-inkd-raised'
            } active:opacity-70`}
            style={{ gap: 6 }}
        >
            <LucideBell
                size={15}
                strokeWidth={2}
                color={value ? palette.accent : palette.secondary}
            />
            <Text
                className={`text-[13px] font-medium ${
                    value
                        ? 'text-ink-accent dark:text-inkd-accent'
                        : 'text-ink-secondary dark:text-inkd-secondary'
                }`}
            >
                到点响铃
            </Text>
        </Pressable>
    );
}

/**
 * 添加行程项底部弹层（v0.4.9 重构，用户令「居中卡丑、键盘弹起后体验断裂、
 * 两步绕提交」）：
 * - 形态 = ui/date-picker.tsx 的 sheet 语言：scrim justify-end + 底部悬浮纸卡
 *   （PAPER_FLOAT 投影档 + rounded-card + 安全区底衬），KeyboardAvoidingView
 *   让 iOS 键盘顶起整层、Android adjustResize 自适应——弹层贴键盘，不再居中
 *   悬空；禁 RN Modal，条件渲染 + absolute 层范式保持；
 * - 时间 = 单行步进器（TimeStepButton 注），默认下一个 5 分钟档 + 「此刻」
 *   快捷；
 * - 路径最短：标题即写即提交（autoFocus、done 键直发），「添加」主按钮恒在，
 *   两步流程砍除；备注走次级 chip 展开的内联字段（不整卡膨胀），响铃收成
 *   chip 开关；
 * - 红线保持：Android 返回键关闭、打开即收键盘、errorText 就地重试、
 *   onSubmit({time,title,description,withAlarm}) store 契约不变；native 输入
 *   只走 FieldInput 的 uncontrolled 通道（本屏零裸 TextInput）。
 */
function TripItemFormCard({
    onSubmit,
    onClose,
    errorText,
}: {
    /** 提交通道（store.createTripItem）：resolve false = 失败（弹层保持打开）。 */
    onSubmit(input: { time: string; title: string; description: string; withAlarm: boolean }): Promise<boolean>;
    onClose(): void;
    /** store.error 就地文案（失败后展示，避免陈旧错误串场）。 */
    errorText: string | null;
}) {
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    // 时间初值 = 「下一个可选的整 5 分钟」（与「此刻」快捷同派生；59 分→整点
    // 进位取 24 模）。一次取 now 定格快照，两个 useState 共用（分取两次 Date
    // 会跨分钟漂移）。
    const [initialTime] = useState(() => nextFiveMinuteSlot(new Date()));
    const [hour, setHour] = useState(initialTime.hour);
    const [minute, setMinute] = useState(initialTime.minute);
    const [title, setTitle] = useState('');
    const [note, setNote] = useState('');
    const [noteOpen, setNoteOpen] = useState(false);
    const [withAlarm, setWithAlarm] = useState(true);
    const [saveFailed, setSaveFailed] = useState(false);
    const submittingRef = useRef(false);

    const timeLabel = normalizeWheelTime(hour, minute);
    const canSubmit = title.trim().length > 0;

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

    const shiftTime = (delta: number) => {
        const next = shiftFiveMinuteSlot(hour, minute, delta);
        setHour(next.hour);
        setMinute(next.minute);
    };

    const submit = async () => {
        if (!canSubmit || submittingRef.current) return;
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
                className="flex-1 justify-end bg-ink-scrim px-3 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭添加行程项"
            >
                {/* KAV flex-1 + justify-end：iOS keyboard 顶起整层（padding 行为
                    把贴底卡推离键盘），Android adjustResize 走窗口收缩 */}
                <KeyboardAvoidingView
                    className="flex-1 justify-end"
                    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                >
                    {/* 卡体拦截冒泡：点卡不关（同 DatePickerSheet 卡体结构）；
                        maxHeight 86%（父层 KAV 定高，百分比可解）+ 内层 ScrollView
                        flexShrink = 键盘 + 展开备注在小屏叠高时的兜底滚动通道
                        （主路径内容不满，不滚动） */}
                    <Pressable
                        className="overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface"
                        style={[PAPER_FLOAT_SHADOW, { maxHeight: '86%' }]}
                        accessibilityLabel="添加行程项面板"
                    >
                        <ScrollView
                            style={{ flexShrink: 1 }}
                            keyboardShouldPersistTaps="handled"
                            contentContainerStyle={{
                                paddingHorizontal: 16,
                                paddingTop: 16,
                                paddingBottom: Math.max(insets.bottom + 16, 24),
                            }}
                        >
                            <View className="flex-row items-center justify-between">
                                <Text className="text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    添加行程项
                                </Text>
                                <CloseButton onPress={onClose} />
                            </View>

                            {/* 时间区：eyebrow + 「此刻」快捷 / 单行步进器 */}
                            <View className="mt-3 flex-row items-center justify-between">
                                <Text className="text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                                    开始时间
                                </Text>
                                <GhostChip
                                    label="此刻"
                                    a11yLabel="此刻（跳到下一个 5 分钟档）"
                                    disabled={hour === initialTime.hour && minute === initialTime.minute}
                                    onPress={() => {
                                        const next = nextFiveMinuteSlot(new Date());
                                        setHour(next.hour);
                                        setMinute(next.minute);
                                    }}
                                />
                            </View>
                            <View className="mt-2 flex-row items-center justify-center">
                                <TimeStepButton label="−1h" a11yLabel="提前 1 小时" onPress={() => shiftTime(-TIME_HOUR)} />
                                <View style={{ width: 8 }} />
                                <TimeStepButton label={`−${TIME_STEP}`} a11yLabel="提前 5 分钟" onPress={() => shiftTime(-TIME_STEP)} />
                                <Text
                                    style={{
                                        minWidth: 104,
                                        textAlign: 'center',
                                        marginHorizontal: 10,
                                        fontSize: 34,
                                        fontWeight: '600',
                                        color: palette.text,
                                        fontVariant: ['tabular-nums'],
                                    }}
                                >
                                    {timeLabel}
                                </Text>
                                <TimeStepButton label={`+${TIME_STEP}`} a11yLabel="推后 5 分钟" onPress={() => shiftTime(TIME_STEP)} />
                                <View style={{ width: 8 }} />
                                <TimeStepButton label="+1h" a11yLabel="推后 1 小时" onPress={() => shiftTime(TIME_HOUR)} />
                            </View>

                            {/* 标题即写即提交：打开即聚焦，done 键 = 添加 */}
                            <Text className="mt-4 text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                                标题
                            </Text>
                            <FieldInput
                                tone="raised"
                                autoFocus
                                value={title}
                                onChangeText={setTitle}
                                placeholder="这段时间做什么？"
                                maxLength={40}
                                returnKeyType="done"
                                onSubmitEditing={() => void submit()}
                                containerClassName="mt-1.5"
                                accessibilityLabel="行程项标题"
                            />

                            {/* 备注（次级可展开）：chip 开合，内联字段不整卡膨胀 */}
                            {noteOpen ? (
                                <>
                                    <Text className="mt-3 text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                                        备注（选填）
                                    </Text>
                                    <FieldInput
                                        tone="raised"
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

                            {/* 次级动作行：响铃 chip 开关 + 备注展开 chip */}
                            <View className="mt-4 flex-row items-center justify-between">
                                <AlarmToggleChip value={withAlarm} onToggle={() => setWithAlarm((prev) => !prev)} />
                                <GhostChip
                                    label={noteOpen ? '收起备注' : '加备注'}
                                    a11yLabel={noteOpen ? '收起备注输入框' : '展开备注输入框（选填）'}
                                    onPress={() => {
                                        haptics.selection();
                                        setNoteOpen((prev) => !prev);
                                    }}
                                />
                            </View>

                            {/* 主按钮恒在：空标题闸住（disabled 视觉自带诚实态），
                                旧「引导→提交」分步流程砍除 */}
                            <View className="mt-4">
                                <PrimaryButton label="添加" disabled={!canSubmit} onPress={() => void submit()} />
                            </View>

                            {saveFailed && errorText ? (
                                <Text className="mt-2 text-[12px] text-ink-negative dark:text-inkd-negative">
                                    {errorText}
                                </Text>
                            ) : null}
                        </ScrollView>
                    </Pressable>
                </KeyboardAvoidingView>
            </Pressable>
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
            orderedItems.map((item) => ({
                key: item.id,
                // v0.4.9 渐变底退场：三态卡面都是纸面档，页码恒走默认 muted
                //（'light' 白字档只属于深底卡面，本屏不再产生）
                node: (
                    <TripItemCardFace
                        item={item}
                        phase={phaseById.get(item.id) ?? 'pending'}
                        cover={coverFor(item.id)}
                        media={mediaByItem.get(item.id) ?? NO_MEDIA}
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
        [orderedItems, phaseById, locked, coverFor, mediaByItem],
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
