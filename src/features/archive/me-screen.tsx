import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import {
    AccessibilityInfo,
    Animated,
    Easing,
    Pressable,
    ScrollView,
    Text,
    View,
    type NativeEventSubscription,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
    LucideCalendar,
    LucideChevronRight,
    LucideFlag,
    LucideListTodo,
    LucideSearch,
    LucideSettings,
} from '@/core/icons';
import { haptics } from '@/core/haptics';
import { useArchiveRevision, useArchiveStore } from './store';
import { LineChart, LoadingView, PAPER_CARD_SHADOW, usePalette } from './ui';

/**
 * Me：身份行（Me 标题 + 连续天数）、指标卡（3 格 KPI 单行 + 30 天曲线）、
 * 我的内容组（搜索 / 事件 / 行程卡 / 设置行）。
 * 本屏唯一问题："我坚持得怎么样，东西在哪？"
 *
 * 信息收敛口径（v0.4.6 指令 5 再收敛——「我的内容卡片容器信息负担太大，砍了」）：
 * - 身份行：纯文本标题行（无头像/UID），连续天数只在此出现一次——KPI 不再
 *   重复渲染同语义数值；屏题档 24、副行 16（字阶纪律）；
 * - 指标：3 格 KPI 单行 + 30 天曲线并作一张 surface 卡。数值升 24 档（卡内
 *   屏题等档，一屏只留两个大字号声部），标签 11、曲线题 16 + 单位 11。
 *   卡内**无任何内部分隔线**：KPI 格间靠两侧 px-3 留白相加（24px），曲线段与
 *   KPI 段靠 py-3×2 纵向节奏——分区靠留白不靠线（Apple Journal 卡片节奏）；
 * - 内容：搜索 / 事件 / 计划 / 行程并作**一张** rounded-card surface 卡，
 *   四行同解剖（图标 + 名 16 + chevron，h-12，行间零线条）。**行尾计数
 *   「进行 X · 完成 Y · 失败 Z」「进行 X · 历史 Y」整体退场**（指令 5 点名的
 *   信息负担：全零时是纯噪音，非零时数字与入口动作也无决策价值——状态分布
 *   在各自列表页/deck 里看）；计划/行程两行与搜索/事件两行合并为同一
 *   ContentEntryRow 实现（原两行是手抄的第二套行解剖，容器减负顺手收口）。
 *   入口行 → 各列表/堆页（计划 → /plans、行程 → /trips 堆叠库）。
 *   **行程行恒静态（2026-11-19 用户指令）**：不展开行程列表；
 * - 设置：保持独立一张卡（2026-11-19 用户指令「设置卡片单独一个 + 大一些」
 *   延续），行体加高 py-4；设置页收口外观 / App 锁 / 备份与恢复，Me 只留
 *   一行入口；
 * - 层级：身份行 → 指标卡 → 我的内容组 → 设置组，共 4 块；区块间距统一 24
 *   （mt-6），全部落在 4dp 网格上；
 * - 动效（RN Animated native driver，同 BouncyPressable / boot-screen 通道，
 *   不用 reanimated——Fabric 上驱动触摸视图样式有概率吞按压）：内容单元
 *   fade + translateY 交错进场（300ms ease-out、60ms 步进、reduceMotion 直接
 *   终态，见 Enter），曲线 opt-in 淡入（line-chart.animated，仅本屏开启）；
 *   动画层与布局/触摸层分离（Enter 外层普通 View 承担 className、内层
 *   Animated.View 只挂动画 style，Pressable 一律在其 children 内部）。
 */

/** 进场节奏常量：单元 300ms（boot-screen 淡入同档）、交错 60ms（40~70ms
    区间中值）、卡片类位移 10dp（8~12 上限内）。整条时间线 ~1s 内收尾。 */
const ENTER_DURATION = 300;
const ENTER_STAGGER = 60;
const ENTER_OFFSET_Y = 10;

