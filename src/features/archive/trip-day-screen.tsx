import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ComponentRef,
} from 'react';
import {
    BackHandler,
    Image,
    Keyboard,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
// v0.5.1 令 1：应用内到点检查的动作通道（跳全屏闹钟屏；弹窗 TripItemAlarmCard
// 退场后本屏唯一路由出口）。
import { router } from 'expo-router';
// v0.5.1 看图验收返工：滚轮上下缘渐隐遮罩（expo-linear-gradient 双端可用，
// web 渲染为 CSS 渐变；纯功能性 mask，非装饰色场——0.4.9「整面渐变退场」
// 禁令不覆盖同底色渐隐）
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { imagePicker } from '@/core/image-picker';
import {
    LucideArchive,
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
// 时刻拼装（纯函数，node 测试直接覆盖）。v0.5.1 时间选择回到滚动形态，但滚动
// 几何走原生 ScrollView snapToInterval 的浏览器/RN 物理（settle 只在滚动结束
// 事件里换算一次），不消费 trip-item-form-logic 的旧滚轮仲裁函数（0.4.7 逐帧
// JS 换算卡顿教训；该组旧导出清理与否归主控裁决）。
import { normalizeWheelTime } from './trip-item-form-logic';
// 阶段机与 deck 排序（纯函数，node 测试直接覆盖；排序即优先级见模块头注）
import {
    orderTripItems,
    TRIP_ITEM_PHASE_LABEL,
    tripItemDisplayTitle,
    tripItemPhaseMap,
    type TripItemPhase,
} from './trip-item-logic';
// v0.5.1 令 1：应用内到点检查的「本会话已处理」共享账（与 alarm-watcher/
// 全屏闹钟屏同一事实源；纯运行时零依赖模块，见 alarm-ladder 头注）。
import { isAlarmHandled, markAlarmHandled } from './alarm-ladder';
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
    useFileUrlState,
    usePalette,
    type DeckItem,
} from './ui';
// 居中卡 + 键盘避让原语（v0.5.0：keyboardDidShow/Hide 事件驱动抬升 + 内滚卡体
// + footer 钉底；深路径注记同 field-input——ui/index.ts 不在本组改动权限内）
import { CenteredSheet, useSheetFieldFocusGuard } from './ui/sheet';
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
 *   tabular 报时 + 18 semibold 标题（可空：空标题不渲染任何文字、禁兜底词）+
 *   16 备注两行截断 + 首图封面 +
 *   mt-auto meta 行（状态字 + 备注/图/视频小记号）填实版面（稀疏即罪）。
 *   三态记号**绑阶段不绑槽位**（CDP 实拍证伪旧 index===0 绑定：待进行前卡
 *   谎报进行中）：ongoing = 亮档纸 + accent 细边 + 圆点（无论落哪个层位），
 *   pending = surface 素面，settled = 沉一档同版式弱化；卡面文字恒走
 *   text/secondary/accent 三档（AA 把关见 deck-stack-colors）；
 * - 长按前卡 → 操作卡（ActionMenuCard）：进入收尾（done）/ 结束收尾（wrap）/
 *   添加图片 / 添加视频（done 与 wrap 都可补媒体，用户指令 #8）/ 删除此行程
 *   ——手动「标记完成/失败」退役（v0.4.4），阶段由 trip-item-logic 派生；
 *   锁定行程 isTripLocked 时长按与 FAB 入口全部关断，整页只读）；
 * - `+` FAB → 创建行程项**居中卡**（v0.5.1 快速路径，用户令：删标题输入框、
 *   删「到点响铃」及其容器、删备注入口；时间滚动化）：快速态 = 时/分双列
 *   轻量滚动选轮（原生 ScrollView + snapToInterval，滚动即选跟手，「此刻」
 *   快捷收小）+ 底部动作行（照新建事件语言，容器外单行）——「直接创建」=
 *   无标题即提交（ghost 次级），「下一步」= 进第二步补填标题+备注（近黑主钮，
 *   末钮「添加」提交）。键盘避让仍走 ui/sheet 的 CenteredSheet 事件驱动几何。
 *   withAlarm UI 退场但链路语义保留：提交恒传 withAlarm: true →
 *   store.createTripItem（title 可空；成功后自动调度本地通知，权限被拒
 *   静默降级）；
 * - **应用内闹钟**（页内 useEffect 定时检查；v0.5.1 令 1：页内「行程时间到」
 *   确认卡弹窗**退场**——触发判定保留，后续动作改为跳全屏闹钟屏
 *   /alarm/<id>：与通知深链/watcher/通知 tap 同一呈现形态，应用内不再有
 *   弹窗形态的闹钟。跳转前记入 alarm-ladder 共享会话账（确认后回本页
 *   同项仍 ongoing 不重复跳；本屏会因跳屏/返程反复卸载重挂，局部集会丢，
 *   共享账防复响回路），下一项到点再跳。任何覆盖层展开期间顺延
 *   （关闭后下一拍继续检查）；
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
    // v0.5.1 快速路径产物：title 可空。取题唯一走 tripItemDisplayTitle——
    // 空标题返回空串，卡面不渲染标题行（时刻即主角），禁一切兜底文字
    const displayTitle = tripItemDisplayTitle(item.title);

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
            {displayTitle !== '' ? (
                <Text
                    numberOfLines={2}
                    className="mt-2 text-[18px] font-semibold text-ink-text dark:text-inkd-text"
                >
                    {displayTitle}
                </Text>
            ) : null}
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
/* 时间编辑（v0.5.1：步进钮阵退场 → 0.4.3 滚轮交互的简化版双列滚动）      */
/* ------------------------------------------------------------------ */

/**
 * 用户点名参考 v0.4.3 的滚动选时（「卡得太死」——步进四钮把 2 小时的修正
 * 拆成 24 次拍），但要简化。形态 = 时/分双列轻量滚动：值域维持 5 分量化
 *（时 0-23、分 00-55 步进 5，与 store 'HH:mm' 口径一致，36 个值扫读成本
 * 已被列式滚轮消化）；行高 44（触控下限），滚动即选、跟手。
 *
 * v0.5.1 看图验收返工（用户判「3 行窗不像滚轮、像 2×2 钮格」）：
 * - 窗口升到 5 行档（iOS picker 同档密度）；
 * - 井底改 raised 深一档 + 中带 base 白条（肉眼可辨的「当前行」容器）；
 * - 上下缘 linear-gradient 渐隐遮罩（同井底色，行滚入边缘即化开——滚轮
 *   深度的第一视觉信号）；
 * - 字阶异级：中行 20 semibold text 档，非中邻行 15 regular secondary
 *   档。异级只由 settle 通道一次性 setState 驱动（index prop 变化 →
 *   整列重渲染一次），**不读 onScroll 逐帧位置**。
 *
 * **性能红线（0.4.3 原版滚轮本身带滑动 bug、0.4.7「卡一下然后无法持续切换」
 * 教训——只借交互语义，不原样照搬）**：滚动/惯性交原生 ScrollView 物理；
 * native 挂 snapToInterval = 行高（RN 0.88 双端原生吸附），JS 只在滚动
 * **结束**事件（onMomentumScrollEnd + onScrollEndDrag 双通道——Android 慢拖
 * 可能不发 momentum 事件）做一次 y→index 换算；**结构上禁 onScroll 逐帧
 * 监听/逐帧 setState/逐帧动画驱动选中**。RNW 0.21 未实现 snapToInterval
 * （源码无该 prop，web 上被静默忽略）——web 靠 settle 后的一次 native
 * 平滑 scrollTo 归位补齐「松手必吸附到合法档位」，与 editor.tsx 滚动应答
 * 同款 <1px 去重闸，收敛不死循环。
 */
const WHEEL_ROW_H = 44;
/** 上下垫行数：(5 行窗口 − 1 中线) / 2 = 2，把首末项滚到中线；渐隐遮罩同高。 */
const WHEEL_PAD_ROWS = 2;
const WHEEL_VISIBLE_ROWS = 5;
/** 滚轮值域：时 0-23；分 5 分钟步进（00-55，行程项粒度口径，与通知分钟对齐）。 */
const HOUR_VALUES = Array.from({ length: 24 }, (_, i) => i);
const MINUTE_VALUES = Array.from({ length: 12 }, (_, i) => i * 5);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 下一个可选 5 分钟档（表单初值与「此刻」快捷共用；跨时进位取 24 模）。 */
function nextFiveMinuteSlot(now: Date): { hour: number; minute: number } {
    const rolled = Math.ceil(now.getMinutes() / 5) * 5;
    return {
        hour: (now.getHours() + (rolled >= 60 ? 1 : 0)) % 24,
        minute: rolled % 60,
    };
}

/**
 * 滚动列（纯 RN 原生 ScrollView，不引第三方选择器依赖——date-input 同款
 * 三端可用性纪律）：snapToInterval 吸附到行、decelerationRate fast 让抬手
 * 即定档；上下各 2 行垫高 + 挂载 scrollTo 定位当前值（animated false，无
 * 飞行感）。解剖（看图验收返工后定版，全部静态层——无逐帧计算）：
 * - 井底 raised（对 base 卡面沉一档，肉眼可辨的容器）；
 * - 中带 base 白条垫在行下（先铺 → 行滚动其上），「当前行」有实体底板；
 * - 上下缘各 2 行高 linear-gradient 渐隐（raised→同色 alpha 0），行滚到
 *   边缘化开 = 滚轮纵深；pointerEvents none 不挡滚动；
 * - 字阶异级：中行 20/600 text，其余 15/400 secondary——index 只在 settle
 *   时变，字阶随之一次性重渲染（性能红线不破）。
 * index 的外部跳变（「此刻」）由宿主以 key 重挂本列完成定位——列内不做
 * 受控回写，省掉一次「滚动→state→回写」的往返。
 */
/**
 * 滚轮单行（纯静态渲染）：active 只由 settle 通道更新的 index 派生——
 * 实体中行为 true，渐隐区邻行与回绕垫行恒 false（15/400 secondary 弱档）。
 * 行高 = WHEEL_ROW_H（44dp 触控下限档，垫行与实体行同构，居中线公式不变）。
 */
function WheelValueRow({ value, active }: { value: number; active: boolean }) {
    const palette = usePalette();
    return (
        <View className="items-center justify-center" style={{ height: WHEEL_ROW_H }}>
            <Text
                style={{
                    fontSize: active ? 20 : 15,
                    fontWeight: active ? '600' : '400',
                    color: active ? palette.text : palette.secondary,
                    fontVariant: ['tabular-nums'],
                }}
            >
                {pad2(value)}
            </Text>
        </View>
    );
}

function TimeScrollColumn({
    label,
    values,
    index,
    onSelect,
    accessibilityLabel,
}: {
    label: string;
    values: number[];
    /** 当前值在 values 中的下标（时列 = hour；分列 = minute / 5）。 */
    index: number;
    onSelect(index: number): void;
    accessibilityLabel: string;
}) {
    const palette = usePalette();
    const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
    useEffect(() => {
        scrollRef.current?.scrollTo({ y: index * WHEEL_ROW_H, animated: false });
        // 挂载定位只跑一次（见头注）：后续 index 变化都来自本列滚动，无需回写
        // eslint 不在仓库纪律内（无 ESLint），依赖数组恒空是刻意的
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // settle = 滚动结束后的一次性换算（性能红线：不在 onScroll 里跑）。
    // 取模恒成立：index 先 clamp 到 [0, count-1]，「松手必落合法档」不依赖
    // 事件顺序。吸附归位 = **animated:false 即时硬对齐**（终验 race 修正：
    // 平滑 scrollTo 与惯性/二次 settle 竞态，500ms 测量窗口内仍未回中
    // offCenterPx=5；settle 本就是结束事件后的最后一拍，直接落位没有
    // 动画可抢——顺带消掉松手后再调度的滚动动画帧，drag perf 压线 jank
    // 同根因退场）；偏移 ≤1px 不动（幂等，双通道重复回调无害）
    const settle = (y: number) => {
        const next = Math.max(0, Math.min(values.length - 1, Math.round(y / WHEEL_ROW_H)));
        if (next !== index) {
            haptics.selection();
            onSelect(next);
        }
        const snapped = next * WHEEL_ROW_H;
        if (Math.abs(y - snapped) > 1) {
            scrollRef.current?.scrollTo({ y: snapped, animated: false });
        }
    };

    return (
        <View className="flex-1">
            <Text className="text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                {label}
            </Text>
            <View className="mt-1.5 overflow-hidden rounded-control bg-ink-raised dark:bg-inkd-raised">
                {/* 中带实体底板（先铺 → 行滚动其上）：base 白条对 raised 井底，
                    light 侧 #F0F2F5→#FFFFFF 肉眼可辨；pointerEvents none 不挡滚动 */}
                <View
                    pointerEvents="none"
                    className="absolute left-0 right-0 bg-ink-base dark:bg-inkd-base"
                    style={{
                        top: WHEEL_PAD_ROWS * WHEEL_ROW_H,
                        height: WHEEL_ROW_H,
                    }}
                />
                <ScrollView
                    ref={scrollRef}
                    style={{ height: WHEEL_VISIBLE_ROWS * WHEEL_ROW_H }}
                    showsVerticalScrollIndicator={false}
                    snapToInterval={WHEEL_ROW_H}
                    decelerationRate="fast"
                    // 双通道 settle：Android 慢拖可能不发 momentum 事件，endDrag 兜底；
                    // settle 幂等（同值不重复回调），双触发无害
                    onMomentumScrollEnd={(e) => settle(e.nativeEvent.contentOffset.y)}
                    onScrollEndDrag={(e) => settle(e.nativeEvent.contentOffset.y)}
                    accessibilityLabel={accessibilityLabel}
                >
                    {/* 回绕垫行（终验看图：端档时缘带全空被判「不像环」）：
                        上垫 = 值域末 PAD 值（00 头上显 50/55），下垫 = 首 PAD
                        值（55 脚下显 00/05）。index 映射保持线性——垫行总高仍
                        PAD*ROW_H，行 i 居中线偏移量 i*ROW_H 一字不动；垫行
                        只做视觉（恒弱档、不可选，settle clamp 与吸附公式零接
                        触），环回风险面 = 无。值域 len(12/24) ≥ 2*PAD 恒成立，
                        回绕不会与实体行同屏重复成假候选（即便重叠也只是渐隐
                        区的邻行镜像，落位仍走 clamp） */}
                    {Array.from({ length: WHEEL_PAD_ROWS }, (_, i) => (
                        <WheelValueRow
                            key={`pad-top-${i}`}
                            value={values[values.length - WHEEL_PAD_ROWS + i]}
                            active={false}
                        />
                    ))}
                    {values.map((value, i) => (
                        <WheelValueRow key={value} value={value} active={i === index} />
                    ))}
                    {Array.from({ length: WHEEL_PAD_ROWS }, (_, i) => (
                        <WheelValueRow key={`pad-bot-${i}`} value={values[i]} active={false} />
                    ))}
                </ScrollView>
                {/* 上下缘渐隐遮罩（盖在行上，pointerEvents none）：井底色 raised →
                    同色 alpha 0，各 2 行高——行滚入边缘化开，「滚轮」纵深信号；
                    web = CSS 渐变 / native = expo-linear-gradient，同一实现双端 */}
                <LinearGradient
                    pointerEvents="none"
                    colors={[palette.raised, `${palette.raised}00`]}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: 0,
                        height: WHEEL_PAD_ROWS * WHEEL_ROW_H,
                    }}
                />
                <LinearGradient
                    pointerEvents="none"
                    colors={[`${palette.raised}00`, palette.raised]}
                    style={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: WHEEL_PAD_ROWS * WHEEL_ROW_H,
                    }}
                />
            </View>
        </View>
    );
}

