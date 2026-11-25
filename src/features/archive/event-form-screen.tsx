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
import { LucideMapPin } from '@/core/icons';
import { haptics } from '@/core/haptics';
import { location } from '@/core/location';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（同 trip-detail 深取先例，
// barrel 出口扩充时收口）。
import { FieldInput } from './ui/field-input';
import {
    EVENT_DESCRIPTION_MAX,
    EVENT_DESCRIPTION_PLACEHOLDER,
    EVENT_EMAIL_MAX,
    EVENT_EMAIL_PLACEHOLDER,
    EVENT_HANDLED_BY_MAX,
    EVENT_HANDLED_BY_PLACEHOLDER,
    EVENT_PHONE_MAX,
    EVENT_PHONE_PLACEHOLDER,
    EVENT_SUBJECT_PLACEHOLDER,
    EVENT_SUBJECT_VALUE_MAX,
    EVENT_TITLE_MAX,
    EVENT_TITLE_PLACEHOLDER,
    normalizeEventSubject,
} from './event-logic';
import { useArchiveStore } from './store';
import { PAPER_CARD_SHADOW, ScreenHeader, usePalette } from './ui';

/**
 * 新建事件页（/events/new，**交互式分步**，2026-11-19 用户指令重构）：
 *
 * - **分步节奏**：一次只出一个字段（标题 → 位置 → 处理人 → 对象 → 手机号 →
 *   邮箱 → 描述，顺序沿用原词表），下方两个动作——「下一步」逐一揭示后续
 *   字段（跳过的字段保持默认空值不处理），「直接创建」随时用已填内容创建
 *   （默认只填名称即可创建）；最后一步的主钮即创建；
 * - **创建门槛**：标题必填（store 校验同源），空标题时两个动作禁用；步骤指示
 *   「X / 7」升屏头右位（tabular 12，v0.4.6），配 3px 七格进度轨双编码；
 * - **留白即节奏（v0.4.6 方向令 §3）**：单字段区垂直居中（contentContainer
 *   flexGrow + flex-1 justify-center），动作行下方「已填内容」摘要卡（≥2 项
 *   才出现，只列有值字段）把死白转成实时回执；
 * - GPS（不可手输）：进页自动定位（权限预检 → 服务检查 → 8s 超时兜底），
 *   状态行只在「位置」步骤展示——失败/拒绝降级 muted「未定位」，创建 gps
 *   置 null 不阻塞；
 * - 提交 → store.createEvent（校验失败走 error 通道，横幅可见）→ 成功
 *   **replace** 到 /events/[id]（返回键回列表不留死表单）；
 * - **换步滑动过渡（2026-11-20）**：步进 pane（StepPane，key={step} 换步重挂）
 *   挂载即播滑入——前进自右 / 后退自左（方向在换步动作处记录），200ms
 *   ease-out + 淡入；动画层与布局层分离（Animated.View 只挂内联动画 style，
 *   className 恒在外层普通 View——css-interop web 端静默丢弃 Animated
 *   className 的仓库铁律坑）；首步静态进场（无换步语义，不播）；
 * - 布局：字段块（eyebrow 11 题 + FieldInput，标题档 20 / 其余单行 16）+
 *   动作行（直接创建 = surface 次级，下一步/创建 = 近黑主钮，flex-1 等分
 *   h-12 文字 16）；键盘避让 + keyboardShouldPersistTaps；与计划/行程向导
 *   同一字阶（方向令 §2 全局收口）。
 */

/** 定位超时上限（ms）：单次 getCurrentPosition 的等待上限，超时按失败降级。 */
const LOCATE_TIMEOUT_MS = 8000;

/** 分步总数（步骤指示分母）。 */
const STEP_TOTAL = 7;

/** 换步过渡时长（ms）：180~220 档内取中——比注意力阈值短、够读完方向感。 */
const STEP_TRANSITION_MS = 200;

/** 换步滑入的水平位移（dp）：位移 + 淡入双轴同动（me 页 Enter 同语言），
 *  48dp 足以下「来自右/左」的方向感，不做全屏横扫（大位移在键盘在场时
 *  显得剧）。 */
