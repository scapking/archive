import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, ScrollView, Text, View } from 'react-native';
import { BouncyPressable, LucideMapPin, LucideTrash } from '@/core/icons';
import { location } from '@/core/location';
import { CloseButton } from './close-button';
import { FieldInput } from './field-input';
import { usePalette } from './theme';
// event-logic 是纯逻辑叶模块（禁 react/native，无 ui 反向依赖），引用无环
// （rename-card → journal-logic 同款先例）；EventRow/EventStatus/EventSubjectKind
// 类型经 event-logic 的 db re-export 取得（db 不依赖 ui，type-only 无环）。
import {
    EVENT_DESCRIPTION_MAX,
    EVENT_DESCRIPTION_PLACEHOLDER,
    EVENT_EMAIL_MAX,
    EVENT_EMAIL_PLACEHOLDER,
    EVENT_HANDLED_BY_MAX,
    EVENT_HANDLED_BY_PLACEHOLDER,
    EVENT_PHONE_MAX,
    EVENT_PHONE_PLACEHOLDER,
    EVENT_TITLE_MAX,
    EVENT_TITLE_PLACEHOLDER,
    EVENT_SUBJECT_VALUE_MAX,
    EVENT_SUBJECT_PLACEHOLDER,
    EVENT_STATUS_LABELS,
    eventTimeline,
    type EventRow,
    type EventStatus,
    type EventSubjectKind,
} from '../event-logic';

/**
 * 事件设置卡（共享组件，MetaEditCard/RenameCard 同语言：scrim + 居中卡）——
 * 原 event-detail-screen 屏内私有实现在此收口，两处入口同一语义与设计语言：
 *
 * - **入口一（详情屏 /events/[id]）**：状态头右上设置钮 / 状态片 / 处理人、
 *   对象行点按进入；
 * - **入口二（列表页 /events）**：事件卡长按进入（不进详情页即可改元信息/
 *   删除）——长按与点卡进详情并存（BouncyPressable 透传，Pressability 语义
 *   长按后不补发 onPress）。
 *
 * 依赖边界（v5 require cycle 纪律）：本组件不 import store/屏文件——落库通道
 * 由调用方经 onSaveX/onDelete 回调注入（detail 屏 = updateEventMeta +
 * refreshMeta 既有链；列表屏 = updateEventMeta + db.getEvent 回读），组件保持
 * 纯展示；失败文案由调用方从 store.error 反应式经 errorText 传入；定位失败等
 * store 外异常经 onSurfaceError 上浮（调用方写入 store.error 通道）。
 *
 * - **字段 × 行为矩阵（全部即时落库）**：
 *   名称 = FieldInput，blur 保存（无变更跳过；空串/超长 store 拒绝 → 卡内
 *   errorText 就地可重试）；状态 = open/done/failed 三分段，点按即存（任意态
 *   互切——标记失败 / 从失败重新打开 / 失败转完成同一交互）；GPS = 坐标只读
 *   行 + 「重新定位」（权限/服务预检 → 8s 超时兜底，新建表单同口径）/「清除」
 *   点按即存；处理人 = blur 保存（空串 = 清除）；对象 = 类型分段 + 值输入，
 *   类型点按即存整对（原子对归一在 store）、值 blur 保存整对；手机号 / 邮箱 =
 *   v7 可选联系方式，blur 保存（空串 = 清除；email 键盘 + autoCapitalize none，
 *   值内空白由 store 剥除）——两字段随 onSavePhone/onSaveEmail **接线才渲染**
 *  （详情屏已接线；列表页长按入口接线前不出死编辑面）；描述 = multiline
 *   blur 保存（空串 = 清除）；时间线 = 只读展示（event-logic.eventTimeline，
 *   保存后随调用方回读刷新）；删除事件 = negative 行 → 卡内确认步
 *   （正文/媒体一并删除警示 + 删除在途 spinner）；
 * - 草稿与基线：文本字段以挂载时行值为基线（baselineRef），成功保存后推进
 *   ——blur 比对基线，无变更不落库（防抖掉无意义写）；草稿不随 props 回读
 *   重置（卡内编辑期间 props 刷新只影响 GPS/时间线等只读展示位）；
 * - onSave resolve false：errorText 就地展示可重试；保存成功**不关卡**
 *   （连续编辑多字段），onClose 是统一出口（scrim / 卡头 CloseButton /
 *   Android 返回键）。
 * - event 行类型 = Omit<EventRow, 'deleted_at'>：详情屏传 db.getEvent 的
 *   EventRow、列表屏传 decorateEvent 的装饰行（Event）均满足，两入口共用。
 */