/**
 * 「此刻」快捷（收小档）：纯文字 accent 钮，挂在「开始时间」eyebrow 行右端
 * （0.4.9 描边 chip 36 高降为 28 内联文本钮——快捷动作不伪装成值选项，
 * 也不抢滚轮视觉重量）；已在目标档时 disabled 降透明不发没效果的拍。
 */
function NowShortcut({
    disabled,
    onPress,
}: {
    disabled: boolean;
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
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="此刻（跳到下一个 5 分钟档）"
            accessibilityState={{ disabled }}
            style={({ pressed }) => ({
                height: 28,
                paddingHorizontal: 4,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
            })}
        >
            <Text style={{ fontSize: 12, fontWeight: '600', color: palette.accent }}>
                此刻
            </Text>
        </Pressable>
    );
}

/**
 * 添加行程项居中卡（v0.5.1 快速路径，用户令：删标题输入框 / 删「到点响铃」
 * 及其容器 / 删备注入口；时间滚动化；动作行照新建事件语言）：
 * - 形态 = CenteredSheet（ui/sheet 原语不动：keyboardDidShow/Hide 直读键盘
 *   高度抬卡、maxHeight 让位、超限内滚、footer 钉底；禁 RN Modal）；
 * - 快速态就两件事：时刻双列滚动（TimeScrollColumn 注，性能红线同段）+
 *   底部动作行。「直接创建」（ghost，surface 次级）= 无标题即提交；
 *   「下一步」（primary-btn 近黑）= 进第二步补填标题+备注（学新建事件的
 *   渐进交互；第二步动作行 = 「改时间」ghost 回滚轮 + 「添加」主钮提交）。
 *   动作行走 footer 槽钉卡底 = 契约「容器外底部单行」，键盘弹起恒在键盘上方；
 * - withAlarm：UI 已删（响铃 chip + 容器全退场），链路语义保留——提交恒传
 *   withAlarm: true，store 闹钟调度零改动；
 * - 红线保持：Android 返回键（第二步先回滚轮、滚轮态关闭）、打开即收键盘、
 *   errorText 就地重试、onSubmit({time,title,description,withAlarm}) 契约
 *   形状不变（title 自 v0.5.1 可为空串）；native 输入只走 FieldInput 的
 *   uncontrolled 通道（本屏零裸 TextInput），聚焦挂 scrollIntoView 二次保险。
 */