/**
 * 进场单元：fade + translateY 一次性入场（mount 即播，不重放）。
 * - 动画层与布局/触摸层分离：**className 挂外层普通 View，Animated.View 只挂
 *   内联动画 style（仅 opacity + transform、useNativeDriver，铁律）**——
 *   2026-11 修复 web desktop「Me 页部分 css 失效」：根因 = css-interop 的
 *   interop 注册表只登记 RN 原生组件（wrapJSX 按类型查表替换，见
 *   react-native-css-interop runtime/components.js），Animated.View 不在表；
 *   native 上 RN 源码 JSX 经 nativewind jsxImportSource 编译、内部 View 命中
 *   注册表，className「转发落地」恰好可用；web 上 react-native-web 是预编译
 *   产物（无 JSX，且 css-interop babel 插件的 allowedFileRegex 明确排除
 *   react-native-web 的 createElement 改写）→ Animated.View 内部渲染的 View
 *   不经过 wrapJSX，className 被静默丢弃（desktop-shell ShellSlot 同款实测
 *   先例）——本屏 KPI flex-1 ×3 与曲线段 px-4 py-3 在桌面 web 全数失效。
 *   修复后布局类落在两端都注册的普通 View 上，动画层保持纯 style 契约；
 *   Pressable / BouncyPressable 一律在 children 内部，触摸面永不与动画
 *   style 混挂；
 * - reduceMotion（系统减弱动态）：异步检测，命中即收敛静态终态——boot-screen
 *   同款取舍（检测异步，最坏代价 = 命中前已起播的 300ms 被截停跳终态）。
 */
function Enter({
    delay = 0,
    y = ENTER_OFFSET_Y,
    className,
    children,
}: {
    /** 开播延迟（ms）：区块级时间线用，单元内交错也走它（无嵌套时间线）。 */
    delay?: number;
    /** 初始纵向位移（dp）：0 = 纯淡入（文案类），默认 10（卡片类）。 */
    y?: number;
    className?: string;
    children: ReactNode;
}) {
    const [reduceMotion, setReduceMotion] = useState(false);
    useEffect(() => {
        let cancelled = false;
        AccessibilityInfo.isReduceMotionEnabled()
            .then((enabled) => {
                if (!cancelled) setReduceMotion(enabled);
            })
            .catch(() => {
                // 读不到系统设置 → 按「无减弱」处理（动画照常，可接受的降级）
            });
        let sub: NativeEventSubscription | null = null;
        try {
            sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
        } catch {
            // 事件通道不可用的极端环境：只认首拍检测结果
        }
        return () => {
            cancelled = true;
            sub?.remove();
        };
    }, []);
    const progress = useRef(new Animated.Value(0)).current;
    useEffect(() => {
        if (reduceMotion) {
            progress.setValue(1);
            return;
        }
        const anim = Animated.timing(progress, {
            toValue: 1,
            duration: ENTER_DURATION,
            delay,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        });
        anim.start();
        return () => anim.stop();
    }, [reduceMotion, delay, progress]);
    return (
        <View className={className}>
            <Animated.View
                style={{
                    opacity: progress,
                    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [y, 0] }) }],
                }}
            >
                {children}
            </Animated.View>
        </View>
    );
}

