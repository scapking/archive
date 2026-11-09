import { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Keyboard,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { LucideMapPin } from '@/core/icons';
import { location } from '@/core/location';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（同 trip-detail 深取先例，
// barrel 出口扩充时收口）。
import { FieldInput } from './ui/field-input';
import {
    EVENT_DESCRIPTION_MAX,
    EVENT_HANDLED_BY_MAX,
    EVENT_SUBJECT_KINDS,
    EVENT_SUBJECT_KIND_LABELS,
    EVENT_SUBJECT_VALUE_MAX,
    EVENT_TITLE_MAX,
    normalizeEventSubject,
    type EventSubjectKind,
} from './event-logic';
import { useArchiveStore } from './store';
import { PrimaryButton, ScreenHeader, usePalette } from './ui';

/**
 * 新建事件页（/events/new，极简表单）：
 *
 * - 字段即需求词表：标题（必填，FieldInput，maxLength 与 EVENT_TITLE_MAX 同源）/
 *   GPS（进页自动经 core/location 取当前位置，**不可手输**——失败/拒绝降级为
 *   muted「未定位」行，创建时 gps 置 null）/ 处理人（可选）/ 对象（类型分段
 *   单选：无/手机/邮箱/地址/GPS + 值输入，原子对由 normalizeEventSubject 在
 *   提交前归一——类型选「无」即整对清除）/ 描述（可选，multiline 自然增高
 *   收起式）；created_at 时间由 store 落库时统一打，表单不出现时间字段；
 * - 定位可靠性：权限预检（已授权跳过弹窗）→ 系统服务检查 → 8s 超时兜底
 *   （定位挂起不阻塞表单填写）；卸载后 discarded（cancelled 守卫防旧响应回填）；
 * - 提交 → store.createEvent（校验失败走 error 通道返回 null，横幅可见不
 *   静默）→ 成功 **replace** 到 /events/[id]（创建即进入详情编辑，栈里不再
 *   留创建页——返回键语义回到列表而非死表单）；
 * - 标题为空：提交钮禁用（PrimaryButton disabled 视觉降透明 + 不触发按压）
 *   + 字段下 muted 提示行（可见提示，不用占位符兼职说明）。
 */

/** 定位超时上限（ms）：单次 getCurrentPosition 的等待上限，超时按失败降级。 */
const LOCATE_TIMEOUT_MS = 8000;

export function EventFormScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const error = useArchiveStore((s) => s.error);

    // ─── 表单字段 ────────────────────────────────────────────────────────────
    const [title, setTitle] = useState('');
    const [handledBy, setHandledBy] = useState('');
    const [subjectKind, setSubjectKind] = useState<EventSubjectKind | null>(null);
    const [subjectValue, setSubjectValue] = useState('');
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

    /** 对象值占位文案按类型分流（工单语言：字段说明跟着类型走）。 */
    const subjectPlaceholder =
        subjectKind === 'phone'
            ? '手机号或备注'
            : subjectKind === 'email'
                ? '邮箱地址'
                : subjectKind === 'address'
                    ? '街道地址'
                    : '坐标或位置描述';

    const submit = async () => {
        if (!titleValid || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        try {
            // 键盘先收（replace 转场不留键盘）
            Keyboard.dismiss();
            // 对象原子对在提交前归一（与 store 落库同源口径；「无」→ 双双置 null）
            const subject = normalizeEventSubject(subjectKind, subjectValue);
            const row = await useArchiveStore.getState().createEvent({
                title,
                gps,
                handledBy,
                subjectKind: subject.kind ?? undefined,
                subjectValue: subject.value ?? undefined,
                description,
            });
            if (row) {
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

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <View style={{ paddingTop: insets.top }} className="flex-1">
                <ScreenHeader title="新建事件" subtitle="标题必填，其余都可以之后补" />
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
                    {error ? (
                        // store.error 通道（校验失败如「给事件起个名字」/落库失败）
                        <Text className="mb-3 text-[12px] text-ink-negative dark:text-inkd-negative">
                            {error}
                        </Text>
                    ) : null}
                    <View className="gap-4">
                        {/* 标题（必填） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                标题
                            </Text>
                            <FieldInput
                                value={title}
                                onChangeText={setTitle}
                                placeholder="事件叫什么？"
                                maxLength={EVENT_TITLE_MAX}
                                autoFocus
                                accessibilityLabel="事件标题"
                            />
                            {!titleValid ? (
                                // 可见提示（需求口径：标题为空禁用提交 + 提示）；
                                // 条件渲染非条件类，不涉恒等铁律
                                <Text className="mt-1.5 text-[12px] text-ink-muted dark:text-inkd-muted">
                                    先起个名字；创建后正文里随时补细节。
                                </Text>
                            ) : null}
                        </View>

                        {/* GPS（进页自动定位，不可手输）：行容器与 FieldInput 同
                            视觉语言（rounded-control 近色底 + min-h-11），内容为
                            只读状态行——定位中 spinner / 已定位 ±Nm（accent icon，
                            数据态上色）/ 未定位（muted 全行） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                位置
                            </Text>
                            <View className="min-h-11 flex-row items-center gap-2 rounded-control bg-ink-surface px-3.5 py-2 dark:bg-inkd-surface">
                                {gpsStatus === 'locating' ? (
                                    <>
                                        <ActivityIndicator
                                            size="small"
                                            color={palette.spinner}
                                        />
                                        <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                            定位中…
                                        </Text>
                                    </>
                                ) : gpsStatus === 'ok' && gps ? (
                                    <>
                                        <LucideMapPin
                                            size={14}
                                            strokeWidth={1.9}
                                            color={palette.accent}
                                        />
                                        <Text
                                            className="flex-1 text-[13px] text-ink-secondary dark:text-inkd-secondary"
                                            style={{ fontVariant: ['tabular-nums'] }}
                                        >
                                            {`已定位${
                                                gps.accuracy != null
                                                    ? ` ±${Math.round(gps.accuracy)}m`
                                                    : ''
                                            }`}
                                        </Text>
                                    </>
                                ) : (
                                    <>
                                        <LucideMapPin
                                            size={14}
                                            strokeWidth={1.9}
                                            color={palette.muted}
                                        />
                                        <Text className="flex-1 text-[13px] text-ink-muted dark:text-inkd-muted">
                                            未定位（未授权或服务不可用，不影响创建）
                                        </Text>
                                    </>
                                )}
                            </View>
                        </View>

                        {/* 处理人（可选） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                处理人
                            </Text>
                            <FieldInput
                                value={handledBy}
                                onChangeText={setHandledBy}
                                placeholder="谁来处理？（可选）"
                                maxLength={EVENT_HANDLED_BY_MAX}
                                accessibilityLabel="处理人"
                            />
                        </View>

                        {/* 对象（类型分段 + 值，可选；「无」= 整对清除） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                对象
                            </Text>
                            {/* 类型分段（无/手机/邮箱/地址/GPS）：轨道语言与列表页
                                状态分段同构；hitSlop 横向归 0（gap-1 间距） */}
                            <View className="flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                                {([null, ...EVENT_SUBJECT_KINDS] as const).map((kind) => {
                                    const active = subjectKind === kind;
                                    const label = kind === null ? '无' : EVENT_SUBJECT_KIND_LABELS[kind];
                                    return (
                                        <Pressable
                                            key={label}
                                            onPress={() => {
                                                setSubjectKind(kind);
                                                // 切回「无」时清值草稿：避免残留值被
                                                // 下次选择静默带走
                                                if (kind === null) setSubjectValue('');
                                            }}
                                            hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                                            className={`h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised ${
                                                active
                                                    ? 'bg-ink-raised dark:bg-inkd-raised'
                                                    : 'bg-ink-surface dark:bg-inkd-surface'
                                            }`}
                                            accessibilityRole="button"
                                            accessibilityState={{ selected: active }}
                                        >
                                            <Text
                                                className={`text-[12px] ${
                                                    active
                                                        ? 'font-medium text-ink-text dark:text-inkd-text'
                                                        : 'text-ink-muted dark:text-inkd-muted'
                                                }`}
                                            >
                                                {label}
                                            </Text>
                                        </Pressable>
                                    );
                                })}
                            </View>
                            {subjectKind !== null ? (
                                // 选了类型才出现值输入（条件渲染；focus 态由输入自身承担）
                                <View className="mt-2">
                                    <FieldInput
                                        value={subjectValue}
                                        onChangeText={setSubjectValue}
                                        placeholder={subjectPlaceholder}
                                        maxLength={EVENT_SUBJECT_VALUE_MAX}
                                        accessibilityLabel="对象值"
                                    />
                                </View>
                            ) : null}
                        </View>

                        {/* 描述（可选，multiline 收起式：单行高度起步、随内容长高） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                描述
                            </Text>
                            <FieldInput
                                value={description}
                                onChangeText={setDescription}
                                placeholder="一句话摘要（可选）"
                                multiline
                                maxLength={EVENT_DESCRIPTION_MAX}
                                accessibilityLabel="事件描述"
                            />
                        </View>

                        {/* 提交（近黑主行动，PrimaryButton；标题为空禁用） */}
                        <View className="mt-1">
                            <PrimaryButton
                                label={submitting ? '创建中…' : '创建事件'}
                                disabled={!titleValid || submitting}
                                onPress={() => void submit()}
                            />
                        </View>
                    </View>
                </ScrollView>
            </View>
        </KeyboardAvoidingView>
    );
}
