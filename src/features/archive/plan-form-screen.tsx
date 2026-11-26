import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
    AccessibilityInfo,
    ActivityIndicator,
    Animated,
    Easing,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
    type NativeEventSubscription,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { haptics } from '@/core/haptics';
import { useArchiveStore } from './store';
import { JOURNAL_TITLE_MAX, PLAN_DESCRIPTION_MAX } from './journal-logic';
import {
    advancePlanStep,
    canAdvancePlanStep,
    isPlanFormLastStep,
    PLAN_DESCRIPTION_PLACEHOLDER,
    PLAN_FORM_STEP_LABELS,
    PLAN_FORM_STEP_TOTAL,
    PLAN_FORM_STEPS,
    PLAN_TITLE_PLACEHOLDER,
    planFormStepAt,
    planTitleValid,
} from './plan-logic';
import { PAPER_CARD_SHADOW, ScreenHeader, usePalette } from './ui';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（该文件不在本组改动权限内），
// 域内深取；ui/index.ts 出口扩充时收口（同 close-button / editor-icons 先例）。
import { FieldInput } from './ui/field-input';
import { PLAN_TITLE_FALLBACK } from './journal-edit-screen';
import { formatDateParts, todayLocal } from './trip-logic';

/**
 * 新建计划页（/plan/new，**交互式分步**，v0.4.5 对齐事件建页向导）：
 *
 * - **分步节奏**（照抄 event-form-screen 的交互解剖，字段集换计划的）：一次
 *   只出一个字段（标题 → 描述），下方两个动作——「继续填写」逐一揭示后续
 *   字段（跳过的字段保持默认空值不处理），「直接创建」随时用已填内容创建
 *   （默认只填名称即可创建）；最后一步的主钮即「创建计划」；
 * - **创建门槛**：标题必填（store.createPlan 的 PLAN_TITLE_REQUIRED_ERROR
 *   校验同源），空标题时两个动作禁用；步骤指示「X / 2」（tabular，与事件
 *   「X / 7」、deck 页码同语言）；步进状态机收口在 plan-logic 纯函数
 *   （node 测试直接覆盖）；
 * - **屏头（v0.5.2 轮 B 统一）**：ScreenHeader 单点收口——屏题「新建计划」
 *   24 semibold / px-6 pb-3 pt-2 / h-11 带 + CloseButton 返回钮，与 trip-form
 *   参考屏同规格；旧内联屏头 + 16 档介绍副行（起名字、补描述、随时续写标记
 *   完成）退场——「计划要做的事」由字段与卡面预览自证，介绍句删除；
 * - **卡面预览（v0.4.6 指令 7「稀疏即罪」）**：页底一块与首页/计划堆同语言
 *   的计划卡静态预览，随输入实时更新——向导下半死白收进真实反馈内容，且
 *   「建完会进堆」的因果一眼可见；
 * - **换步滑动过渡**：StepPane（key={step} 换步重挂）挂载即播滑入——前进
 *   自右、200ms ease-out + 淡入；动画层与布局层分离（Animated.View 只挂内联
 *   动画 style，className 恒在外层普通 View——css-interop web 端静默丢弃
 *   Animated className 的仓库铁律坑）；首步静态进场；reduce-motion 命中即
 *   静态终态。事件屏同款实现（词表不同无法共用，抽取公共需动事件屏文件，
 *   不在本组权限——两域各持一份并在注释互指）；
 * - 提交契约：createPlan 失败返回 null（文案经 store.error 通道在按钮上方
 *   展示、可直接重试）；成功 haptics.success + router.**replace** 进
 *   /plan/[id] 编辑器（栈里不留已无意义的空表单，事件同款）；submittingRef
 *   双击防重入（视觉禁用是第一道，ref 是闸门），finally 复位防「store 方法
 *   意外 reject」把按钮永久禁用（trip-form 同款防御）。
 */

/** 换步过渡时长（ms）：事件向导同档（180~220 取中）——比注意力阈值短、够读完方向感。 */
const STEP_TRANSITION_MS = 200;

/** 换步滑入的水平位移（dp）：事件向导同款 48dp，只给「来自右/左」方向感。 */
const STEP_SLIDE_OFFSET_DP = 48;

/** 换步方向（滑入侧的语义名）：forward = 新字段自右滑入；back = 自左。 */
type StepDirection = 'forward' | 'back';

/**
 * 步进 pane（换步滑动过渡的动画壳）：与 event-form-screen 的 StepPane 同实现
 * （字段词表与步骤数不同，动画解剖相同；公共抽取受文件所有权限制留在各自域内，
 * 修改其一须同步检视另一处——两文件头注互指）。
 *
 * - 动画层与布局层分离（铁律同上）；触摸面（FieldInput）在 children 内部。
 * - animate=false（首步挂载）静态终态：屏幕进场无换步语义，不播。
 * - reduceMotion（系统减弱动态）：命中即静态终态跳过动画（boot-screen /
 *   me-screen Enter 同款口径；检测异步，最坏代价 = 命中前已起播的 200ms
 *   被截停跳终态）。
 */
