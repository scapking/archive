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
import { PrimaryButton, ScreenHeader, usePalette } from './ui';

/**
 * 新建事件页（/events/new，极简表单）：
 *
 * - 字段即需求词表（全字段完整铺开，顺序 = 标题 / 位置 / 处理人 / 对象 /
 *   手机号 / 邮箱 / 描述）：
 *   标题（必填，FieldInput，maxLength 与 EVENT_TITLE_MAX 同源）/
 *   GPS（进页自动经 core/location 取当前位置，**不可手输**——自动定位行保留，
 *   已定位展示**完整 GPS 信息**（状态行「已定位 · ±Nm」+ 原始经纬度行）；失败/
 *   拒绝降级为 muted「未定位」行，创建时 gps 置 null）/ 处理人（可选）/ 对象
 *   （自定义自由文本单输入，kind 固定 'custom'，原子对由 normalizeEventSubject
 *   在提交前归一——留空即整对清除）/ 手机号、邮箱（v7 可选独立联系方式，排在
 *   对象之后——对象=跟谁有关，手机号/邮箱=联系通道语义相邻；phone-pad/email
 *   键盘、autoCapitalize none，无强格式校验，trim 与邮箱空白剥除收口在 store）/
 *   描述（可选，multiline 自然增高收起式）；
 *   placeholder = event-logic 固定常量（EVENT_*_PLACEHOLDER，与设置卡同一
 *   常量源；大厂风收敛：名词短语 + 可选字段「（选填）」后缀）；created_at 时间由 store
 *   落库时统一打，表单不出现时间字段；行间距统一 4dp 网格（组间 gap-4=16、
 *   标签 mb-2=8、提示 mt-1=4、提交 mt-2=8）；
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
                // 值内空白剥除由 store 归一化统一收口（normalizeEventText /
                // normalizeEventEmail），表单不做第二套清洗
                phone,
                email,
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
                                placeholder={EVENT_TITLE_PLACEHOLDER}
                                maxLength={EVENT_TITLE_MAX}
                                autoFocus
                                accessibilityLabel="事件标题"
                            />
                            {!titleValid ? (
                                // 可见提示（需求口径：标题为空禁用提交 + 提示）；
                                // 条件渲染非条件类，不涉恒等铁律
                                <Text className="mt-1 text-[12px] text-ink-muted dark:text-inkd-muted">
                                    创建后可在正文补充细节
                                </Text>
                            ) : null}
                        </View>

                        {/* GPS（进页自动定位，不可手输）：行容器与 FieldInput 同
                            视觉语言（rounded-control 近色底 + min-h-11），内容为
                            只读状态行——定位中 spinner / 已定位（**完整 GPS 信息**：
                            首行「已定位 · ±Nm」、次行原始经纬度 tabular-nums，
                            自动定位行保留）/ 未定位（muted 全行） */}
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
                                        {/* 完整 GPS 信息：状态行（定位成功 + 精度）+
                                            原始坐标行（不取整——入库值即展示值，详情
                                            设置卡同口径）；tabular-nums 防数字抖动 */}
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
                                placeholder={EVENT_HANDLED_BY_PLACEHOLDER}
                                maxLength={EVENT_HANDLED_BY_MAX}
                                accessibilityLabel="处理人"
                            />
                        </View>

                        {/* 对象（可选，自定义自由文本：一句话描述这个事件针对
                            的对象——手机号 / 邮箱 / 地址 / 坐标皆可） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                对象
                            </Text>
                            <FieldInput
                                value={subjectValue}
                                onChangeText={setSubjectValue}
                                placeholder={EVENT_SUBJECT_PLACEHOLDER}
                                maxLength={EVENT_SUBJECT_VALUE_MAX}
                                accessibilityLabel="对象"
                            />
                        </View>

                        {/* 手机号（v7 可选独立联系方式）：phone-pad 数字键盘 +
                            inputMode 'tel'（RN 0.88 InputModeOptions 词表无
                            'phone-pad'，tel 是 HTML inputmode 手机号档）；不做
                            强格式校验——号码排版空格/横线是合法书写习惯，按
                            原样入库 */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
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
                                accessibilityLabel="手机号"
                            />
                        </View>

                        {/* 邮箱（v7 可选）：email 键盘 + autoCapitalize none——
                            邮箱地址不分大小写歧义，禁掉 iOS 首字母自动大写坏掉
                            地址；值内明显空白由 store 归一化剥除（宽容收下手滑，
                            不做格式拒绝） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
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
                                accessibilityLabel="邮箱"
                            />
                        </View>

                        {/* 描述（可选，multiline 收起式：单行高度起步、随内容长高） */}
                        <View>
                            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                描述
                            </Text>
                            <FieldInput
                                value={description}
                                onChangeText={setDescription}
                                placeholder={EVENT_DESCRIPTION_PLACEHOLDER}
                                multiline
                                maxLength={EVENT_DESCRIPTION_MAX}
                                accessibilityLabel="事件描述"
                            />
                        </View>

                        {/* 提交（近黑主行动，PrimaryButton；标题为空禁用）。
                            mt-2(8dp)：叠 gap-4(16) 后与上一字段净距 24dp（4dp 网格
                            主行动独立档） */}
                        <View className="mt-2">
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