export function MeScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const ready = useArchiveStore((s) => s.ready);
    const trips = useArchiveStore((s) => s.trips);
    const metrics = useArchiveStore((s) => s.metrics);
    const error = useArchiveStore((s) => s.error);
    const loadAll = useArchiveStore((s) => s.loadAll);
    const revision = useArchiveRevision();

    // 指标保鲜（2026-11-20 新增事件/计划 KPI 后必须诚实）：Me 常驻栈内不卸载，
    // revision 型 mutation 前进即重跑 loadAll（事件三态/计划数/行程派生计数不
    // 滞留旧值）；revision = 0 启动基线由上一 effect 独占（library-screen 同款
    // 双 effect 取径）。
    useEffect(() => {
        if (!ready) void loadAll();
    }, [ready, loadAll]);
    useEffect(() => {
        if (revision > 0) void loadAll();
    }, [revision, loadAll]);

    if (!ready) return <LoadingView />;

    const ongoing = trips.filter((t) => t.status === 'ongoing').length;
    // 历史行程数原挂行程行行尾计数，v0.4.6 指令 5 计数退场后无消费方

    return (
        <View className="flex-1 bg-ink-base dark:bg-inkd-base">
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <View className="px-6 pb-1 pt-2">
                    <Text className="text-[24px] font-semibold text-ink-text dark:text-inkd-text">Me</Text>
                    {/* streak 轻动画：纯淡入（y=0），不位移不抢戏（用户口径「可选、不要过度」） */}
                    <Enter delay={80} y={0}>
                        <Text
                            className="mt-1 text-[16px] text-ink-secondary dark:text-inkd-secondary"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {metrics.streak > 0 ? `连续 ${metrics.streak} 天，别断` : '从今天开始连续记录'}
                        </Text>
                    </Enter>
                    {error ? (
                        // 错误横幅卡（v0.4.7 令 3，settings 同源）：tinted 圆角卡承载
                        <View className="mt-2 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                            <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                {error}
                            </Text>
                        </View>
                    ) : null}
                </View>

                {/* 阅读列宽约束（mx-auto + max-w-[560px]）：与其他屏同口径，桌面 web 不拉满全宽 */}
                <ScrollView
                    className="mx-auto w-full max-w-[560px]"
                    contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: insets.bottom + 32 }}
                    keyboardShouldPersistTaps="handled"
                >
                    {/* 指标卡：3 格 KPI 单行 + 30 天曲线并作一张 surface 卡（连续天数
                        已在身份行，KPI 去重后收单行）。2026-11-20 迭代终态：事件三态/
                        计划数/历史行程数**不进指标卡**（8 格三行被否「太密集」、弱化
                        明细行被否「太丑」），改挂「我的内容」对应行尾（iOS 设置行尾
                        值范式——数字跟着入口走，见内容卡注）。**无任何内部分隔线**：
                        KPI 格间靠两侧 px-3 留白相加（24px），曲线段与 KPI 段靠 py-3×2
                        纵向节奏——卡内分区靠留白不靠线（同 event-card / Apple Journal
                        口径）。卡片级 = surface-on-base tone 分层、rounded-card 16、
                        PAPER_CARD 静止卡影（v0.4.7 令 3 对齐 settings 质感，无描边）。
                        卡壳不做整体动画：KPI 格 / 曲线段各自
                        交错进场，卡面作为安静的「底」先立住，内容依次落位。
                        v0.4.7 令 3：卡身挂 PAPER_CARD 静止卡影 + eyebrow 升 secondary
                        （settings 卡片质感同款，token 见 ui/paper-shadow.ts）。 */}
                    <View
                        className="mt-3 rounded-card bg-ink-surface dark:bg-inkd-surface"
                        style={PAPER_CARD_SHADOW}
                    >
                        <View className="flex-row">
                            <Enter className="flex-1" delay={0} y={8}>
                                <MetricCell value={`${metrics.journalDays}`} unit="天" label="写过日记" />
                            </Enter>
                            <Enter className="flex-1" delay={ENTER_STAGGER} y={8}>
                                <MetricCell value={formatCount(metrics.totalWords)} unit="" label="累计字数" />
                            </Enter>
                            <Enter className="flex-1" delay={ENTER_STAGGER * 2} y={8}>
                                <MetricCell value={`${ongoing}/${trips.length}`} unit="" label="进行中行程" />
                            </Enter>
                        </View>
                        <Enter className="px-4 py-3" delay={200} y={8}>
                            <View className="mb-1 flex-row items-center justify-between">
                                <Text className="text-[16px] font-medium text-ink-text dark:text-inkd-text">
                                    最近 30 天写作量
                                </Text>
                                <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                                    字 / 天
                                </Text>
                            </View>
                            {/* animated opt-in（组件默认行为不变，仅本屏开启）：曲线在段
                                容器进场后再淡入一拍（组件内延迟 260ms）——标题先立、
                                曲线后到，两拍节奏替代「一根横线」的段落划分。
                                height=120 显式定高（4dp 网格，96~120 档上沿）：不用
                                aspectRatio/flex/百分比这类 web 宽容器下会计算失控的
                                尺寸策略，LineChart 内部即「显式 height style + onLayout
                                测宽」，两端一致；168 在空数据态显得空旷（desktop 大
                                空白反馈的观感成分之一），120 收紧后 plotH 仍有 84 */}
                            <LineChart points={metrics.curve} animated height={120} />
                        </Enter>
                    </View>

                    {/* 我的内容：一张卡（搜索 / 事件 / 计划 / 行程，卡内零线条——行间
                        靠 py 节奏与 px-4 统一左缘自然过渡，无 hairline）。卡壳不做整体
                        动画：行作为内容单元交错淡入，卡面作为安静的「底」先立住。
                        typedRoutes：'/search'、'/events'、'/plans'、'/trips'、'/settings' 尚未进
                        .expo/types 路由联合（本组不跑 Metro，字面量由 metro 启动时生成）
                        ——`as never` 是最小妥协（never 可赋给任何联合，不产生 any 的
                        误拓宽），类型生成后可直接删除断言。 */}
                    <View className="mt-6">
                        {/* eyebrow 档对齐 settings SectionEyebrow（11 medium secondary，
                            v0.4.7 令 3） */}
                        <Enter delay={240} y={0}>
                            <Text className="mb-3 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                我的内容
                            </Text>
                        </Enter>
                        {/* 四行同一解剖（v0.4.6 指令 5：行尾计数整体退场、计划/行程
                            两行手抄行解剖并入 ContentEntryRow 单实现）：图标 + 名 +
                            chevron，h-12，零线条，行级 active 高亮。入口去向：搜索
                            枢纽 / 事件列表 / 计划堆 /plans / 行程堆 /trips（2026-11-19
                            指令：行程行恒静态不展开列表；日记行早已退场——入口在首页） */}
                        <View className="rounded-card bg-ink-surface dark:bg-inkd-surface" style={PAPER_CARD_SHADOW}>
                            <Enter delay={280}>
                                <ContentEntryRow
                                    icon={<LucideSearch size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    label="搜索"
                                    onPress={() => router.push('/search' as never)}
                                    accessibilityLabel="搜索计划与行程"
                                />
                            </Enter>
                            <Enter delay={280 + ENTER_STAGGER}>
                                <ContentEntryRow
                                    icon={<LucideFlag size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    label="事件"
                                    onPress={() => router.push('/events' as never)}
                                    accessibilityLabel="事件"
                                />
                            </Enter>
                            <Enter delay={280 + ENTER_STAGGER * 2}>
                                <ContentEntryRow
                                    icon={<LucideListTodo size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    label="计划"
                                    onPress={() => router.push('/plans' as never)}
                                    accessibilityLabel="计划"
                                />
                            </Enter>
                            <Enter delay={280 + ENTER_STAGGER * 3}>
                                <ContentEntryRow
                                    icon={<LucideCalendar size={18} strokeWidth={1.9} color={palette.secondary} />}
                                    label="行程"
                                    onPress={() => router.push('/trips' as never)}
                                    accessibilityLabel="行程"
                                />
                            </Enter>
                        </View>
                    </View>

                    {/* 设置：独立区块（2026-11-19 用户指令「设置卡片单独一个 + 大一些」）：
                        与「我的内容」同构的区块节奏（13px 区块题 + 独立卡），卡体加
                        高（py-4 + 两行内衬 = 视觉重量与内容卡一致）。设置页收口外观 /
                        App 锁 / 备份与恢复。Enter 时间线顺延（360 + STAGGER×4）。 */}
                    <View className="mt-6">
                        <Enter delay={280 + ENTER_STAGGER * 4} y={0}>
                            <Text className="mb-3 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                设置
                            </Text>
                        </Enter>
                        <Enter delay={280 + ENTER_STAGGER * 5} y={8}>
                            {/* overflow-hidden 让行高亮底裁进 rounded-card 圆角；py-4
                                加高卡体（用户指令「大一些」，行解剖仍 = 图标 + 题 +
                                chevron 单行） */}
                            <View
                                className="overflow-hidden rounded-card bg-ink-surface dark:bg-inkd-surface"
                                style={PAPER_CARD_SHADOW}
                            >
                                <Pressable
                                    onPress={() => {
                                        haptics.impact();
                                        router.push('/settings' as never);
                                    }}
                                    className="flex-row items-center gap-3 px-4 py-4 active:bg-ink-raised dark:active:bg-inkd-raised"
                                    accessibilityRole="button"
                                    accessibilityLabel="设置"
                                >
                                    <LucideSettings size={18} strokeWidth={1.9} color={palette.secondary} />
                                    <Text className="flex-1 text-[16px] font-medium text-ink-text dark:text-inkd-text">
                                        设置
                                    </Text>
                                    <LucideChevronRight size={16} strokeWidth={1.9} color={palette.faint} />
                                </Pressable>
                            </View>
                        </Enter>
                    </View>
                </ScrollView>
            </View>
        </View>
    );
}

/** KPI 单元（指标卡内的表格单元，不带自己的卡壳；flex-1 由外层 Enter 进场
    动画层承担）：数值 24px tabular（v0.4.6 字阶纪律屏题档——卡内数字就是
    这张卡的屏题）+ 弱化标签 11。单行 3 格，格间分隔 = 两侧 px-3 留白相加
    （24px，无 hairline）；横向 padding 收窄为 px-3（px-4 在 320pt 级窄屏会
    挤到 label 换行），py-3 与卡内曲线段行距一致；label 间距 mt-1 落 4dp 网格。 */
function MetricCell({ value, unit, label }: { value: string; unit: string; label: string }) {
    return (
        <View className="px-3 py-3">
            <Text
                className="text-[24px] font-semibold text-ink-text dark:text-inkd-text"
                style={{ fontVariant: ['tabular-nums'] }}
            >
                {value}
                {unit ? <Text className="text-[12px] font-normal text-ink-muted dark:text-inkd-muted"> {unit}</Text> : null}
            </Text>
            <Text className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted">{label}</Text>
        </View>
    );
}

/**
 * 内容入口行（我的内容四行共用解剖，v0.4.6 指令 5 收口为单实现）：48dp 单行
 * = 图标 + 名（16 档） + chevron，无卡壳（卡面归合并卡整体，见屏头注释）。
 * 原可选的 trailing 行尾计数已整体退场（「进行 0 · 完成 0 · 失败 0」类噪音
 * 与冗余计数——指令 5 点名的容器负担）。按压 = Pressable +
 * active:bg-ink-raised 行级高亮（iOS 设置列表式，合并卡统一按压语言）：
 * Pressable 本体直接挂 active: 类无 css-interop remount 风险（View 挂
 * active: 才会被升级成 Pressable 首帧后 remount）。命中盒 = h-12（48 ≥44，
 * hitSlop 0）；行间无 gap 贴靠，各行独立可按、触摸面无重叠。a11y 属性挂
 * Pressable 本体。
 */
function ContentEntryRow({
    icon,
    label,
    onPress,
    accessibilityLabel,
}: {
    icon: ReactElement;
    label: string;
    onPress: () => void;
    accessibilityLabel: string;
}) {
    const palette = usePalette();
    return (
        <Pressable
            onPress={onPress}
            className="h-12 flex-row items-center gap-3 px-4 active:bg-ink-raised dark:active:bg-inkd-raised"
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
        >
            {icon}
            <Text className="flex-1 text-[16px] font-medium text-ink-text dark:text-inkd-text">{label}</Text>
            <LucideChevronRight size={16} strokeWidth={1.9} color={palette.faint} />
        </Pressable>
    );
}

function formatCount(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`;
    return `${n}`;
}