function StepPane({
    direction,
    animate,
    children,
}: {
    direction: StepDirection;
    animate: boolean;
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
        if (!animate || reduceMotion) {
            progress.setValue(1);
            return;
        }
        const anim = Animated.timing(progress, {
            toValue: 1,
            duration: STEP_TRANSITION_MS,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
        });
        anim.start();
        return () => anim.stop();
    }, [animate, reduceMotion, progress]);
    return (
        <Animated.View
            style={{
                opacity: progress,
                transform: [
                    {
                        translateX: progress.interpolate({
                            inputRange: [0, 1],
                            outputRange: [direction === 'forward' ? STEP_SLIDE_OFFSET_DP : -STEP_SLIDE_OFFSET_DP, 0],
                        }),
                    },
                ],
            }}
        >
            {children}
        </Animated.View>
    );
}

export function PlanFormScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const createPlan = useArchiveStore((s) => s.createPlan);
    const storeError = useArchiveStore((s) => s.error);

    // ─── 表单字段 + 分步（步进判定一律走 plan-logic 纯函数）───────────────────
    const [step, setStep] = useState(0);
    // 换步方向（滑入侧）：与 step 同批 setState；当前词表只有前进动作，
    // back 侧为返回路径预留（方向判定在换步动作处显式记录，不在渲染期推断）
    const [stepDirection, setStepDirection] = useState<StepDirection>('forward');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);

    const titleValid = planTitleValid(title);
    const isLastStep = isPlanFormLastStep(step);
    const stepKey = planFormStepAt(step);

    const submit = async () => {
        // 标题未填不得创建（与 store 校验同源；PrimaryButton 的 disabled 是
        // 视觉层，submittingRef 是闸门层，双击/在途防重入）
        if (!titleValid || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        try {
            // 键盘先收（replace 转场不留键盘，事件同款）
            Keyboard.dismiss();
            const created = await createPlan({ title, description });
            if (created) {
                haptics.success();
                // 成功：replace 进编辑器（不留创建页在栈底）。typedRoutes 动态
                // 路径类型未生成 → as never 最小妥协（仓库既有口径，事件屏同款）
                router.replace(`/plan/${created.id}` as never);
            }
            // created = null：校验/落库失败，store.error 已落文案（横幅可见）
        } catch (caught) {
            // 防御：createPlan 契约不 throw（失败走 null + store.error），这里只兜
            // 环境级意外，不让异常变 unhandled rejection（trip-form 同款注释口径）
            useArchiveStore.setState({
                error: `计划创建失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    const goNext = () => {
        // 标题未填不得前进（创建门槛同源，事件 goNext 同款）
        if (!canAdvancePlanStep(step, titleValid)) return;
        haptics.selection();
        setStepDirection('forward');
        setStep(advancePlanStep);
    };

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            {/* 屏头固定带（v0.5.2 轮 B：内联屏头退役，统一走 ScreenHeader——
                24 semibold 屏题 / px-6 pb-3 pt-2 / h-11 带，与 trip-form 参考屏
                同规格）。旧 16 档介绍副行已删（v0.5.2 令 2：字段自说明，
                删后任务照常完成） */}
            <View style={{ paddingTop: insets.top }}>
                {/* 步骤指示升屏头右位（X / 2，tabular 12）：与事件向导同语言——
                    进度与屏题同带，向导页屏头即状态栏 */}
                <ScreenHeader
                    title="新建计划"
                    right={
                        <Text
                            className="ml-2 text-[12px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`${step + 1} / ${PLAN_FORM_STEP_TOTAL}`}
                        </Text>
                    }
                />
            </View>
            <ScrollView
                className="flex-1"
                contentContainerStyle={{
                    paddingHorizontal: 24,
                    paddingBottom: insets.bottom + 32,
                    alignSelf: 'center',
                    width: '100%',
                    maxWidth: 560,
                }}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
            >
                {/* store.error 通道（标题必填「给计划起个名字」/落库失败）：
                    顶部横幅位（事件建页同槽位口径），按钮不禁用可直接重试；
                    v0.4.7 令 3——settings 同源 tinted 横幅卡 */}
                {storeError ? (
                    <View className="mb-3 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                        <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                            {storeError}
                        </Text>
                    </View>
                ) : null}

                {/* ── 当前步骤的字段（一次只出一个）：StepPane 以 key={step}
                    换步重挂 → 新字段按方向滑入（前进右，200ms ease-out + 淡入；
                    animate=false 首步静态进场）。className 全部在 pane children
                    的普通 View 上，Animated.View 只挂内联动画 style（web 铁律
                    坑，事件屏同款注）── */}
                <StepPane key={step} direction={stepDirection} animate={step > 0}>
                    {/* 表单块（v0.4.7 令 3）：字段收进 settings 同源纸卡
                        （rounded-card surface + PAPER_CARD 卡影），输入体走
                        raised 档——纸卡上的下凹井，tone 分层与卡面拉开一档 */}
                    <View
                        className="rounded-card bg-ink-surface px-5 pb-5 pt-4 dark:bg-inkd-surface"
                        style={PAPER_CARD_SHADOW}
                    >
                        {/* 字段题 = 正文声部 16（v0.4.6 字阶纪律：一步一题，
                            题不是 eyebrow 不该用弱档小字） */}
                        <Text className="mb-2 text-[16px] font-medium text-ink-text dark:text-inkd-text">
                            {PLAN_FORM_STEP_LABELS[stepKey]}
                        </Text>
                        {stepKey === PLAN_FORM_STEPS[0] ? (
                            // 标题：单行 h-14（56dp 档），必填门槛见 titleValid
                            <FieldInput
                                value={title}
                                onChangeText={setTitle}
                                placeholder={PLAN_TITLE_PLACEHOLDER}
                                maxLength={JOURNAL_TITLE_MAX}
                                autoFocus
                                tone="raised"
                                containerClassName="h-14"
                                accessibilityLabel="计划标题"
                            />
                        ) : (
                            // 描述：多行起手高度 + 顶距同事件描述步口径
                            // （minHeight 120 / paddingTop 16，调用侧 style 位于
                            // 合并数组末位，覆盖 INPUT_TRANSPARENT_STYLE 的
                            // paddingVertical: 0）
                            <FieldInput
                                multiline
                                value={description}
                                onChangeText={setDescription}
                                placeholder={PLAN_DESCRIPTION_PLACEHOLDER}
                                maxLength={PLAN_DESCRIPTION_MAX}
                                autoFocus
                                tone="raised"
                                style={{ minHeight: 120, paddingTop: 16 }}
                                accessibilityLabel="计划描述"
                            />
                        )}
                    </View>
                </StepPane>

                {/* ── 动作行：直接创建（次级）+ 继续填写/创建计划（主钮）等分
                    （事件建页同款布局语言：h-12 flex-1 gap-3）——标题未填双禁用；
                    直接创建随时可用已填内容创建（「默认只要输入计划名称即可创建」
                    用户口径沿事件）；最后一步主钮即创建 ── */}
                <View className="mt-8 flex-row gap-3">
                    <Pressable
                        onPress={() => void submit()}
                        disabled={!titleValid || submitting}
                        className={`h-12 flex-1 items-center justify-center rounded-control bg-ink-surface active:bg-ink-raised dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                            !titleValid || submitting ? 'opacity-40' : ''
                        }`}
                        accessibilityRole="button"
                        accessibilityLabel="直接创建"
                    >
                        <Text className="text-[16px] font-medium text-ink-secondary dark:text-inkd-secondary">
                            直接创建
                        </Text>
                    </Pressable>
                    <Pressable
                        onPress={() => (isLastStep ? void submit() : goNext())}
                        disabled={!titleValid || submitting}
                        className="h-12 flex-1 items-center justify-center rounded-control active:opacity-90"
                        style={{ backgroundColor: palette.primaryBtn }}
                        accessibilityRole="button"
                        accessibilityLabel={isLastStep ? '创建计划' : '继续填写'}
                    >
                        {submitting ? (
                            <ActivityIndicator size="small" color={palette.onPrimaryBtn} />
                        ) : (
                            <Text
                                className="text-[16px] font-semibold"
                                style={{ color: palette.onPrimaryBtn }}
                            >
                                {isLastStep ? '创建计划' : '继续填写'}
                            </Text>
                        )}
                    </Pressable>
                </View>

                {/* 卡面预览（v0.4.6 指令 7「稀疏即罪」）：页底死白收进一块真实
                    反馈——与首页 / 计划堆同语言的静态计划卡（eyebrow = 类型 +
                    今天日期、题 16 semibold、引导行 16、右下状态词），随输入
                    实时更新。非交互装饰件：pointerEvents 关闭，页码位留给
                    文案本身（不做假卡页码）。 */}
                <View className="mt-12" pointerEvents="none">
                    {/* 预览 eyebrow 对齐 settings SectionEyebrow（11 medium secondary）；
                        卡身补 PAPER_CARD 静止卡影（v0.4.7 令 3，settings 同源） */}
                    <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                        卡片预览
                    </Text>
                    <View
                        className="rounded-card bg-ink-surface px-6 py-5 dark:bg-inkd-surface"
                        style={PAPER_CARD_SHADOW}
                    >
                        <Text
                            className="text-[11px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {'计划 · '}
                            {formatDateParts(todayLocal()).monthDay}
                        </Text>
                        <Text
                            numberOfLines={1}
                            className="mt-1 text-[16px] font-semibold text-ink-text dark:text-inkd-text"
                        >
                            {title.trim() || PLAN_TITLE_FALLBACK}
                        </Text>
                        {/* 描述预览行：空描述不渲染（v0.5.2 令 2——「描述可以
                            留空…」指引句退场，预览只镜像真实输入） */}
                        {description.trim() ? (
                            <Text
                                numberOfLines={2}
                                className="mt-2.5 text-[16px] leading-6 text-ink-text dark:text-inkd-text"
                            >
                                {description.trim()}
                            </Text>
                        ) : null}
                        <Text className="mt-4 text-right text-[12px] font-medium text-ink-accent dark:text-inkd-accent">
                            进行中
                        </Text>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
