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
 * 新建事件页（/events/new，**分步揭示 + 容器井**，v0.5.1 令 4 重构）：
 *
 * - **容器井（v0.5.1 设计契约「纸 × 墨 2.1」）**：字段不再裸排在大留白上，
 *   全部进一张**井**——surface 底 + rounded-card(16) + PAPER_CARD 静止卡影，
 *   字段 label（eyebrow 11）在井内字段顶部，输入走 **FieldInput canvas 档**
 *   （井即容器，输入体透明：canvas + h-14 justify-center 保住 56dp 命中带与
 *   既有输入体感，标题 20/28、描述 minHeight 120 不变）；同井随揭示推进
 *   堆叠多字段（gap-4 内距），井是「实时表单本体」——已填内容尽收眼底；
 * - **分步节奏**：字段按 标题 → 位置 → 处理人 → 对象 → 手机号 → 邮箱 →
 *   描述（词表沿用）逐一揭示，主钮「继续填写」推进（跳过的字段保持默认空值
 *   不处理），「直接创建」随时用已填内容创建（默认只填名称即可创建）；
 *   最后一步的主钮即创建；
 * - **动作行出容器（用户原话「直接创建 继续填写 可以在底部不需要被包裹」）**：
 *   两钮钉在 ScrollView **之外**的屏底行（px-6、safe-area 收口），不再被任何
 *   井/卡包裹；键盘弹起时随既有 KeyboardAvoidingView（iOS padding）通道抬升，
 *   不新造避让层；
 * - **创建门槛**：标题必填（store 校验同源），空标题时两个动作禁用；步骤指示
 *   「X / 7」升屏头右位（tabular 12），配 3px 七格进度轨双编码；
 * - **疏密（v0.5.1 复核）**：旧的「单字段垂直居中 + 已填摘要卡」节奏随容器井
 *   退役——井顶置贴进度轨，摘要卡删除（井本身就是已填内容的实时回执，同屏
 *   双份即拥挤）；区块间距收在 mt/mb-4 基线（屏 px-6、井内 p-4）；
 * - GPS（不可手输）：进页自动定位（权限预检 → 服务检查 → 8s 超时兜底），
 *   状态行是井内的 raised 档行（surface 井上的 tone 差）——失败/拒绝降级
 *   muted「未定位」，创建 gps 置 null 不阻塞；
 * - 提交 → store.createEvent（校验失败走 error 通道，横幅可见）→ 成功
 *   **replace** 到 /events/[id]（返回键回列表不留死表单）；
 * - **换步滑动过渡**：每个已揭示字段各挂一个 StepPane（按字段位稳定 key——
 *   推进时旧 pane 不重挂，输入焦点/IME 状态不丢），仅最新字段 animate 播
 *   滑入：前进自右 / 后退自左（方向在换步动作处记录），200ms ease-out +
 *   淡入；动画层与布局层分离（Animated.View 只挂内联动画 style，className
 *   恒在外层普通 View——css-interop web 端静默丢弃 Animated className 的
 *   仓库铁律坑）；首步静态进场（无换步语义，不播）；
 * - 布局：动作行（直接创建 = surface 次级 ghost，继续填写/创建 = 近黑主钮，
 *   flex-1 等分 h-12 文字 16）；键盘避让 + keyboardShouldPersistTaps；与
 *   计划/行程向导同一字阶（方向令 §2 全局收口）。
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
 * 步进 pane（字段滑入的动画壳；v0.5.1 容器井改造后按字段位一挂）：新字段
 * 挂载即播滑入，已揭示字段的 pane 恒静态终态（不重挂 → 输入焦点与 IME
 * 状态随推进存活）（Animated.timing native driver，仅 opacity + translateX
 * ——仓库铁律禁 reanimated 驱动触摸视图样式，RN Animated 是最保守通道）。
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

    // 井内字段块（eyebrow 11 题 + canvas 输入/状态行）：按字段位渲染，已揭示
    // 的字段全部留在井里堆叠推进——井即「实时表单本体」，v0.4.6 的「已填内容」
    // 摘要卡随之退役（同屏双份同值即拥挤，疏密复核令「拥挤处要松」的反向操作）
    const renderWellField = (index: number): ReactNode => {
        const labelLine = (label: string) => (
            <Text className="mb-2 text-[11px] font-medium text-ink-secondary dark:text-inkd-secondary">
                {label}
            </Text>
        );
        switch (index) {
            case 0:
                return (
                    <View>
                        {labelLine('标题')}
                        <FieldInput
                            tone="canvas"
                            value={title}
                            onChangeText={setTitle}
                            placeholder={EVENT_TITLE_PLACEHOLDER}
                            maxLength={EVENT_TITLE_MAX}
                            autoFocus
                            containerClassName="h-14 justify-center"
                            style={{ fontSize: 20, lineHeight: 28 }}
                            accessibilityLabel="事件标题"
                        />
                    </View>
                );
            case 1:
                return (
                    <View>
                        {labelLine('位置')}
                        {/* GPS（自动定位，不可手输）：井内 raised 档状态行
                            （tone 差离 surface 井底，同 FieldInput 历史档语言）；
                            定位中 spinner / 已定位（完整 GPS 信息）/ 未定位 */}
                        <View className="min-h-11 flex-row items-center gap-2 rounded-control bg-ink-raised px-3.5 py-2 dark:bg-inkd-raised">
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
                );
            case 2:
                return (
                    <View>
                        {labelLine('处理人')}
                        <FieldInput
                            tone="canvas"
                            value={handledBy}
                            onChangeText={setHandledBy}
                            placeholder={EVENT_HANDLED_BY_PLACEHOLDER}
                            maxLength={EVENT_HANDLED_BY_MAX}
                            autoFocus
                            containerClassName="h-14 justify-center"
                            style={{ fontSize: 16, lineHeight: 24 }}
                            accessibilityLabel="处理人"
                        />
                    </View>
                );
            case 3:
                return (
                    <View>
                        {labelLine('对象')}
                        <FieldInput
                            tone="canvas"
                            value={subjectValue}
                            onChangeText={setSubjectValue}
                            placeholder={EVENT_SUBJECT_PLACEHOLDER}
                            maxLength={EVENT_SUBJECT_VALUE_MAX}
                            autoFocus
                            containerClassName="h-14 justify-center"
                            style={{ fontSize: 16, lineHeight: 24 }}
                            accessibilityLabel="对象"
                        />
                    </View>
                );
            case 4:
                return (
                    <View>
                        {labelLine('手机号')}
                        <FieldInput
                            tone="canvas"
                            value={phone}
                            onChangeText={setPhone}
                            placeholder={EVENT_PHONE_PLACEHOLDER}
                            maxLength={EVENT_PHONE_MAX}
                            keyboardType="phone-pad"
                            inputMode="tel"
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoFocus
                            containerClassName="h-14 justify-center"
                            style={{ fontSize: 16, lineHeight: 24 }}
                            accessibilityLabel="手机号"
                        />
                    </View>
                );
            case 5:
                return (
                    <View>
                        {labelLine('邮箱')}
                        <FieldInput
                            tone="canvas"
                            value={email}
                            onChangeText={setEmail}
                            placeholder={EVENT_EMAIL_PLACEHOLDER}
                            maxLength={EVENT_EMAIL_MAX}
                            keyboardType="email-address"
                            inputMode="email"
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoFocus
                            containerClassName="h-14 justify-center"
                            style={{ fontSize: 16, lineHeight: 24 }}
                            accessibilityLabel="邮箱"
                        />
                    </View>
                );
            default:
                return (
                    <View>
                        {labelLine('描述')}
                        <FieldInput
                            tone="canvas"
                            value={description}
                            onChangeText={setDescription}
                            placeholder={EVENT_DESCRIPTION_PLACEHOLDER}
                            multiline
                            maxLength={EVENT_DESCRIPTION_MAX}
                            autoFocus
                            style={{ minHeight: 120, fontSize: 16, lineHeight: 26 }}
                            accessibilityLabel="事件描述"
                        />
                    </View>
                );
        }
    };

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
                        // 边距基线：屏 px-6(24)，内容列 maxWidth 560 居中收口
                        paddingHorizontal: 24,
                        paddingBottom: 24,
                        alignSelf: 'center',
                        width: '100%',
                        maxWidth: 560,
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
                        图形化双编码，tabular「X / 7」仍在屏头右位；mb-4 区块基线 */}
                    <View className="mb-4 flex-row gap-1" pointerEvents="none">
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

                    {/* ── 字段井（v0.5.1 令 4 核心）：一张 surface 纸卡井承载
                        全部已揭示字段，同井 gap-4 按推进堆叠；顶置贴进度轨
                        （旧的垂直居中 + 摘要卡节奏随井退役，死白收拢）。
                        每字段一个 StepPane（按字段位稳定 key：推进时旧 pane
                        不重挂，输入焦点/IME 存活），仅最新字段 animate 滑入。
                        className 全在 pane children 的普通 View 上，
                        Animated.View 只挂内联动画 style（web 铁律坑） ── */}
                    <View
                        className="rounded-card bg-ink-surface p-4 dark:bg-inkd-surface"
                        style={PAPER_CARD_SHADOW}
                    >
                        <View className="gap-4">
                            {Array.from({ length: step + 1 }).map((_, index) => (
                                <StepPane
                                    key={index}
                                    direction={stepDirection}
                                    animate={index === step && step > 0}
                                >
                                    {renderWellField(index)}
                                </StepPane>
                            ))}
                        </View>
                    </View>
                </ScrollView>

                {/* ── 动作行（v0.5.1 令 4）：移出容器、钉屏底 ──
                    ScrollView 之外的底部单行，px-6 与屏体边距同基线、内容列
                    maxWidth 560 与滚动列同轴；键盘弹起时随外层
                    KeyboardAvoidingView（iOS padding）整体抬升——沿用本页
                    既有键盘通道，不新造避让层。直接创建 = surface ghost
                    次级，继续填写/创建 = 近黑主钮，flex-1 等分 h-12 文字 16；
                    标题未填双禁用（创建门槛同源），直接创建随时可用已填内容
                    创建（用户口径「默认只要输入事件名称即可创建」）；
                    最后一步主钮即创建 */}
                <View
                    className="w-full items-center px-6"
                    style={{ paddingTop: 12, paddingBottom: insets.bottom + 16 }}
                >
                    <View className="flex-row gap-3" style={{ width: '100%', maxWidth: 560 }}>
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
                </View>
            </View>
        </KeyboardAvoidingView>
    );
}