function TripItemSheet({
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
    const palette = usePalette();
    // 聚焦保险（sheet 原语提供）：键盘已弹起时换字段 focus 不再触发键盘事件，
    // 由本钩子把聚焦框滚进键盘上沿可见区（第二步标题/备注共用）
    const guardFieldFocus = useSheetFieldFocusGuard();
    // 时间初值 = 「下一个可选的整 5 分钟」（与「此刻」快捷同派生；59 分→整点
    // 进位取 24 模）。一次取 now 定格快照，两个 useState 共用（分取两次 Date
    // 会跨分钟漂移）。
    const [initialTime] = useState(() => nextFiveMinuteSlot(new Date()));
    const [hour, setHour] = useState(initialTime.hour);
    const [minute, setMinute] = useState(initialTime.minute);
    // 「此刻」= 外部跳变：滚轮列不做受控回写（见 TimeScrollColumn 注），
    // 以 epoch 参与 key 重挂双列，挂载 scrollTo 直接落新值
    const [wheelEpoch, setWheelEpoch] = useState(0);
    const [step, setStep] = useState<'time' | 'detail'>('time');
    const [title, setTitle] = useState('');
    const [note, setNote] = useState('');
    const [saveFailed, setSaveFailed] = useState(false);
    const submittingRef = useRef(false);

    const timeLabel = normalizeWheelTime(hour, minute);
    const atNow = hour === initialTime.hour && minute === initialTime.minute;

    // 打开即收键盘（快速态零输入框）；Android 返回键：第二步先回滚轮，
    // 滚轮态关闭（替代 Modal onRequestClose 语义）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (step === 'detail') {
                Keyboard.dismiss();
                setStep('time');
                return true;
            }
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose, step]);

    const submit = async () => {
        if (submittingRef.current) return;
        setSaveFailed(false);
        submittingRef.current = true;
        try {
            const ok = await onSubmit({
                time: timeLabel,
                // v0.5.1：title 可空——快速路径无标题输入，trim 空串合法直入库
                //（store 校验已放开；卡面空标题只显时刻、无兜底文字）
                title: title.trim(),
                description: note.trim(),
                // 响铃 UI 退场但链路语义保留：恒注册闹钟（core/alarm 门面
                // 平台不支持自动 no-op）
                withAlarm: true,
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

    // 动作行两枚共用语言（照新建事件表单）：ghost = surface 底 secondary 字，
    // primary = palette.primaryBtn 近黑 + onPrimaryBtn 字；等分一行不被容器包裹。
    // 看图验收返工：文案一律 numberOfLines=1（实拍「直接创/建」折行禁绝——
    // 折行根因 = 卡宽塌缩到内容固有宽，见 ui/sheet Animated.View 宽度定档）
    const ghostBtn = (label: string, onPress: () => void) => (
        <Pressable
            onPress={() => {
                haptics.selection();
                onPress();
            }}
            disabled={submittingRef.current}
            className={`h-12 flex-1 items-center justify-center rounded-control bg-ink-surface active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                submittingRef.current ? 'opacity-40' : ''
            }`}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            <Text
                numberOfLines={1}
                className="text-[16px] font-medium text-ink-secondary dark:text-inkd-secondary"
            >
                {label}
            </Text>
        </Pressable>
    );
    const primaryBtn = (label: string, onPress: () => void) => (
        <Pressable
            onPress={() => {
                haptics.impact('light');
                onPress();
            }}
            disabled={submittingRef.current}
            className="h-12 flex-1 items-center justify-center rounded-control active:opacity-90"
            style={{ backgroundColor: palette.primaryBtn }}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            <Text
                numberOfLines={1}
                className="text-[16px] font-semibold"
                style={{ color: palette.onPrimaryBtn }}
            >
                {label}
            </Text>
        </Pressable>
    );

    return (
        <CenteredSheet
            onClose={onClose}
            scrimAccessibilityLabel="关闭添加行程项"
            sheetAccessibilityLabel="添加行程项面板"
            footer={
                <>
                    {/* 动作行走 footer 槽钉卡底（= 契约「容器外底部单行」，键盘
                        弹起恒在键盘上方、不随滚动被吞）；标题可空后无禁用闸，
                        仅防重入 */}
                    <View className="flex-row gap-3">
                        {step === 'time' ? (
                            <>
                                {ghostBtn('直接创建', () => void submit())}
                                {primaryBtn('下一步', () => setStep('detail'))}
                            </>
                        ) : (
                            <>
                                {ghostBtn('改时间', () => {
                                    Keyboard.dismiss();
                                    setStep('time');
                                })}
                                {primaryBtn('添加', () => void submit())}
                            </>
                        )}
                    </View>
                    {saveFailed && errorText ? (
                        <Text className="mt-2 text-center text-[12px] text-ink-negative dark:text-inkd-negative">
                            {errorText}
                        </Text>
                    ) : null}
                </>
            }
        >
            {/* 卡头：eyebrow 题（11 medium secondary，弹窗族刻度）+ 关闭钮 */}
            <View className="flex-row items-center justify-between">
                <Text className="text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                    添加行程项
                </Text>
                <CloseButton onPress={onClose} />
            </View>

            {step === 'time' ? (
                <>
                    {/* 快速态 = 时刻滚动 + 动作行（footer），中间再无别的字段。
                        节奏（看图验收返工）：头→eyebrow mt-4、eyebrow→滚轮 mt-4、
                        滚轮→动作行 pb-4（footer pt-3 合计 ≈28 区块档） */}
                    <View className="mt-4 flex-row items-center justify-between">
                        <Text className="text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                            开始时间
                        </Text>
                        <NowShortcut
                            disabled={atNow}
                            onPress={() => {
                                const next = nextFiveMinuteSlot(new Date());
                                setHour(next.hour);
                                setMinute(next.minute);
                                setWheelEpoch((epoch) => epoch + 1);
                            }}
                        />
                    </View>
                    <View className="mt-4 flex-row gap-3 pb-4">
                        <TimeScrollColumn
                            key={`hour-${wheelEpoch}`}
                            label="时"
                            values={HOUR_VALUES}
                            index={hour}
                            onSelect={setHour}
                            accessibilityLabel="小时（上下滚动选择）"
                        />
                        <TimeScrollColumn
                            key={`minute-${wheelEpoch}`}
                            label="分"
                            values={MINUTE_VALUES}
                            index={minute / 5}
                            onSelect={(i) => setMinute(i * 5)}
                            accessibilityLabel="分钟（上下滚动选择，5 分钟一档）"
                        />
                    </View>
                </>
            ) : (
                <>
                    {/* 第二步（渐进补填）：时间回显行点按即回滚轮改时，
                        标题/备注都选填——「添加」空字段提交也合法 */}
                    <Pressable
                        onPress={() => {
                            haptics.selection();
                            setStep('time');
                        }}
                        className="mt-4 flex-row items-center justify-between rounded-control bg-ink-surface px-4 py-3 active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised"
                        accessibilityRole="button"
                        accessibilityLabel={`开始时间 ${timeLabel}，点按返回滚动修改`}
                    >
                        <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                            开始时间
                        </Text>
                        <Text
                            className="text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {timeLabel}
                        </Text>
                    </Pressable>
                    <Text className="mt-4 text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                        标题（选填）
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
                        onFocus={() => guardFieldFocus()}
                        containerClassName="mt-1.5"
                        accessibilityLabel="行程项标题"
                    />
                    <Text className="mt-4 text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                        备注（选填）
                    </Text>
                    <FieldInput
                        tone="raised"
                        multiline
                        value={note}
                        onChangeText={setNote}
                        placeholder="留言或备注"
                        onFocus={() => guardFieldFocus()}
                        containerClassName="mt-1.5"
                        accessibilityLabel="行程项备注"
                    />
                </>
            )}
        </CenteredSheet>
    );
}

// v0.5.1 令 1：应用内「行程时间到」确认卡（TripItemAlarmCard）整块退场——
// 弹窗形态废止，到点呈现统一走全屏闹钟屏 /alarm/<id>（到点检查 effect 见
// TripDayScreen 内「应用内闹钟」段，触发判定保留、动作改为路由跳转）。

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

    // 应用内闹钟（v0.5.1 令 1：弹窗退场，动作 = 跳全屏闹钟屏）：进行中
    // （ongoing）且未被本会话处理过的最早一项 → replace 到 /alarm/<id>，与
    // 通知深链/watcher 到点同一呈现形态（弹窗语言在此统一）。任何覆盖层
    // （表单/操作卡）展开期间顺延，关掉后下一拍继续；锁定行程整页只读，
    // 不再跳（终态行程无「该动手了」的语义）。replace 而非 push：任意时刻
    // 栈里最多一张闹钟屏（「关闭后仍有声音」双屏叠栈教训，见 alarm-watcher
    // v0.5.1 注）。
    // 「本会话已处理」走 alarm-ladder 共享账（id→计划时刻指纹），不再是本屏
    // 局部 ref 集：本页因跳屏/确认返程会反复卸载重挂，局部集会随卸载清空，
    // 全屏屏确认回来后下一拍又把同一 ongoing 项跳回去 = 复响回路（v0.5.1
    // 纠错推演）；共享账 + at 指纹让 watcher/页内检查/全屏屏出口看到同一
    // 事实，重排闹钟（新 at）仍会重新在场。
    useEffect(() => {
        if (locked || createOpen || actionItem) return;
        const due = orderedItems.find((item) => phaseById.get(item.id) === 'ongoing');
        if (!due) return;
        const at = tripItemDueAt(due.local_date, due.time);
        if (isAlarmHandled(due.id, at)) return;
        markAlarmHandled(due.id, at);
        router.replace({ pathname: '/alarm/[id]', params: { id: due.id } });
    }, [now, orderedItems, phaseById, createOpen, actionItem, locked]);

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
                // 空标题播报只报时刻（禁兜底词；join 口径同闹钟卡）
                accessibilityLabel: `${[item.time, tripItemDisplayTitle(item.title)].filter(Boolean).join(' ')}，${TRIP_ITEM_PHASE_LABEL[phaseById.get(item.id) ?? 'pending']}`,
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
                <TripItemSheet
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
        </View>
    );
}