/** 定位超时上限（ms）：设置卡「重新定位」的单次 getCurrentPosition 等待上限
 *  （新建表单同款兜底口径，超时按失败降级）。 */
const LOCATE_TIMEOUT_MS = 8000;

/** 设置卡删除步（卡内两段式：行 → 确认步，InsertMenu confirming 同语言）。 */
type SettingsStep = 'main' | 'confirm-delete';

export function EventSettingsCard({
    event,
    onSaveTitle,
    onSaveStatus,
    onSaveGps,
    onSaveHandledBy,
    onSaveSubject,
    onSavePhone,
    onSaveEmail,
    onSaveDescription,
    onDelete,
    onSurfaceError,
    onClose,
    errorText,
}: {
    /** 当前行（调用方保存成功后的权威回读行刷新——只读展示位消费，草稿不回灌）。 */
    event: Omit<EventRow, 'deleted_at'>;
    onSaveTitle(value: string): Promise<boolean>;
    onSaveStatus(status: EventStatus): Promise<boolean>;
    onSaveGps(gps: { lat: number; lng: number; accuracy?: number } | null): Promise<boolean>;
    onSaveHandledBy(value: string): Promise<boolean>;
    onSaveSubject(kind: EventSubjectKind | null, value: string): Promise<boolean>;
    /** 手机号保存（v7，可选：未接线 = 字段不渲染——编辑面必须带落库通道，
     *  防「可编辑但不保存」的死相；列表页长按入口接线后可转必选收口）。 */
    onSavePhone?(value: string): Promise<boolean>;
    /** 邮箱保存（v7，可选；可选性口径同 onSavePhone）。 */
    onSaveEmail?(value: string): Promise<boolean>;
    onSaveDescription(value: string): Promise<boolean>;
    /** 删除（确认步触发；true = 成功——调用方关卡/返回，本卡随条件渲染消失）。 */
    onDelete(): Promise<boolean>;
    /** 卡内非 store 异常（定位失败等）的统一上浮出口（store.error 通道）。 */
    onSurfaceError(message: string): void;
    onClose(): void;
    errorText?: string | null;
}) {
    const palette = usePalette();
    const timeline = eventTimeline(event);
    const hasGps = event.gps_lat != null && event.gps_lng != null;

    // ─── 草稿态（挂载时以行值播种，不随 props 回灌）────────────────────────
    const [titleDraft, setTitleDraft] = useState(event.title);
    const [statusDraft, setStatusDraft] = useState<EventStatus>(event.status);
    const [handledByDraft, setHandledByDraft] = useState(event.handled_by ?? '');
    const [valueDraft, setValueDraft] = useState(event.subject_value ?? '');
    const [phoneDraft, setPhoneDraft] = useState(event.phone ?? '');
    const [emailDraft, setEmailDraft] = useState(event.email ?? '');
    const [descriptionDraft, setDescriptionDraft] = useState(event.description ?? '');
    /** 成功保存后的基线（blur 比对用；失败不推进——下次 blur 可重试）。 */
    const baselineRef = useRef({
        title: event.title,
        handledBy: event.handled_by ?? '',
        kind: event.subject_kind,
        value: event.subject_value ?? '',
        phone: event.phone ?? '',
        email: event.email ?? '',
        description: event.description ?? '',
    });
    const [deleting, setDeleting] = useState(false);
    const deletingRef = useRef(false);
    const [step, setStep] = useState<SettingsStep>('main');
    // GPS 重定位在途（spinner + 重入闸）
    const [relocating, setRelocating] = useState(false);
    const relocatingRef = useRef(false);
    const locateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Android 返回键：确认步先退回主步（InsertMenu confirming 同语义），主步关闭
    useEffect(() => {
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            if (step === 'confirm-delete') {
                setStep('main');
                return true;
            }
            onClose();
            return true;
        });
        return () => sub.remove();
    }, [onClose, step]);

    // 卸载卫生：在途定位的竞速计时器清理
    useEffect(() => {
        return () => {
            if (locateTimerRef.current) clearTimeout(locateTimerRef.current);
        };
    }, []);

    const saveTitleDraft = async () => {
        if (titleDraft.trim() === baselineRef.current.title.trim()) return;
        const ok = await onSaveTitle(titleDraft);
        if (ok) baselineRef.current.title = titleDraft.trim();
    };

    const saveHandledByDraft = async () => {
        if (handledByDraft === baselineRef.current.handledBy) return;
        const ok = await onSaveHandledBy(handledByDraft);
        if (ok) baselineRef.current.handledBy = handledByDraft;
    };

    /** 对象保存（自定义自由文本；空 = 清除，归一化在 store）。 */
    const saveSubjectDraft = async (value: string) => {
        const trimmed = value.trim();
        const kind: EventSubjectKind | null = trimmed ? 'custom' : null;
        if (kind === baselineRef.current.kind && trimmed === baselineRef.current.value) return;
        const ok = await onSaveSubject(kind, trimmed);
        if (ok) {
            baselineRef.current.kind = kind;
            baselineRef.current.value = kind === null ? '' : trimmed;
        }
    };

    /** 手机号保存（v7，blur 保存，空串 = 清除；自由文本无格式校验）。 */
    const savePhoneDraft = async () => {
        if (phoneDraft === baselineRef.current.phone) return;
        const ok = await onSavePhone?.(phoneDraft);
        if (ok) baselineRef.current.phone = phoneDraft;
    };

    /** 邮箱保存（v7，blur 保存，空串 = 清除；值内明显空白由 store 的
     *  normalizeEventEmail 剥除——基线比对用原草稿，剥除口径不在卡内复制）。 */
    const saveEmailDraft = async () => {
        if (emailDraft === baselineRef.current.email) return;
        const ok = await onSaveEmail?.(emailDraft);
        if (ok) baselineRef.current.email = emailDraft;
    };

    const saveDescriptionDraft = async () => {
        if (descriptionDraft === baselineRef.current.description) return;
        const ok = await onSaveDescription(descriptionDraft);
        if (ok) baselineRef.current.description = descriptionDraft;
    };

    /** 状态分段点按：本地立即翻面（即时反馈）+ 落库；失败回弹原状态
     *  （errorText 就地反馈，同段可重试——不会卡在「选中但没存上」的死相）。 */
    const saveStatusDraft = async (status: EventStatus) => {
        if (status === statusDraft) return;
        const previous = statusDraft;
        setStatusDraft(status);
        const ok = await onSaveStatus(status);
        if (!ok) setStatusDraft(previous);
    };

    /** 重新定位（新建表单同口径）：权限预检（已授权跳过弹窗）→ 系统服务检查 →
     *  8s 超时兜底；成功即覆盖写（saveGps），失败/拒绝/超时给明确文案（store
     *  外异常经 onSurfaceError 上浮——卡内 errorText 同帧可见）。 */
    const relocate = async () => {
        if (relocatingRef.current) return;
        relocatingRef.current = true;
        setRelocating(true);
        try {
            const permission = await location.getPermissionAsync();
            let granted = permission.granted;
            if (!granted) {
                const requested = await location.requestPermissionAsync();
                granted = requested.granted;
            }
            if (!granted) throw new Error('定位权限未授权');
            const services = await location.hasServicesEnabledAsync();
            if (!services) throw new Error('定位服务未开启');
            const pos = await Promise.race([
                location.getCurrentPositionAsync(),
                new Promise<never>((_, reject) => {
                    locateTimerRef.current = setTimeout(() => reject(new Error('定位超时')), LOCATE_TIMEOUT_MS);
                }),
            ]);
            const ok = await onSaveGps({
                lat: pos.coords.latitude,
                lng: pos.coords.longitude,
                ...(pos.coords.accuracy != null ? { accuracy: pos.coords.accuracy } : {}),
            });
            // ok false：store 已落 GPS 校验文案（errorText 就地可见）
        } catch (caught) {
            onSurfaceError(`定位失败：${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
            if (locateTimerRef.current) {
                clearTimeout(locateTimerRef.current);
                locateTimerRef.current = null;
            }
            relocatingRef.current = false;
            setRelocating(false);
        }
    };

    /** 确认步删除（in-flight spinner + 重入闸；成功调用方关卡，本卡随卸载）。 */
    const confirmDelete = async () => {
        if (deletingRef.current) return;
        deletingRef.current = true;
        setDeleting(true);
        try {
            await onDelete();
        } finally {
            deletingRef.current = false;
            setDeleting(false);
        }
    };

    return (
        <View className="absolute inset-0 z-50">
            <Pressable
                className="flex-1 items-center justify-center bg-ink-scrim px-10 dark:bg-inkd-scrim"
                onPress={onClose}
                accessibilityLabel="关闭事件设置"
            >
                <Pressable className="w-full max-w-xs rounded-card bg-ink-base p-5 dark:bg-inkd-base">
                    {/* 卡头（关闭语言统一 #8）：题 + 右上关闭钮 */}
                    <View className="flex-row items-center justify-between">
                        <Text className="text-[15px] font-semibold text-ink-text dark:text-inkd-text">
                            {step === 'confirm-delete' ? '删除事件？' : '事件设置'}
                        </Text>
                        <CloseButton onPress={onClose} />
                    </View>
                    <ScrollView
                        className="mt-4"
                        style={{ maxHeight: 440 }}
                        nestedScrollEnabled
                        keyboardShouldPersistTaps="handled"
                    >
                        {step === 'confirm-delete' ? (
                            /* ── 确认步（破坏性动作二次确认，DeleteConfirmCard 同语言收进卡内）── */
                            <View>
                                <Text className="text-[13px] leading-5 text-ink-secondary dark:text-inkd-secondary">
                                    正文、媒体会一并删除，不可恢复。
                                </Text>
                                <View className="mt-4 gap-2.5">
                                    {/* 取消 = 退回主步（返回键同语义）；删除在途时禁用出口，
                                        防「确认步关了、删除还在跑」的状态错位 */}
                                    <BouncyPressable
                                        onPress={() => setStep('main')}
                                        disabled={deleting}
                                        scaleTo={0.97}
                                    >
                                        <View
                                            className="h-11 items-center justify-center rounded-control bg-ink-surface dark:bg-inkd-surface"
                                            accessibilityRole="button"
                                            accessibilityLabel="返回设置"
                                        >
                                            <Text className="text-[14px] font-medium text-ink-text dark:text-inkd-text">
                                                取消
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                    <BouncyPressable
                                        onPress={() => void confirmDelete()}
                                        disabled={deleting}
                                        scaleTo={0.97}
                                    >
                                        <View
                                            className="h-11 items-center justify-center rounded-control"
                                            style={{ backgroundColor: palette.negative, opacity: deleting ? 0.6 : 1 }}
                                            accessibilityRole="button"
                                            accessibilityLabel="确认删除事件"
                                        >
                                            {deleting ? (
                                                <ActivityIndicator size="small" color="#FFFFFF" />
                                            ) : (
                                                <Text className="text-[15px] font-semibold text-white">删除</Text>
                                            )}
                                        </View>
                                    </BouncyPressable>
                                </View>
                            </View>
                        ) : (
                            /* ── 主步：字段 × 即时落库 ── */
                            <View className="gap-4">
                                {/* 名称（title 编辑，store.updateEventMeta v6.1 扩展） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        名称
                                    </Text>
                                    <FieldInput
                                        value={titleDraft}
                                        onChangeText={setTitleDraft}
                                        placeholder={EVENT_TITLE_PLACEHOLDER}
                                        maxLength={EVENT_TITLE_MAX}
                                        accessibilityLabel="事件名称"
                                        onBlur={() => void saveTitleDraft()}
                                    />
                                </View>

                                {/* 状态（open/done/failed 三分段，点按即存）：标记失败
                                    与标记完成同一交互解剖（任意态互切 = 从失败可重新
                                    打开/标记完成）；轨道语言与列表页筛选分段同构；
                                    横向 hitSlop 归 0（gap-1 间距），纵向 4 补足 44 */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        状态
                                    </Text>
                                    <View className="flex-row gap-1 rounded-control bg-ink-surface p-1 dark:bg-inkd-surface">
                                        {(['open', 'done', 'failed'] as const).map((option) => {
                                            const active = statusDraft === option;
                                            const label = EVENT_STATUS_LABELS[option];
                                            return (
                                                <Pressable
                                                    key={option}
                                                    onPress={() => void saveStatusDraft(option)}
                                                    hitSlop={{ top: 4, bottom: 4, left: 0, right: 0 }}
                                                    className={`h-9 flex-1 items-center justify-center rounded-thumb active:bg-ink-raised dark:active:bg-inkd-raised ${
                                                        active
                                                            ? 'bg-ink-raised dark:bg-inkd-raised'
                                                            : 'bg-ink-surface dark:bg-inkd-surface'
                                                    }`}
                                                    accessibilityRole="button"
                                                    accessibilityState={{ selected: active }}
                                                    accessibilityLabel={`状态：${label}`}
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
                                </View>

                                {/* GPS（坐标只读 + 重定位/清除，点按即存） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        位置
                                    </Text>
                                    <View className="rounded-control bg-ink-surface px-3.5 py-2 dark:bg-inkd-surface">
                                        {hasGps ? (
                                            <>
                                                <Text
                                                    className="text-[13px] text-ink-secondary dark:text-inkd-secondary"
                                                    style={{ fontVariant: ['tabular-nums'] }}
                                                >
                                                    {`${event.gps_lat}, ${event.gps_lng}`}
                                                </Text>
                                                {event.gps_accuracy != null ? (
                                                    <Text
                                                        className="mt-1 text-[11px] text-ink-muted dark:text-inkd-muted"
                                                        style={{ fontVariant: ['tabular-nums'] }}
                                                    >
                                                        {`精度 ±${Math.round(event.gps_accuracy)}m`}
                                                    </Text>
                                                ) : null}
                                            </>
                                        ) : (
                                            <Text className="text-[13px] text-ink-muted dark:text-inkd-muted">
                                                未定位
                                            </Text>
                                        )}
                                    </View>
                                    <View className="mt-2 flex-row gap-2">
                                        <BouncyPressable
                                            onPress={() => void relocate()}
                                            disabled={relocating}
                                            scaleTo={0.97}
                                            hitSlop={4}
                                        >
                                            <View
                                                className="h-9 flex-row items-center justify-center gap-1.5 rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface"
                                                accessibilityRole="button"
                                                accessibilityLabel="重新定位"
                                            >
                                                {relocating ? (
                                                    <ActivityIndicator size="small" color={palette.secondary} />
                                                ) : (
                                                    <LucideMapPin size={14} strokeWidth={1.9} color={palette.secondary} />
                                                )}
                                                <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                                                    {relocating ? '定位中…' : '重新定位'}
                                                </Text>
                                            </View>
                                        </BouncyPressable>
                                        {hasGps ? (
                                            <BouncyPressable
                                                onPress={() => void onSaveGps(null)}
                                                scaleTo={0.97}
                                                hitSlop={4}
                                            >
                                                <View
                                                    className="h-9 items-center justify-center rounded-control bg-ink-surface px-3.5 dark:bg-inkd-surface"
                                                    accessibilityRole="button"
                                                    accessibilityLabel="清除定位"
                                                >
                                                    <Text className="text-[13px] font-medium text-ink-text dark:text-inkd-text">
                                                        清除
                                                    </Text>
                                                </View>
                                            </BouncyPressable>
                                        ) : null}
                                    </View>
                                </View>

                                {/* 处理人（blur 保存，空串 = 清除） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        处理人
                                    </Text>
                                    <FieldInput
                                        value={handledByDraft}
                                        onChangeText={setHandledByDraft}
                                        placeholder={EVENT_HANDLED_BY_PLACEHOLDER}
                                        maxLength={EVENT_HANDLED_BY_MAX}
                                        accessibilityLabel="处理人"
                                        onBlur={() => void saveHandledByDraft()}
                                    />
                                </View>

                                {/* 对象（可选，自定义自由文本：blur 保存，空 = 清除） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        对象
                                    </Text>
                                    <FieldInput
                                        value={valueDraft}
                                        onChangeText={setValueDraft}
                                        placeholder={EVENT_SUBJECT_PLACEHOLDER}
                                        maxLength={EVENT_SUBJECT_VALUE_MAX}
                                        accessibilityLabel="对象"
                                        onBlur={() => void saveSubjectDraft(valueDraft)}
                                    />
                                </View>

                                {/* 手机号（v7，blur 保存，空串 = 清除）：字段随
                                    onSavePhone 接线才渲染（列表页长按入口未
                                    接线时不出现死编辑面） */}
                                {onSavePhone ? (
                                    <View>
                                        <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                            手机号
                                        </Text>
                                        <FieldInput
                                            value={phoneDraft}
                                            onChangeText={setPhoneDraft}
                                            placeholder={EVENT_PHONE_PLACEHOLDER}
                                            maxLength={EVENT_PHONE_MAX}
                                            keyboardType="phone-pad"
                                            inputMode="tel"
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            accessibilityLabel="手机号"
                                            onBlur={() => void savePhoneDraft()}
                                        />
                                    </View>
                                ) : null}

                                {/* 邮箱（v7，blur 保存，空串 = 清除）：email 键盘 +
                                    autoCapitalize none（禁首字母自动大写坏地址）；
                                    接线门控口径同手机号 */}
                                {onSaveEmail ? (
                                    <View>
                                        <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                            邮箱
                                        </Text>
                                        <FieldInput
                                            value={emailDraft}
                                            onChangeText={setEmailDraft}
                                            placeholder={EVENT_EMAIL_PLACEHOLDER}
                                            maxLength={EVENT_EMAIL_MAX}
                                            keyboardType="email-address"
                                            inputMode="email"
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                            accessibilityLabel="邮箱"
                                            onBlur={() => void saveEmailDraft()}
                                        />
                                    </View>
                                ) : null}

                                {/* 描述（multiline，blur 保存，空串 = 清除） */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        描述
                                    </Text>
                                    <FieldInput
                                        value={descriptionDraft}
                                        onChangeText={setDescriptionDraft}
                                        placeholder={EVENT_DESCRIPTION_PLACEHOLDER}
                                        multiline
                                        maxLength={EVENT_DESCRIPTION_MAX}
                                        accessibilityLabel="事件描述"
                                        onBlur={() => void saveDescriptionDraft()}
                                    />
                                </View>

                                {/* 时间线（只读）：event-logic.eventTimeline 单一口径，
                                    保存后随调用方权威回读即时刷新 */}
                                <View>
                                    <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                                        时间线
                                    </Text>
                                    <View className="rounded-control bg-ink-surface px-3.5 py-2 dark:bg-inkd-surface">
                                        <Text
                                            className="text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                            style={{ fontVariant: ['tabular-nums'] }}
                                        >
                                            {`创建 ${timeline.createdText}`}
                                        </Text>
                                        {timeline.edited ? (
                                            <Text
                                                className="mt-1 text-[12px] text-ink-secondary dark:text-inkd-secondary"
                                                style={{ fontVariant: ['tabular-nums'] }}
                                            >
                                                {`更新 ${timeline.updatedText}`}
                                            </Text>
                                        ) : null}
                                    </View>
                                </View>

                                {/* 删除事件（negative 弱行钮 → 卡内确认步；删除为级联
                                    软删 + 文件清理，确认步强调后果） */}
                                <View>
                                    <BouncyPressable
                                        onPress={() => setStep('confirm-delete')}
                                        scaleTo={0.97}
                                    >
                                        <View
                                            className="h-11 flex-row items-center justify-center gap-2 rounded-control bg-ink-surface dark:bg-inkd-surface"
                                            accessibilityRole="button"
                                            accessibilityLabel="删除事件"
                                        >
                                            <LucideTrash size={16} strokeWidth={1.9} color={palette.negative} />
                                            <Text className="text-[14px] font-medium text-ink-negative dark:text-inkd-negative">
                                                删除事件
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                </View>
                            </View>
                        )}
                        {/* 失败就地展示（保存/定位失败的 store 文案；卡内可重试） */}
                        {errorText ? (
                            <Text className="mt-3 text-[12px] text-ink-negative dark:text-inkd-negative">
                                {errorText}
                            </Text>
                        ) : null}
                    </ScrollView>
                </Pressable>
            </Pressable>
        </View>
    );
}
