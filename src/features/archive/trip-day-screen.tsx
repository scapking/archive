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
    Platform,
    Pressable,
    Text,
    View,
    type ViewStyle,
} from 'react-native';
// v0.5.2 滚轮手势重建：RNGH Pan + Reanimated 共享值——列内容 translateY 全程
// UI 线程驱动，JS 只在落档时收一次 index（三端同构手势内核，仓库先例：
// events-screen 局部 GestureHandlerRootView 域）。
import {
    Gesture,
    GestureDetector,
    GestureHandlerRootView,
} from 'react-native-gesture-handler';
import Animated, {
    Easing,
    runOnJS,
    useAnimatedStyle,
    useSharedValue,
    withTiming,
} from 'react-native-reanimated';
// v0.5.1 令 1：应用内到点检查的动作通道（跳全屏闹钟屏；弹窗 TripItemAlarmCard
// 退场后本屏唯一路由出口）。v0.5.3 轮 A：+useFocusEffect——「表单编辑」回跳
// 信号在本屏 focus 时消费（push 笔记面时本屏保持挂载，返回不触发普通 effect）。
import { router, useFocusEffect } from 'expo-router';
// v0.5.1 看图验收返工：滚轮上下缘渐隐遮罩（expo-linear-gradient 双端可用，
// web 渲染为 CSS 渐变；纯功能性 mask，非装饰色场——0.4.9「整面渐变退场」
// 禁令不覆盖同底色渐隐）
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    LucideClock,
    LucideImage,
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
// 时刻拼装 + 滚轮落档仲裁（纯函数，node 测试直接覆盖）。v0.5.2 滚轮手势重建：
// 落档公式（位移 + 速度 → 目标行）收口在 wheelSnapIndex（'worklet' 指令使
// RNGH onEnd 可在 UI 线程直调，同一函数也是单测对象）——几何只有一个事实源。
import { normalizeWheelTime, wheelSnapIndex } from './trip-item-form-logic';
// 阶段机（纯函数，node 测试直接覆盖；阶段是派生态见模块头注）
import {
    TRIP_ITEM_PHASE_LABEL,
    tripItemDisplayTitle,
    tripItemPhaseMap,
    type TripItemPhase,
} from './trip-item-logic';
// v0.5.2 令 7：当日卡堆堆叠优先级（未到点项占前排；纯函数，trip-day-deck
// 测试直接覆盖）——行程项排序改由本模块承载，trip-item-logic 的通用时刻
// 排序不再进本屏。
import { orderTripItemsByDayDeckPriority } from './trip-day-deck-logic';
// v0.5.1 令 1：应用内到点检查的「本会话已处理」共享账（与 alarm-watcher/
// 全屏闹钟屏同一事实源；纯运行时零依赖模块，见 alarm-ladder 头注）。
import { isAlarmHandled, markAlarmHandled } from './alarm-ladder';
import {
    formatDateParts,
    isTripLocked,
    isValidLocalDate,
    todayLocal,
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
 * 行程表页（v0.5.2 令 7 重构，/trip/[id]/day/[date]）：某一天的全部行程项 =
 * 左右堆叠 deck，**堆叠优先级 = 未到点项占前排**（orderTripItemsByDayDeckPriority，
 * 见 trip-day-deck-logic；全部过点后回到默认时序）——
 *
 * - deck 前卡 = 「最该看的项」：未到点（闹钟未过）的行程优先展示；无未到点项
 *   时 ongoing（已到点未结束）段最早在前，收尾/终态垫底（deck 以卡序签名重挂
 *   收口，见 deckEpoch）；
 * - 卡面（v0.5.2 令 7：卡面自带笔记编辑位；v0.5.3 轮 A：卡面时刻点按直达笔记
 *   编辑面 trip-item-note-screen）：30px tabular 报时 + 18 semibold
 *   标题（可空：空标题不渲染任何文字、禁兜底词）+ **正文区即笔记（description）
 *   就地编辑面**——常驻可点，点进 multiline 编辑，失焦即
 *   store.updateTripItemContent(id,{description}) 落库；无时间闸（闹钟已过、
 *   done/settled 相照编，「还能找到就一直在」），锁定行程只读（无编辑面）。
 *   非编辑态显示 16 两行截断备注（空则占位文案）；首图封面 + mt-auto meta 行
 *   （状态字 + 备注/图/视频小记号）；报时数字 = 直达笔记编辑面的按压体
 *   （hitSlop 补足 44 命中）。三态记号**绑阶段不绑槽位**：ongoing =
 *   亮档纸 + accent 细边 + 圆点，pending = surface 素面，settled = 沉一档
 *   弱化；卡面文字恒走 text/secondary 两档 + accent 小面积（AA 把关见
 *   deck-stack-colors）；
 * - 长按前卡 → 操作卡（ActionMenuCard，两行制；v0.5.3 轮 A 口径）：**进入
 *   编辑**（直达行程项笔记编辑面 /trip/<id>/item/<itemId>/note，不再是
 *   表单——旧创建卡表单编辑态保留，从笔记面「表单编辑」回跳进入）/
 *   **删除行程**（用户口径去掉「项」字；danger，菜单即确认步，行为仍是删
 *   这条行程项）。旧动作梯（收尾迁移/媒体补录入口）随令 7 退场；阶段仍由
 *   trip-item-logic 派生，锁定行程 isTripLocked 时长按与 FAB 入口全部关断、
 *   卡面笔记位只读，整页只读；
 * - `+` FAB → 创建行程项**居中卡**（v0.5.2 手势重建）：快速态 = 时/分双列
 *   **自绘滚轮**（RNGH Pan + Reanimated UI 线程位移，无 ScrollView/无吸附
 *   属性/无复检链——三端手势吞失的根因治理），松手按速度+位移折算落档、点击
 *   非居中行滚到该行，「此刻」快捷收小 + 底部动作行（照新建事件语言）——
 *   「直接创建」= 无标题即提交（ghost 次级），「下一步」= 进第二步补填标题+
 *   备注（近黑主钮，末钮「添加」提交；备注位差异化 = multiline 大井 + 占位
 *   「补一句这一时刻」）。快速态 CenteredSheet scroll={false}（外层无滚动，
 *   根除同轴嵌套），第二步保持可滚；滚轮挂局部 GestureHandlerRootView 域 +
 *   挂载后首帧才启用 Pan（双击才可用缺陷的手势域闸）。键盘避让仍走 ui/sheet
 *   的 CenteredSheet 事件驱动几何。响铃 UI 早已退场但链路语义保留：创建提交
 *   恒传 withAlarm: true → store.createTripItem（title 可空；成功后自动调度
 *   本地通知，权限被拒静默降级）；
 * - **应用内闹钟**（页内 useEffect 定时检查；v0.5.1 令 1：页内「行程时间到」
 *   确认卡弹窗**退场**——触发判定保留，后续动作改为跳全屏闹钟屏
 *   /alarm/<id>：与通知深链/watcher/通知 tap 同一呈现形态，应用内不再有
 *   弹窗形态的闹钟。跳转前记入 alarm-ladder 共享会话账（确认后回本页
 *   同项仍 ongoing 不重复跳；本屏会因跳屏/返程反复卸载重挂，局部集会丢，
 *   共享账防复响回路），下一项到点再跳。任何覆盖层展开期间顺延
 *   （关闭后下一拍继续检查）；
 * - 数据面：行程项不进 store.loadAll 状态，mutation 成功 bump revision，本屏
 *   按 useArchiveRevision 局部重载（对齐事件/计划的刷新口径）；媒体挂
 *   trip_media 既有链路（item_id 关联）——本屏只读展示封面/记号，补录入口
 *   随长按菜单两行制退场（媒体链路本体在 store/db，未删）。
 */

/** deck 卡高（与首页 deck 同档 430；行程项卡体量适中，不放长卡）。 */
const DECK_HEIGHT = 430;

/** 应用内闹钟的检查节拍（ms）：到点检测粒度，15s 对「分钟级」的行程时刻足够。 */
const ALARM_TICK_MS = 15_000;

/** 无媒体项的稳定空表引用（memo 契约：每次新建 [] 会让卡面白重渲）。 */
const NO_MEDIA: readonly db.TripMediaRow[] = [];

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
 *   semibold 标题（2 行截断）→ 笔记位（16 两行截断正文 / 占位，常驻可点
 *   就地编辑，v0.5.2 令 7）→ 首图封面（笔记编辑态让位）→
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
    editable,
    onOpenMenu,
}: {
    /** v0.5.3：卡内嵌按压体（时刻/笔记位）长按 = 弹操作卡（与卡体空白区
     *  同一入口，兑现「长按卡任意处出操作卡」）；锁定态传 undefined 关断。 */
    onOpenMenu?: () => void;
    item: db.TripItemRow;
    /** 派生阶段（tripItemPhaseMap，与 deck 排序同源）；卡面记号唯一依据。 */
    phase: TripItemPhase;
    /** 首图封面媒体行（无关联图片为 null，不渲染封面）。 */
    cover: db.TripMediaRow | null;
    /** 该项全部媒体行（meta 行图/视频记号计数；无媒体传稳定空表）。 */
    media: readonly db.TripMediaRow[];
    /** 笔记位可编 = 行程未锁定（v0.5.2 令 7：无时间闸——闹钟已过、done/settled
     *  相照编；锁定只读是行程级状态，与时刻无关）。 */
    editable: boolean;
}) {
    const coverState = useFileUrlState(cover?.file_key ?? null);
    const palette = usePalette();
    // v0.5.2 令 7：正文区常驻 = 笔记（description）就地编辑面。点进编辑
    //（multiline FieldInput，uncontrolled 通道，屏层零裸 TextInput），失焦收笔
    // 即 updateTripItemContent 落库；「完成」无独立钮——失焦即收笔。编辑态隐藏
    // 封面让位笔记井（430 卡高预算）。
    const [noteEditing, setNoteEditing] = useState(false);
    const [noteDraft, setNoteDraft] = useState('');
    const startNoteEdit = () => {
        if (!editable) return;
        setNoteDraft(item.description);
        setNoteEditing(true);
    };
    const finishNoteEdit = () => {
        setNoteEditing(false);
        const next = noteDraft.trim();
        if (next !== item.description) {
            // store 单源：trim、拒绝文案（锁定/不存在）、闹钟重挂都在 action 内；
            // 失败经 store.error 通道上浮到屏头错误行，卡面不吞错误
            void useArchiveStore.getState().updateTripItemContent(item.id, { description: next });
        }
    };

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
            {/* 报时主角（30px tabular，日记卡日期刻度同感）+ v0.5.3 轮 A 令 1
                用户原话「点击 12:00 进入编辑面」——时刻数字 = 直达编辑面的按压体。
                命中区 = 30px 行盒 + hitSlop 8 ≥44 下限；卡内点按与 deck 翻卡
                拖拽的共处纪律沿用备注位 Pressable 先例（位移阈值外才归卡片
                手势，tap 直达行内钮） */}
            <Pressable
                onPress={() => {
                    haptics.selection();
                    router.push({
                        pathname: '/trip/[id]/item/[itemId]/note',
                        params: { id: item.trip_id, itemId: item.id },
                    });
                }}
                onLongPress={onOpenMenu}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`编辑 ${item.time} 的备注`}
                style={{ alignSelf: 'flex-start' }}
            >
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
            </Pressable>
            {displayTitle !== '' ? (
                <Text
                    numberOfLines={2}
                    className="mt-2 text-[18px] font-semibold text-ink-text dark:text-inkd-text"
                >
                    {displayTitle}
                </Text>
            ) : null}
            {/* 笔记位（v0.5.2 令 7）：编辑态 = raised 井 multiline；只读态 =
                两行截断正文 / 占位文案，整体常驻可点（无描述时点击区仍成立）。
                色走 secondary 档（卡面禁 muted，AA 闸 deck-stack-colors） */}
            {noteEditing ? (
                <View className="mt-2">
                    <FieldInput
                        tone="raised"
                        multiline
                        autoFocus
                        value={noteDraft}
                        onChangeText={setNoteDraft}
                        onBlur={finishNoteEdit}
                        placeholder="补一句这一时刻"
                        style={{ minHeight: 96 }}
                        accessibilityLabel="备注（失焦即保存）"
                    />
                </View>
            ) : (
                <Pressable
                    onPress={startNoteEdit}
                    onLongPress={onOpenMenu}
                    disabled={!editable}
                    accessibilityRole={editable ? 'button' : undefined}
                    accessibilityLabel={item.description ? '编辑备注' : '补一句这一时刻'}
                    className="min-h-6"
                >
                    {item.description ? (
                        <Text
                            numberOfLines={2}
                            className="text-[16px] leading-6 text-ink-secondary dark:text-inkd-secondary"
                        >
                            {item.description}
                        </Text>
                    ) : editable ? (
                        <Text className="text-[16px] leading-6 text-ink-secondary dark:text-inkd-secondary">
                            补一句这一时刻
                        </Text>
                    ) : null}
                </Pressable>
            )}
            {!noteEditing && cover != null && coverState.status === 'ready' && coverState.uri ? (
                // 首图封面（useFileUrlState 三态：loading/missing 不渲染，降级为纯卡面；
                // 笔记编辑态让位隐藏，收笔恢复）
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
/* 时间编辑（v0.5.2 滚轮手势重建：滚动容器吸附轮 → RNGH + Reanimated     */
/* 自绘确定性滚轮，三端同构）                                            */
/* ------------------------------------------------------------------ */

/**
 * 用户点名参考 v0.4.3 的滚动选时语义（滚动即选、跟手、松手落中线），但内核
 * v0.5.2 整块重建。真机 + web 反馈「上下滑动任何方式都不可用」的根因定性：
 * 旧形态 = 原生 ScrollView 嵌在 CenteredSheet 外层卡体 ScrollView 内
 * （同轴嵌套滚动被外层吞抢）+ 卡体 responder 认领，且 RNW 0.21 静默忽略
 * snapToInterval——JS settle + 120ms setTimeout 复检链治不住三端手势丢失，
 * v0.5.0 的卡体认领更把 web 从「可用不完全」推到「全灭」。
 *
 * 新内核**零滚动容器**：列内容是一根普通 Animated.View，RNGH Gesture.Pan()
 * 驱动 translateY——位移全程 UI 线程（reanimated 共享值，web 落 CSS transform
 * /native 走原生动画），JS 只在落档那一刻经 runOnJS 收一次 index：
 * - 拖动：translationY 1:1 跟手（反向），越界橡皮筋 ×0.35，与翻卡手感同语；
 * - 松手：wheelSnapIndex（纯函数，node 测试直测）把速度按 0.12s 投影进位移
 *   折算目标行 → withTiming 吸附中线；粗略 fling 档，不追求物理精确；
 * - 点按：Pan 仅在纵向位移 >6px 后认领，点击直达行内 Pressable——
 *   点非居中行 = 该行滚到中线并被选中；
 * - 手势域：sheet 覆盖层由宿主局部包 GestureHandlerRootView（仓库先例
 *   events-screen，不碰全局 _layout）；「要点两下才可用」= 首帧手势域未
 *   就绪嫌疑，挂载 rAF 后首帧才启用 Pan（armed 闸；「此刻」epoch 重挂同
 *   通道，重挂后照常可用）。
 *
 * 解剖定档全部沿用 v0.5.1 看图验收定版（5 行窗 × 44dp 行高、上下回绕垫行、
 * raised 井底 + base 中带、上下缘 linear-gradient 渐隐 pointerEvents-none、
 * 中行 20/600 vs 邻行 15/400）——只换手势内核。字阶异级仍由落档一次性
 * setState（index prop）驱动，与 UI 线程位移通道解耦；**结构上禁滚动容器
 * 属性（snapToInterval）/程序化滚动调用/滚动结束事件/复检轮询/逐帧 setState**
 * （tests/trip-time-picker 反回潮闸把关）。
 */
const WHEEL_ROW_H = 44;
/** 上下垫行数：(5 行窗口 − 1 中线) / 2 = 2，把首末项滚到中线；渐隐遮罩同高。 */
const WHEEL_PAD_ROWS = 2;
const WHEEL_VISIBLE_ROWS = 5;
/** 落档吸附时长（ms）：松手后 180ms 内定形——快而不弹。 */
const WHEEL_SNAP_MS = 180;
/** 越界拖拽橡皮筋阻尼（与 deck 翻卡拖拽同语言）。 */
const WHEEL_RUBBER = 0.35;
/** 滚轮认领触摸所需的纵向位移阈值（px）：阈值内不认领，点按直通行内钮。 */
const WHEEL_PAN_ACTIVE_DY = 6;
/** web 独有：滚轮井面关闭浏览器触摸滚动仲裁（拖动中被合成器判滚动 =
 *  touchcancel 手势夭折，deck.tsx 同教训）；RN 类型未收录 touchAction，
 *  单点 cast（DECK_TOUCH_ACTION_STYLE 同法）。 */
const WHEEL_WEB_TOUCH: ViewStyle | null =
    Platform.OS === 'web' ? ({ touchAction: 'none' } as unknown as ViewStyle) : null;
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
 * 滚轮单行：active 只由落档通道更新的 index 派生——实体中行为 true，渐隐区
 * 邻行与回绕垫行恒 false（15/400 secondary 弱档）。行高 = WHEEL_ROW_H
 * （44dp 触控下限档，垫行与实体行同构，居中线公式不变）。非居中实体行可点
 * （onPress = 滚该行到中线并选中）；回绕垫行不挂 onPress（纯视觉环回，
 * 不是候选值，落档 clamp 与吸附公式零接触）。
 */
function WheelValueRow({
    value,
    active,
    onPress,
}: {
    value: number;
    active: boolean;
    onPress?: () => void;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={onPress}
            disabled={onPress === undefined}
            accessibilityRole={onPress === undefined ? undefined : 'button'}
            accessibilityLabel={onPress === undefined ? undefined : `选到 ${pad2(value)}`}
            className="items-center justify-center"
            style={{ height: WHEEL_ROW_H }}
        >
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
        </Pressable>
    );
}

/**
 * 自绘确定性滚轮列（v0.5.2 手势内核，见段头注）：位移 = UI 线程共享值
 * （口径与旧 ScrollView 的滚动偏移严格一致：行 i 居中 ⇔ offset = i×ROW_H，
 * 垫行纯视觉不入公式）。列自身不做受控回写：index prop 只在挂载时定初位、
 * 并驱动字阶异级；「此刻」等外部跳变由宿主以 key 重挂本列完成定位。
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
    /** 当前值在 values 中的下标（时列 = hour；分列 = minute / 5）。 */
    index: number;
    onSelect(index: number): void;
    accessibilityLabel: string;
}) {
    const palette = usePalette();
    const count = values.length;
    const maxOffset = (count - 1) * WHEEL_ROW_H;
    const offset = useSharedValue(index * WHEEL_ROW_H);
    const dragStartOffset = useSharedValue(0);
    /** 已交付给 JS 的行（松手/点按共用判重：同档不重复 onSelect/haptics）。 */
    const committed = useSharedValue(index);
    // 双击闸：挂载完成（首帧布局落定、手势域就绪）后才启用 Pan——rAF 一帧
    // 即可；epoch 重挂走同一通道
    const [armed, setArmed] = useState(false);
    useEffect(() => {
        const frame = requestAnimationFrame(() => setArmed(true));
        return () => cancelAnimationFrame(frame);
    }, []);
    // 手势图只在挂载/armed 翻转时重建；onSelect 经 ref 镜像取最新
    //（父卡每次渲染传内联闭包，直接入依赖会让 RNGH 识别器每帧重建）
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const emitSelect = useCallback((next: number) => {
        haptics.selection(); // 落档触感（旧芯片触感口径保留）
        onSelectRef.current(next);
    }, []);

    /** JS 线程侧吸附（行内点按通道；与手势 onEnd 同一落档公式与动画）。 */
    const snapTo = (target: number) => {
        offset.value = withTiming(target * WHEEL_ROW_H, {
            duration: WHEEL_SNAP_MS,
            easing: Easing.out(Easing.cubic),
        });
        if (target !== committed.value) {
            committed.value = target;
            emitSelect(target);
        }
    };

    const pan = useMemo(
        () =>
            Gesture.Pan()
                .enabled(armed)
                // 位移超阈值才接管触摸：阈值内放行 → 点按直达行内 Pressable
                .activeOffsetY([-WHEEL_PAN_ACTIVE_DY, WHEEL_PAN_ACTIVE_DY])
                .onBegin(() => {
                    'worklet';
                    dragStartOffset.value = offset.value;
                })
                .onUpdate((event) => {
                    'worklet';
                    // 手指下行 → 位移减小（值向下走）；越界橡皮筋收敛。
                    // 全程只写共享值——零 setState、零 JS 逐帧参与
                    const raw = dragStartOffset.value - event.translationY;
                    if (raw < 0) {
                        offset.value = raw * WHEEL_RUBBER;
                    } else if (raw > maxOffset) {
                        offset.value = maxOffset + (raw - maxOffset) * WHEEL_RUBBER;
                    } else {
                        offset.value = raw;
                    }
                })
                .onEnd((event) => {
                    'worklet';
                    // 落档唯一裁决口 = wheelSnapIndex（位移 + 速度 → 目标行，
                    // clamp 值域——松手必落中线合法档）；JS 只在这一次收到 index，
                    // 无复检链、无轮询、无逐帧动画驱动选中
                    const target = wheelSnapIndex(
                        offset.value,
                        event.velocityY,
                        WHEEL_ROW_H,
                        count,
                    );
                    offset.value = withTiming(target * WHEEL_ROW_H, {
                        duration: WHEEL_SNAP_MS,
                        easing: Easing.out(Easing.cubic),
                    });
                    if (target !== committed.value) {
                        committed.value = target;
                        runOnJS(emitSelect)(target);
                    }
                }),
        [armed, count, maxOffset, offset, dragStartOffset, committed, emitSelect],
    );

    const contentStyle = useAnimatedStyle(() => ({
        transform: [{ translateY: -offset.value }],
    }));

    return (
        <View className="flex-1">
            <Text className="text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                {label}
            </Text>
            <View
                accessibilityLabel={accessibilityLabel}
                className="mt-1.5 overflow-hidden rounded-control bg-ink-raised dark:bg-inkd-raised"
                style={[{ height: WHEEL_VISIBLE_ROWS * WHEEL_ROW_H }, WHEEL_WEB_TOUCH]}
            >
                {/* 中带实体底板（先铺 → 行位移其上）：base 白条对 raised 井底，
                    light 侧 #F0F2F5→#FFFFFF 肉眼可辨；pointerEvents none 不挡手势 */}
                <View
                    pointerEvents="none"
                    className="absolute left-0 right-0 bg-ink-base dark:bg-inkd-base"
                    style={{
                        top: WHEEL_PAD_ROWS * WHEEL_ROW_H,
                        height: WHEEL_ROW_H,
                    }}
                />
                {/* 手势域 = 井口整窗（含渐隐缘带）；内容列只做 transform */}
                <GestureDetector gesture={pan}>
                    <Animated.View style={contentStyle}>
                        {/* 回绕垫行（端档时缘带不空 = 「环」的视觉）：上垫 = 值域
                            末 PAD 值，下垫 = 首 PAD 值；恒弱档、不可选 */}
                        {Array.from({ length: WHEEL_PAD_ROWS }, (_, i) => (
                            <WheelValueRow
                                key={`pad-top-${i}`}
                                value={values[values.length - WHEEL_PAD_ROWS + i]}
                                active={false}
                            />
                        ))}
                        {values.map((value, i) => (
                            <WheelValueRow
                                key={value}
                                value={value}
                                active={i === index}
                                onPress={() => snapTo(i)}
                            />
                        ))}
                        {Array.from({ length: WHEEL_PAD_ROWS }, (_, i) => (
                            <WheelValueRow key={`pad-bot-${i}`} value={values[i]} active={false} />
                        ))}
                    </Animated.View>
                </GestureDetector>
                {/* 上下缘渐隐遮罩（盖在行上，pointerEvents none）：井底色 raised →
                    同色 alpha 0，各 2 行高——行滚到边缘化开，「滚轮」纵深信号；
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
 * 添加/编辑行程项居中卡（v0.5.2 手势重建 + 令 7 编辑态复用）：
 * - 形态 = CenteredSheet（keyboardDidShow/Hide 直读键盘高度抬卡、maxHeight
 *   让位、footer 钉底；禁 RN Modal）。新增 scroll 闸：滚轮快速态传
 *   scroll={false} 关掉外层卡体 ScrollView（同轴嵌套滚动 = 滚轮手势被吞的
 *   根因之一），第二步含输入框保持可滚；整卡挂在局部 GestureHandlerRootView
 *   域内（宿主 TripDayScreen 覆盖层包，RNGH 生效前提）；
 * - 快速态就两件事：时刻双列自绘滚轮（TimeWheelColumn 注，手势内核同段）+
 *   底部动作行。「直接创建」（ghost，surface 次级）= 无标题即提交；
 *   「下一步」（primary-btn 近黑）= 进第二步补填标题+备注（渐进交互；
 *   动作行 = 「改时间」ghost 回滚轮 + 「添加」主钮提交）。备注位与标题
 *   明显区分：multiline 大井（minHeight 116）+ 占位「补一句这一时刻」；
 *   动作行走 footer 槽钉卡底 = 契约「容器外底部单行」，键盘弹起恒在键盘上方；
 * - **编辑态（v0.5.2 令 7 立；v0.5.3 轮 A 入口下移：长按菜单直通笔记编辑面，
 *   本形态改由笔记面「表单编辑」回跳打开，见 pendingFormEditSeed）**：
 *   同组件同表单、初始即第二步形态（标题/备注预填），提交走 store.updateTripItemContent
 *   （trim、锁定拒绝文案、未到点 pending 自动重挂闹钟都在 store 单源）。
 *   时刻只读回显（内容通道不含时间改动），动作行 = 「关闭」ghost +
 *   「保存」主钮。选择此形态 = 改动最小、与「新建行程项」UI 完全一致；
 * - withAlarm：UI 早已删，创建链路语义保留——提交恒传 withAlarm: true；
 * - 红线保持：Android 返回键（创建态第二步先回滚轮、滚轮态关闭；编辑态
 *   直接关）、打开即收键盘、errorText 就地重试、onSubmit({time,title,
 *   description,withAlarm}) 契约形状不变（title 自 v0.5.1 可为空串）；
 *   native 输入只走 FieldInput 的 uncontrolled 通道（本屏零裸 TextInput），
 *   聚焦挂 scrollIntoView 二次保险。
 */
function TripItemSheet({
    onSubmit,
    onClose,
    errorText,
    editItem,
}: {
    /** 提交通道（store.createTripItem）：resolve false = 失败（弹层保持打开）。 */
    onSubmit(input: { time: string; title: string; description: string; withAlarm: boolean }): Promise<boolean>;
    onClose(): void;
    /** store.error 就地文案（失败后展示，避免陈旧错误串场）。 */
    errorText: string | null;
    /** v0.5.2 令 7：非空 = 编辑态（创建表单同款预填；时刻只读；由宿主以
     *  key 按项重挂本卡，切换编辑对象即换卡）。 */
    editItem?: db.TripItemRow | null;
}) {
    const palette = usePalette();
    const isEdit = editItem != null;
    // 聚焦保险（sheet 原语提供）：键盘已弹起时换字段 focus 不再触发键盘事件，
    // 由本钩子把聚焦框滚进键盘上沿可见区（第二步标题/备注共用）
    const guardFieldFocus = useSheetFieldFocusGuard();
    // 时间初值 = 「下一个可选的整 5 分钟」（与「此刻」快捷同派生；59 分→整点
    // 进位取 24 模）。一次取 now 定格快照，两个 useState 共用（分取两次 Date
    // 会跨分钟漂移）。编辑态不走滚轮（时刻只读），初值仅为契约保留位。
    const [initialTime] = useState(() => nextFiveMinuteSlot(new Date()));
    const [hour, setHour] = useState(initialTime.hour);
    const [minute, setMinute] = useState(initialTime.minute);
    // 「此刻」= 外部跳变：滚轮列不做受控回写（见 TimeWheelColumn 注），
    // 以 epoch 参与 key 重挂双列，挂载即落新值
    const [wheelEpoch, setWheelEpoch] = useState(0);
    const [step, setStep] = useState<'time' | 'detail'>(isEdit ? 'detail' : 'time');
    const [title, setTitle] = useState(editItem?.title ?? '');
    const [note, setNote] = useState(editItem?.description ?? '');
    const [saveFailed, setSaveFailed] = useState(false);
    const submittingRef = useRef(false);

    const timeLabel = normalizeWheelTime(hour, minute);
    const atNow = hour === initialTime.hour && minute === initialTime.minute;

    // 打开即收键盘（快速态零输入框）；Android 返回键：创建态第二步先回滚轮、
    // 滚轮态关闭；编辑态直接关（替代 Modal onRequestClose 语义）
    useEffect(() => {
        Keyboard.dismiss();
    }, []);
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (!isEdit && step === 'detail') {
                Keyboard.dismiss();
                setStep('time');
                return true;
            }
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [isEdit, onClose, step]);

    const submit = async () => {
        if (submittingRef.current) return;
        setSaveFailed(false);
        submittingRef.current = true;
        try {
            const ok = isEdit
                ? // 编辑通道（令 7）：给了才动、trim、闹钟文案重挂、锁定拒绝
                  // 全在 store.updateTripItemContent 单源；屏层零时间闸
                  await useArchiveStore
                      .getState()
                      .updateTripItemContent(editItem.id, {
                          title: title.trim(),
                          description: note.trim(),
                      })
                : await onSubmit({
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
        // 手势域：RNGH 要求 GestureHandlerRootView 祖先——本覆盖层自带局部域
        //（absolute 铺满 = CenteredSheet 的 absolute inset-0 根层挂进来的同几何，
        // 布局零扰动；先例 events-screen 局部包裹，不碰全局 _layout）
        <GestureHandlerRootView style={SHEET_GESTURE_ROOT}>
            <CenteredSheet
                onClose={onClose}
                // 滚轮快速态关外层内滚（scroll=false）根除同轴嵌套；第二步含
                // 输入框保持可滚（键盘避让/超限滚动通道都在原语内）
                scroll={step !== 'time'}
                scrimAccessibilityLabel={isEdit ? '关闭编辑行程项' : '关闭添加行程项'}
                sheetAccessibilityLabel={isEdit ? '编辑行程项面板' : '添加行程项面板'}
                footer={
                    <>
                        {/* 动作行走 footer 槽钉卡底（= 契约「容器外底部单行」，键盘
                            弹起恒在键盘上方、不随滚动被吞）；标题可空后无禁用闸，
                            仅防重入 */}
                        <View className="flex-row gap-3">
                            {isEdit ? (
                                <>
                                    {ghostBtn('关闭', onClose)}
                                    {primaryBtn('保存', () => void submit())}
                                </>
                            ) : step === 'time' ? (
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
                        {isEdit ? '编辑行程项' : '添加行程项'}
                    </Text>
                    <CloseButton onPress={onClose} />
                </View>

                {step === 'time' ? (
                    <>
                        {/* 快速态 = 时刻滚轮 + 动作行（footer），中间再无别的字段。
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
                            <TimeWheelColumn
                                key={`hour-${wheelEpoch}`}
                                label="时"
                                values={HOUR_VALUES}
                                index={hour}
                                onSelect={setHour}
                                accessibilityLabel="小时（上下滚动或点行选择）"
                            />
                            <TimeWheelColumn
                                key={`minute-${wheelEpoch}`}
                                label="分"
                                values={MINUTE_VALUES}
                                index={minute / 5}
                                onSelect={(i) => setMinute(i * 5)}
                                accessibilityLabel="分钟（上下滚动或点行选择，5 分钟一档）"
                            />
                        </View>
                    </>
                ) : (
                    <>
                        {/* 第二步（渐进补填）：时间回显行创建态点按即回滚轮改时；
                            编辑态只读（updateTripItemContent 通道不含时刻改动）。
                            标题/备注都选填——「添加」空字段提交也合法 */}
                        {isEdit ? (
                            <View className="mt-4 flex-row items-center justify-between rounded-control bg-ink-surface px-4 py-3 dark:bg-inkd-surface">
                                <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                    开始时间
                                </Text>
                                <Text
                                    className="text-[15px] font-semibold text-ink-text dark:text-inkd-text"
                                    style={{ fontVariant: ['tabular-nums'] }}
                                >
                                    {editItem.time}
                                </Text>
                            </View>
                        ) : (
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
                        )}
                        <Text className="mt-4 text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                            标题（选填）
                        </Text>
                        <FieldInput
                            tone="raised"
                            autoFocus={!isEdit}
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
                        {/* 备注位差异化（v0.5.2 用户令）：与标题单行明显区分 =
                            multiline 大井（minHeight 116 ∈ 110-128 档）+ raised
                            井底 + 占位「补一句这一时刻」 */}
                        <Text className="mt-4 text-[11px] font-medium text-ink-muted dark:text-inkd-muted">
                            备注（选填）
                        </Text>
                        <FieldInput
                            tone="raised"
                            multiline
                            value={note}
                            onChangeText={setNote}
                            placeholder="补一句这一时刻"
                            style={{ minHeight: 116 }}
                            onFocus={() => guardFieldFocus()}
                            containerClassName="mt-1.5"
                            accessibilityLabel="行程项备注"
                        />
                    </>
                )}
            </CenteredSheet>
        </GestureHandlerRootView>
    );
}

/** TripItemSheet 覆盖层的手势根域（absolute 铺满，与原语根层同几何）。 */
const SHEET_GESTURE_ROOT: ViewStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
};

// v0.5.1 令 1：应用内「行程时间到」确认卡（TripItemAlarmCard）整块退场——
// 弹窗形态废止，到点呈现统一走全屏闹钟屏 /alarm/<id>（到点检查 effect 见
// TripDayScreen 内「应用内闹钟」段，触发判定保留、动作改为路由跳转）。

/* ------------------------------------------------------------------ */
/* v0.5.3 轮 A：笔记编辑面「表单编辑」回跳信号                            */
/* ------------------------------------------------------------------ */

/**
 * 一次性回跳信号：笔记编辑面点「表单编辑」→ 置本值 → router.back()，本屏
 * focus 时消费（useFocusEffect，见 TripDayScreen），命中则打开创建卡同款
 * 表单编辑态。选内存账而非路由参数：expo-router web push 丢 query 是已登记
 * 偏差（AGENTS.md 偏差表），router.back 又无法带参——路径参数通道塞不进
 * 可选信号，纯运行时单变量才是三端一致的最小改动（alarm-ladder 共享会话账
 * 同技法：零依赖、单点、消费即清）。
 *
 * 传**行快照**而非 id：快照带笔记面刚写的 description（openFormEdit 先落库
 * 再回跳，快照即最新值），表单预填不再依赖本屏 revision 重载与 focus 的先后
 * ——读 id 再查 items 的写法会让「重载未及完成先 focus」竞态把旧备注预填进
 * 表单，保存即回滚笔记改动。归属与存在性以本屏 items 为准（id 不在当日项
 * 集 = 已删/跨日错屏，静默丢弃）；行程锁定时同样丢弃，不锁存不重放。
 */
let pendingFormEditSeed: db.TripItemRow | null = null;

/** 笔记编辑面调用：请求返回本屏后以该行快照打开表单编辑态。 */
export function requestTripItemFormEdit(item: db.TripItemRow): void {
    pendingFormEditSeed = item;
}

export function TripDayScreen({ tripId, date }: { tripId: string; date: string }) {
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const revision = useArchiveRevision();
    // v0.5.2 收口：冷启动直达 /trip/<id>/day/<date> 时 db.getTrip 可能跑在
    // store.loadAll 完成之前（OPFS 首开慢一拍）——旧代码把这一拍的失败锁存成
    // 「找不到这一天」死路（UI 导航同 URL 却正常，实锤竞态）。ready 入 reload
    // 依赖：未就绪不查库、保持 LoadingView，ready 翻真自动补跑。
    const storeReady = useArchiveStore((s) => s.ready);
    const storeError = useArchiveStore((s) => s.error);
    const createTripItem = useArchiveStore((s) => s.createTripItem);
    const deleteTripItem = useArchiveStore((s) => s.deleteTripItem);

    const [loading, setLoading] = useState(true);
    const [missing, setMissing] = useState(false);
    // 冷启动/锁争用重试预算（与 trip-detail 同款）：计数 + 定时器句柄
    const loadRetryRef = useRef(0);
    const loadRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    /** 编辑表单卡目标（v0.5.2 令 7 立在长按菜单；v0.5.3 轮 A 起由笔记面
     *  「表单编辑」回跳信号喂入，见 pendingFormEditSeed；与 createOpen 互斥）。 */
    const [editItem, setEditItem] = useState<db.TripItemRow | null>(null);

    // 本屏数据重载：trip + 该天行程项 + 行程媒体（item_id 分组）。revision 漂移
    // （本屏 mutation 或其他屏的数据变化）自动重载；行程项不进 store.loadAll。
    const reload = useCallback(async () => {
        if (typeof tripId !== 'string' || tripId.length === 0 || !isValidLocalDate(date)) {
            setMissing(true);
            setLoading(false);
            return;
        }
        if (!storeReady) return; // hydration 竞态闸（见 storeReady 注）
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
            loadRetryRef.current = 0;
        } catch {
            // v0.5.2 收口（对齐 trip-detail 同款预算）：db 抛错区分瞬时失败
            // （OPFS 单写锁瞬态争用/启动竞态）与真错——瞬时自动重试两轮
            // （700/1600ms）再失败才走「行程不存在」降级态。旧代码一次
            // 锁冲突就锁生死路，正是冷启动深链「找不到这一天」的实锤根因。
            if (loadRetryRef.current < 3) {
                loadRetryRef.current += 1;
                clearTimeout(loadRetryTimerRef.current);
                loadRetryTimerRef.current = setTimeout(() => void reload(), loadRetryRef.current === 1 ? 700 : loadRetryRef.current === 2 ? 1600 : 2600);
                return;
            }
            setMissing(true);
            setLoading(false); // 预算耗尽显式摘 loading（finally 在 retry≠0 时不动它，缺这行会永久卡 Loading）
        } finally {
            if (loadRetryRef.current === 0) setLoading(false);
        }
    }, [tripId, date, storeReady]);

    useEffect(() => {
        void reload();
    }, [reload, revision]);

    // 卸载摘除重试定时器（防卸载后 reload 触发 setState 泄漏）
    useEffect(() => () => {
        if (loadRetryTimerRef.current != null) clearTimeout(loadRetryTimerRef.current);
    }, []);

    // 前台时钟：应用内闹钟到点检查 + deck 排序的「已到时间」判据（15s 节拍，
    // 分钟级时刻足够；卸载即收口）
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), ALARM_TICK_MS);
        return () => clearInterval(timer);
    }, []);

    // 卡堆排序（v0.5.2 令 7：未到点项占前排，全部过点回到默认时序，见
    // orderTripItemsByDayDeckPriority）；前卡 = items[0]
    const orderedItems = useMemo(
        () => orderTripItemsByDayDeckPriority(items, now),
        [items, now],
    );

    // 逐项阶段表（与排序同一推导，tripItemPhaseMap 单源）：卡面记号、
    // 应用内闹钟条件共用
    const phaseById = useMemo(() => tripItemPhaseMap(items, now), [items, now]);

    // deck 重挂纪元：卡序签名变化（阶段迁移、未到点项跃升前排、增删项）
    // 时整组重挂 → deck 前卡恒为 items[0]（优先级最高的项），不被内部翻卡指针
    // 带偏；纯内容重载（如改备注）签名不变，翻卡位置与就地编辑态得以保留。
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
        if (locked || createOpen || actionItem || editItem) return;
        const due = orderedItems.find((item) => phaseById.get(item.id) === 'ongoing');
        if (!due) return;
        const at = tripItemDueAt(due.local_date, due.time);
        if (isAlarmHandled(due.id, at)) return;
        markAlarmHandled(due.id, at);
        router.replace({ pathname: '/alarm/[id]', params: { id: due.id } });
    }, [now, orderedItems, phaseById, createOpen, actionItem, editItem, locked]);

    // v0.5.3 轮 A：消费笔记编辑面「表单编辑」回跳信号（信号语义见
    // pendingFormEditSeed 注）。必须挂 focus 而非普通 effect——push 笔记面时
    // 本屏在栈上保持挂载，返回不重跑 items/revision 效应。一次性：无论命中
    // 与否消费即清；无本屏在栈的深链场景由下一次进入本屏时按同规则丢弃。
    useFocusEffect(
        useCallback(() => {
            const seed = pendingFormEditSeed;
            if (seed === null) return;
            pendingFormEditSeed = null;
            if (locked) return;
            if (!items.some((row) => row.id === seed.id)) return; // 已删/不属于这一天
            setEditItem(seed);
        }, [items, locked]),
    );

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
                node: (() => {
                    // v0.5.3：同一长按 handler 双路——卡体空白走 deck 容器
                    // 长按，时刻/笔记位内嵌按压体走 face 的 onOpenMenu 转发
                    // （否则长按落在热点上会被点按语义吞成导航/就地编辑，
                    // 「长按任意处出操作卡」破洞）。closure 按 item 派生，
                    // deps 变化才重建（与 node 同周期，memo 面不空转）。
                    const openMenu = locked
                        ? undefined
                        : () => {
                              haptics.impact('medium');
                              setActionItem(item);
                          };
                    return (
                        <TripItemCardFace
                            item={item}
                            phase={phaseById.get(item.id) ?? 'pending'}
                            cover={coverFor(item.id)}
                            media={mediaByItem.get(item.id) ?? NO_MEDIA}
                            editable={!locked}
                            onOpenMenu={openMenu}
                        />
                    );
                })(),
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

    /** 「删除行程」行（长按操作卡，菜单即确认步）：删这条行程项——软删 +
     *  摘媒体关联 + 取消通知（store 编排）。 */
    const runDelete = useCallback(
        async (itemId: string) => {
            setActionItem(null);
            await deleteTripItem(itemId);
        },
        [deleteTripItem],
    );

    if (loading) return <LoadingView />;

    if (missing || !trip || !isValidLocalDate(date)) {
        return (
            // 外层 insets.top 口径与 trip-detail 死路页逐 dp 对齐
            <View className="flex-1 bg-ink-base dark:bg-inkd-base" style={{ paddingTop: insets.top }}>
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <Text className="ml-2.5 text-[24px] font-semibold text-ink-text dark:text-inkd-text">
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
                {/* 屏头（v0.5.2 轮 B 统一规格：24px semibold 屏题、无副标题
                    描述行；几何 px-6 pb-3 pt-2 + h-11 行 + CloseButton 44
                    圆形触感底盒）：日期大标题（M月D日 周X）即屏题 */}
                <View className="px-6 pb-3 pt-2">
                    <View className="h-11 flex-row items-center">
                        <CloseButton icon="back" onPress={safeBack} />
                        <Text
                            numberOfLines={1}
                            className="ml-2.5 min-w-0 flex-1 text-[24px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {`${monthDay} ${weekday}`}
                        </Text>
                    </View>
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
                    优先级最高的项——未到点在前，见 deckEpoch 注） */}
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
            {/* 覆盖层（条件渲染，禁 Modal，互斥可达：scrim 盖屏时其他入口
                不可触；创建卡与编辑卡共用组件、按 id 重挂换值） */}
            {createOpen ? (
                <TripItemSheet
                    key="trip-item-create"
                    onSubmit={runCreateTripItem}
                    onClose={() => setCreateOpen(false)}
                    errorText={storeError}
                />
            ) : null}
            {editItem ? (
                <TripItemSheet
                    key={`trip-item-edit-${editItem.id}`}
                    editItem={editItem}
                    onSubmit={runCreateTripItem}
                    onClose={() => setEditItem(null)}
                    errorText={storeError}
                />
            ) : null}
            {actionItem ? (
                <ActionMenuCard
                    title="行程项"
                    rows={[
                        // v0.5.3 轮 A 口径（两行制不变）：进入编辑 = 直达笔记
                        // 编辑面（表单编辑态退为笔记面次级入口）/ 删除行程
                        // （用户口径去掉「项」字，行为仍是删这条行程项，
                        // danger，菜单即确认步）。旧动作梯随令 7 退场。
                        {
                            key: 'edit',
                            icon: <LucideStickyNote size={18} strokeWidth={1.9} />,
                            title: '进入编辑',
                        },
                        {
                            key: 'delete',
                            icon: <LucideTrash size={18} strokeWidth={1.9} />,
                            title: '删除行程',
                            danger: true,
                        },
                    ]}
                    onAction={(key) => {
                        if (!actionItem) return;
                        if (key === 'edit') {
                            const target = actionItem;
                            setActionItem(null);
                            router.push({
                                pathname: '/trip/[id]/item/[itemId]/note',
                                params: { id: target.trip_id, itemId: target.id },
                            });
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