const STEP_SLIDE_OFFSET_DP = 48;

/** 换步方向（滑入侧的语义名）：forward = 新字段自右滑入；back = 自左。 */
type StepDirection = 'forward' | 'back';

/**
 * 步进 pane（换步滑动过渡的动画壳）：key={step} 换步重挂 → 挂载即播滑入
 * （Animated.timing native driver，仅 opacity + translateX——仓库铁律禁
 * reanimated 驱动触摸视图样式，RN Animated 是最保守通道）。
 *
 * - **动画层与布局层分离**：Animated.View 只挂内联动画 style，className
 *   恒落在外层普通 View/children 内的普通 View 上——css-interop 对
 *   Animated 组件的 className 在 web 静默丢弃（me-screen Enter 同款实测
 *   先例，仓库铁律注释）；触摸面（FieldInput）在其 children 内部。
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

export function EventFormScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const error = useArchiveStore((s) => s.error);

    // ─── 表单字段 + 分步 ─────────────────────────────────────────────────────
    const [step, setStep] = useState(0);
    // 换步方向（StepPane 滑入侧）：与 step 同批 setState（React 自动合并渲染
    // 一帧），前进自右 / 后退自左；当前词表只有前进动作，back 侧为返回路径
    // 预留（方向判定在换步动作处显式记录，不在渲染期推断）
    const [stepDirection, setStepDirection] = useState<StepDirection>('forward');
    const [title, setTitle] = useState('');
    const [handledBy, setHandledBy] = useState('');
    const [subjectValue, setSubjectValue] = useState('');
    const [phone, setPhone] = useState('');
    const [email, setEmail] = useState('');
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false);

    // ─── GPS 自动定位（不可手输；失败/拒绝 → null + muted 行）────────────────
    const [gps, setGps] = useState<{ lat: number; lng: number; accuracy?: number } | null>(null);
    const [gpsStatus, setGpsStatus] = useState<'locating' | 'ok' | 'failed'>('locating');
    useEffect(() => {
        let cancelled = false;
        // 定时器句柄（effect 内变量）：竞速收口 finally 清理 + 卸载兜底双收口
        let locateTimer: ReturnType<typeof setTimeout> | null = null;
        const run = async () => {
            try {
                // 权限：已授权静默通过；未授权弹系统窗，拒绝即失败降级
                const permission = await location.getPermissionAsync();
                let granted = permission.granted;
                if (!granted) {
                    const requested = await location.requestPermissionAsync();
                    granted = requested.granted;
                }
                if (!granted) throw new Error('定位权限未授权');
                // 服务：权限获准但系统定位关闭时同样取不到位置（显式检查给
                // 准确的降级文案口径——本行只展示「未定位」，不再细分原因）
                const services = await location.hasServicesEnabledAsync();
                if (!services) throw new Error('定位服务未开启');
                // 超时兜底：定位挂起不阻塞表单；竞速败者（定时器）在收口时清除
                const pos = await Promise.race([
                    location.getCurrentPositionAsync(),
                    new Promise<never>((_, reject) => {
                        locateTimer = setTimeout(
                            () => reject(new Error('定位超时')),
                            LOCATE_TIMEOUT_MS,
                        );
                    }),
                ]);
                if (cancelled) return;
                setGps({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    ...(pos.coords.accuracy != null
                        ? { accuracy: pos.coords.accuracy }
                        : {}),
                });
                setGpsStatus('ok');
            } catch {
                // 失败降级（拒绝/服务关闭/超时/异常同口径）：gps 置 null，
                // 行文案转 muted「未定位」——创建不被阻塞
                if (cancelled) return;
                setGps(null);
                setGpsStatus('failed');
            } finally {
                if (locateTimer !== null) {
                    clearTimeout(locateTimer);
                    locateTimer = null;
                }
            }
        };
        void run();
        return () => {
            cancelled = true;
            if (locateTimer !== null) clearTimeout(locateTimer);
        };
    }, []);

    const titleValid = title.trim().length > 0;
    const isLastStep = step === STEP_TOTAL - 1;

    const submit = async () => {
        if (!titleValid || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        try {
            // 键盘先收（replace 转场不留键盘）
            Keyboard.dismiss();
            // 对象原子对在提交前归一（与 store 落库同源口径；「无」→ 双双置 null）
            const subject = normalizeEventSubject(
                subjectValue.trim() ? 'custom' : null,
                subjectValue,
            );
            const row = await useArchiveStore.getState().createEvent({
                title,
                gps,
                handledBy,
                subjectKind: subject.kind ?? undefined,
                subjectValue: subject.value ?? undefined,
                // 手机号/邮箱（v7）：原样上交（可选、无格式校验），trim 与邮箱
                // 值内空白剥除由 store 归一化统一收口，表单不做第二套清洗
                phone,
                email,
                description,
            });
            if (row) {
                haptics.success();
                // 成功：replace 进详情编辑页（不留创建页在栈底）。typedRoutes
                // 动态路径类型未生成 → as never 最小妥协（同 me 页先例）
                router.replace(`/events/${row.id}` as never);
            }
            // row = null：校验/落库失败，store.error 已落文案（横幅可见）
        } catch (caught) {
            // 防御：store 正常路径不 throw，环境异常兜可见
            useArchiveStore.setState({
                error: `事件创建失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    };

    const goNext = () => {
        // 标题未填不得前进（创建门槛同源）
        if (!titleValid) return;
        haptics.selection();
        setStepDirection('forward');
        setStep((prev) => Math.min(prev + 1, STEP_TOTAL - 1));
    };

    // 已填摘要（v0.4.6「稀疏即罪」落点）：向导一次只出一格，其余留白由这帧
    // 「已经填了什么」实时回执填住——只列有值字段（方向令 §2 最小必要 meta，
    // 「未填/未定位」不进摘要）；≥2 项才出卡（只一个标题时摘要与输入框重复）
    const filledSummary: Array<{ label: string; value: string }> = [];
    if (title.trim()) filledSummary.push({ label: '标题', value: title.trim() });
    if (gps) filledSummary.push({ label: '位置', value: `${gps.lat}, ${gps.lng}` });
    if (handledBy.trim()) filledSummary.push({ label: '处理人', value: handledBy.trim() });
    if (subjectValue.trim()) filledSummary.push({ label: '对象', value: subjectValue.trim() });
    if (phone.trim()) filledSummary.push({ label: '手机号', value: phone.trim() });
    if (email.trim()) filledSummary.push({ label: '邮箱', value: email.trim() });
    if (description.trim()) filledSummary.push({ label: '描述', value: description.trim() });

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                {/* 步骤指示升屏头右位（X / 7，tabular 12）：字段区上移一格，
                    进度与屏题同带——向导页屏头即状态栏 */}
                <ScreenHeader
                    title="新建事件"
                    right={
                        <Text
                            className="ml-2 text-[12px] text-ink-muted dark:text-inkd-muted"
                            style={{ fontVariant: ['tabular-nums'] }}
                        >
                            {`${step + 1} / ${STEP_TOTAL}`}
                        </Text>
                    }
                />
                <ScrollView
                    className="flex-1"
                    contentContainerStyle={{
                        paddingHorizontal: 24,
                        paddingBottom: insets.bottom + 32,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 560,
                        // flexGrow：内容不满一屏时撑满——字段区 flex-1 才有
                        // 「垂直居中」可依（Apple 单字段向导节奏，死白变成设计过的呼吸）
                        flexGrow: 1,
                    }}
                    keyboardShouldPersistTaps="handled"
                    keyboardDismissMode="on-drag"
                >
                    {error ? (
                        // store.error 通道（校验失败如「给事件起个名字」/落库失败）：
                        // 与设置页同款 tinted 横幅
                        <View className="mb-4 rounded-control bg-ink-negative-bg px-4 py-3 dark:bg-inkd-negative-bg">
                            <Text className="text-[13px] leading-5 text-ink-negative dark:text-inkd-negative">
                                {error}
                            </Text>
                        </View>
                    ) : null}

                    {/* 分步进度轨（7 格，已过档位墨实、未过浅淡）：数字指示的
                        图形化双编码，tabular「X / 7」仍在屏头右位 */}
                    <View className="mb-6 flex-row gap-1" pointerEvents="none">
                        {Array.from({ length: STEP_TOTAL }).map((_, index) => (
                            <View
                                key={index}
                                className={`h-[3px] flex-1 rounded-full ${
                                    index <= step
                                        ? 'bg-ink-text dark:bg-inkd-text'
                                        : 'bg-ink-border dark:bg-inkd-border'
                                }`}
                            />
                        ))}
                    </View>

                    {/* 字段区垂直居中（flex-1 justify-center）：单字段向导的
                        空白变成呼吸而非残留 */}
                    <View className="flex-1 justify-center">

                    {/* ── 当前步骤的字段（一次只出一个）：StepPane 以 key={step}
                        换步重挂 → 新字段按方向滑入（前进右/后退左，200ms
                        ease-out + 淡入；animate=false 首步静态进场）。
                        className 全部在 pane children 的普通 View 上，
                        Animated.View 只挂内联动画 style（web 铁律坑） ── */}
                    <StepPane key={step} direction={stepDirection} animate={step > 0}>
                        {step === 0 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    标题
                                </Text>
                                <FieldInput
                                    value={title}
                                    onChangeText={setTitle}
                                    placeholder={EVENT_TITLE_PLACEHOLDER}
                                    maxLength={EVENT_TITLE_MAX}
                                    autoFocus
                                    containerClassName="h-14"
                                    style={{ fontSize: 20, lineHeight: 28 }}
                                    accessibilityLabel="事件标题"
                                />
                            </View>
                        ) : null}

                        {step === 1 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    位置
                                </Text>
                                {/* GPS（自动定位，不可手输）：行容器与 FieldInput 同视觉
                                    语言；定位中 spinner / 已定位（完整 GPS 信息）/ 未定位 */}
                                <View className="min-h-11 flex-row items-center gap-2 rounded-control bg-ink-surface px-3.5 py-2 dark:bg-inkd-surface">
                                    {gpsStatus === 'locating' ? (
                                        <>
                                            <ActivityIndicator size="small" color={palette.spinner} />
                                            <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                                定位中…
                                            </Text>
                                        </>
                                    ) : gpsStatus === 'ok' && gps ? (
                                        <>
                                            <LucideMapPin size={14} strokeWidth={1.9} color={palette.accent} />
                                            <View className="min-w-0 flex-1">
                                                <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                                    {`已定位${
                                                        gps.accuracy != null
                                                            ? ` · ±${Math.round(gps.accuracy)}m`
                                                            : ''
                                                    }`}
                                                </Text>
                                                <Text
                                                    numberOfLines={1}
                                                    className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted"
                                                    style={{ fontVariant: ['tabular-nums'] }}
                                                >
                                                    {`${gps.lat}, ${gps.lng}`}
                                                </Text>
                                            </View>
                                        </>
                                    ) : (
                                        <>
                                            <LucideMapPin size={14} strokeWidth={1.9} color={palette.muted} />
                                            <Text className="flex-1 text-[13px] text-ink-muted dark:text-inkd-muted">
                                                未定位（未授权或服务不可用，不影响创建）
                                            </Text>
                                        </>
                                    )}
                                </View>
                            </View>
                        ) : null}

                        {step === 2 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    处理人
                                </Text>
                                <FieldInput
                                    value={handledBy}
                                    onChangeText={setHandledBy}
                                    placeholder={EVENT_HANDLED_BY_PLACEHOLDER}
                                    maxLength={EVENT_HANDLED_BY_MAX}
                                    autoFocus
                                    containerClassName="h-14"
                                    style={{ fontSize: 16, lineHeight: 24 }}
                                    accessibilityLabel="处理人"
                                />
                            </View>
                        ) : null}

                        {step === 3 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    对象
                                </Text>
                                <FieldInput
                                    value={subjectValue}
                                    onChangeText={setSubjectValue}
                                    placeholder={EVENT_SUBJECT_PLACEHOLDER}
                                    maxLength={EVENT_SUBJECT_VALUE_MAX}
                                    autoFocus
                                    containerClassName="h-14"
                                    style={{ fontSize: 16, lineHeight: 24 }}
                                    accessibilityLabel="对象"
                                />
                            </View>
                        ) : null}

                        {step === 4 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    手机号
                                </Text>
                                <FieldInput
                                    value={phone}
                                    onChangeText={setPhone}
                                    placeholder={EVENT_PHONE_PLACEHOLDER}
                                    maxLength={EVENT_PHONE_MAX}
                                    keyboardType="phone-pad"
                                    inputMode="tel"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    autoFocus
                                    containerClassName="h-14"
                                    style={{ fontSize: 16, lineHeight: 24 }}
                                    accessibilityLabel="手机号"
                                />
                            </View>
                        ) : null}

                        {step === 5 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    邮箱
                                </Text>
                                <FieldInput
                                    value={email}
                                    onChangeText={setEmail}
                                    placeholder={EVENT_EMAIL_PLACEHOLDER}
                                    maxLength={EVENT_EMAIL_MAX}
                                    keyboardType="email-address"
                                    inputMode="email"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    autoFocus
                                    containerClassName="h-14"
                                    style={{ fontSize: 16, lineHeight: 24 }}
                                    accessibilityLabel="邮箱"
                                />
                            </View>
                        ) : null}

                        {step === 6 ? (
                            <View>
                                <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                    描述
                                </Text>
                                <FieldInput
                                    value={description}
                                    onChangeText={setDescription}
                                    placeholder={EVENT_DESCRIPTION_PLACEHOLDER}
                                    multiline
                                    maxLength={EVENT_DESCRIPTION_MAX}
                                    autoFocus
                                    style={{ minHeight: 120, paddingTop: 16, fontSize: 16, lineHeight: 26 }}
                                    accessibilityLabel="事件描述"
                                />
                            </View>
                        ) : null}
                    </StepPane>
                    </View>

                    {/* ── 动作行：直接创建（次级）+ 下一步/创建（主钮）等分 ──
                        标题未填双禁用；直接创建随时可用已填内容创建（用户口径
                        「默认只要输入事件名称即可创建」）；最后一步主钮即创建 */}
                    <View className="mt-6 flex-row gap-3">
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
                            accessibilityLabel={isLastStep ? '创建事件' : '继续填写'}
                        >
                            {submitting ? (
                                <ActivityIndicator size="small" color={palette.onPrimaryBtn} />
                            ) : (
                                <Text
                                    className="text-[16px] font-semibold"
                                    style={{ color: palette.onPrimaryBtn }}
                                >
                                    {isLastStep ? '创建事件' : '继续填写'}
                                </Text>
                            )}
                        </Pressable>
                    </View>

                    {/* 已填摘要卡（≥2 项才渲染，见 filledSummary 注）：纸卡 +
                        轻投影，label eyebrow 11 / value 14——「直接创建」前
                        最后一眼确认，也是底部留白的设计化收口 */}
                    {filledSummary.length >= 2 ? (
                        <View className="mt-8">
                            <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                已填内容
                            </Text>
                            {/* v0.4.9 令5：摘要卡补 PAPER_CARD 静止卡影——本页
                                最后一块纸面卡，向 settings 卡片质感对齐 */}
                            <View
                                className="gap-3 rounded-card bg-ink-surface px-4 py-4 dark:bg-inkd-surface"
                                style={PAPER_CARD_SHADOW}
                            >
                                {filledSummary.map((item) => (
                                    <View key={item.label} className="flex-row items-baseline gap-4">
                                        <Text className="w-12 shrink-0 text-[11px] text-ink-muted dark:text-inkd-muted">
                                            {item.label}
                                        </Text>
                                        <Text
                                            numberOfLines={item.label === '描述' ? 2 : 1}
                                            className="min-w-0 flex-1 text-[14px] text-ink-text dark:text-inkd-text"
                                        >
                                            {item.value}
                                        </Text>
                                    </View>
                                ))}
                            </View>
                        </View>
                    ) : null}
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
}
