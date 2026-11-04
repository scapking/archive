import { useMemo, useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    Text,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { BouncyPressable, LucideTrash, LucideVideo } from '@/core/icons';
import { imagePicker } from '@/core/image-picker';
import { useArchiveStore } from './store';
import { dayDiff, isValidLocalDate, validateTripInput } from './trip-logic';
import { isDateInputComplete, DateInput } from './ui/date-input';
import { PrimaryButton } from './ui/primary-button';
import { ScreenHeader } from './ui/screen-header';
import { MediaVideo } from './ui/media-view';
import type { TripRow } from './db';

/** 行程可选图标（emoji 组，覆盖常见旅行语义；商业版可扩成贴纸包）。 */
const ICON_CHOICES = ['🧭', '⛰️', '🌊', '🏛️', '🏙️', '🚗', '✈️', '🚄', '🏕️', '🍜', '📷', '🎡', '⛷️', '🏝️', '🐼', '🗺️'];

/** 分区容器：13px 小节标题 + 内容（app-screens：分组是信息结构，不是装饰）。 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <View className="mt-5">
            <Text className="mb-2 text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                {title}
            </Text>
            {children}
        </View>
    );
}

/**
 * 行程表单（新建 / 编辑双模式）——表单大厂规格：
 * 分区（图标+名称 / 日期 / 描述 / 封面视频 / 危险区）、图标选择环、
 * 日期行带"共 N 天"即时反馈、视频封面卡带更换/移除、删除二次确认。
 */
export function TripFormScreen({ trip }: { trip?: TripRow } = {}) {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const createTrip = useArchiveStore((s) => s.createTrip);
    const updateTrip = useArchiveStore((s) => s.updateTrip);
    const deleteTrip = useArchiveStore((s) => s.deleteTrip);
    const attachTripVideo = useArchiveStore((s) => s.attachTripVideo);
    const storeError = useArchiveStore((s) => s.error);

    const [icon, setIcon] = useState<string | null>(trip?.icon ?? '🧭');
    const [title, setTitle] = useState(trip?.title ?? '');
    const [startDate, setStartDate] = useState(trip?.start_date ?? '');
    const [endDate, setEndDate] = useState(trip?.end_date ?? '');
    const [description, setDescription] = useState(trip?.description ?? '');
    const [videoKey, setVideoKey] = useState<string | null>(trip?.video_key ?? null);
    const [submitting, setSubmitting] = useState(false);
    const [videoBusy, setVideoBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    const isEdit = Boolean(trip);
    const validation = useMemo(
        () => validateTripInput({ title, startDate, endDate }),
        [title, startDate, endDate],
    );
    const canSubmit =
        !submitting && validation === null && isDateInputComplete(startDate) && isDateInputComplete(endDate);
    const dayCount =
        isDateInputComplete(startDate) &&
        isDateInputComplete(endDate) &&
        endDate >= startDate &&
        isValidLocalDate(startDate)
            ? dayDiff(startDate, endDate) + 1
            : null;

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        if (trip) {
            const ok = await updateTrip(trip.id, { title, startDate, endDate, description, icon, videoKey });
            setSubmitting(false);
            if (ok) router.back();
            return;
        }
        const created = await createTrip({ title, startDate, endDate, description, icon });
        setSubmitting(false);
        if (created) router.replace({ pathname: '/trip/[id]', params: { id: created.id } });
    };

    const pickVideo = async () => {
        if (videoBusy || !trip) return;
        setVideoBusy(true);
        try {
            const permission = await imagePicker.getMediaLibraryPermissionAsync();
            if (!permission.granted) {
                const requested = await imagePicker.requestMediaLibraryPermissionAsync();
                if (!requested.granted) return;
            }
            const result = await imagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], quality: 1 });
            if (result.canceled || result.assets.length === 0) return;
            const ok = await attachTripVideo(trip.id, result.assets[0].uri);
            // key 规则确定（trip-video/<id>.mp4），上传成功即回填预览
            if (ok) setVideoKey(`trip-video/${trip.id}.mp4`);
        } finally {
            setVideoBusy(false);
        }
    };

    const removeVideo = async () => {
        if (!trip) return;
        setVideoKey(null);
        await updateTrip(trip.id, { videoKey: null });
    };

    const remove = async () => {
        if (!trip) return;
        if (!confirmDelete) {
            setConfirmDelete(true);
            return;
        }
        const ok = await deleteTrip(trip.id);
        if (ok) router.back();
    };

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView
                contentContainerStyle={{
                    paddingTop: insets.top + 8,
                    paddingBottom: insets.bottom + 32,
                    paddingHorizontal: 24,
                }}
                keyboardShouldPersistTaps="handled"
            >
                <ScreenHeader
                    title={isEdit ? '编辑行程' : '新建行程'}
                    subtitle={isEdit ? '修改后立即生效。' : '定下起止日期，每天会自动生成一格。'}
                />

                {/* 图标 + 名称 */}
                <Section title="图标与名称">
                    <View className="flex-row flex-wrap gap-2">
                        {ICON_CHOICES.map((choice) => {
                            const active = icon === choice;
                            return (
                                <Pressable
                                    key={choice}
                                    onPress={() => setIcon(choice)}
                                    className={`h-11 w-11 items-center justify-center rounded-xl border text-[20px] ${
                                        active
                                            ? 'border-ink-accent bg-ink-accent-bg dark:border-inkd-accent dark:bg-inkd-accent-bg'
                                            : 'border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface'
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel={`图标 ${choice}`}
                                    accessibilityState={{ selected: active }}
                                >
                                    <Text className="text-[20px]">{choice}</Text>
                                </Pressable>
                            );
                        })}
                    </View>
                    <TextInput
                        className="mt-3 h-12 rounded-xl border border-ink-border bg-ink-surface px-4 text-[15px] text-ink-text dark:border-inkd-border dark:bg-inkd-surface dark:text-inkd-text"
                        placeholder="比如：京都红叶五日"
                        placeholderTextColor="#8B939C"
                        value={title}
                        onChangeText={setTitle}
                        maxLength={40}
                        returnKeyType="next"
                    />
                </Section>

                {/* 日期 */}
                <Section title="日期">
                    <View className="flex-row items-end gap-3">
                        <View className="flex-1">
                            <Text className="mb-1.5 text-[11px] text-ink-muted dark:text-inkd-muted">出发</Text>
                            <DateInput value={startDate} onChange={setStartDate} />
                        </View>
                        <Text className="pb-3.5 text-ink-muted dark:text-inkd-muted">→</Text>
                        <View className="flex-1">
                            <Text className="mb-1.5 text-[11px] text-ink-muted dark:text-inkd-muted">返回</Text>
                            <DateInput value={endDate} onChange={setEndDate} />
                        </View>
                    </View>
                    <Text className="mt-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">
                        {dayCount !== null ? `共 ${dayCount} 天，每天会自动生成一格` : '填完日期自动算天数'}
                    </Text>
                </Section>

                {/* 描述 */}
                <Section title="描述">
                    <TextInput
                        multiline
                        className="min-h-[88px] rounded-xl border border-ink-border bg-ink-surface px-4 py-3 text-[14px] leading-6 text-ink-text dark:border-inkd-border dark:bg-inkd-surface dark:text-inkd-text"
                        placeholder="一句话说明这次出行（可选）"
                        placeholderTextColor="#8B939C"
                        value={description}
                        onChangeText={setDescription}
                        maxLength={500}
                        textAlignVertical="top"
                    />
                </Section>

                {/* 封面视频（编辑模式） */}
                {isEdit ? (
                    <Section title="封面视频">
                        {videoKey ? (
                            <View className="gap-2">
                                <View className="overflow-hidden rounded-xl border border-ink-border dark:border-inkd-border">
                                    <MediaVideo media={previewVideoRow(videoKey)} height={176} />
                                </View>
                                <View className="flex-row gap-2">
                                    <BouncyPressable onPress={() => void pickVideo()} scaleTo={0.97}>
                                        <View className="h-10 items-center justify-center rounded-lg border border-ink-border bg-ink-surface px-4 dark:border-inkd-border dark:bg-inkd-surface">
                                            <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                                更换
                                            </Text>
                                        </View>
                                    </BouncyPressable>
                                    <Pressable
                                        onPress={() => void removeVideo()}
                                        className="h-10 items-center justify-center rounded-lg border border-ink-border bg-ink-surface px-4 dark:border-inkd-border dark:bg-inkd-surface"
                                    >
                                        <Text className="text-[13px] text-ink-negative dark:text-inkd-negative">
                                            移除
                                        </Text>
                                    </Pressable>
                                </View>
                            </View>
                        ) : (
                            <BouncyPressable onPress={() => void pickVideo()} scaleTo={0.98}>
                                <View
                                    className={`h-[104px] items-center justify-center gap-1.5 rounded-xl border border-dashed border-ink-border bg-ink-surface active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                                        videoBusy ? 'opacity-50' : ''
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel="选择封面视频"
                                >
                                    <LucideVideo size={20} strokeWidth={1.75} color="#8B939C" />
                                    <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                        {videoBusy ? '上传中…' : '从相册选择视频'}
                                    </Text>
                                    <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">
                                        展示在行程页顶部
                                    </Text>
                                </View>
                            </BouncyPressable>
                        )}
                    </Section>
                ) : null}

                {validation ? (
                    <Text className="mt-4 text-[12px] text-ink-negative dark:text-inkd-negative">{validation}</Text>
                ) : null}
                {!validation && storeError ? (
                    <Text className="mt-4 text-[12px] text-ink-negative dark:text-inkd-negative">{storeError}</Text>
                ) : null}

                <View className="mt-6">
                    <PrimaryButton
                        label={isEdit ? '保存修改' : '创建行程'}
                        onPress={() => void submit()}
                        disabled={!canSubmit}
                    />
                </View>

                {/* 危险区（编辑模式）：与主流程隔开 */}
                {isEdit ? (
                    <View className="mt-8 border-t border-ink-rule pt-5 dark:border-inkd-rule">
                        <Pressable
                            onPress={() => void remove()}
                            className={`h-12 items-center justify-center rounded-xl border ${
                                confirmDelete
                                    ? 'border-ink-negative bg-ink-negative-bg dark:border-inkd-negative dark:bg-inkd-negative-bg'
                                    : 'border-ink-border bg-transparent dark:border-inkd-border'
                            }`}
                            accessibilityRole="button"
                            accessibilityLabel="删除行程"
                        >
                            <View className="flex-row items-center gap-1.5">
                                <LucideTrash size={14} color="#DC4A5E" />
                                <Text className="text-[13px] font-medium text-ink-negative dark:text-inkd-negative">
                                    {confirmDelete ? '再点一次确认删除' : '删除行程'}
                                </Text>
                            </View>
                        </Pressable>
                    </View>
                ) : null}

                {submitting || videoBusy ? (
                    <ActivityIndicator color="#3B82F6" style={{ marginTop: 12 }} />
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

/** 编辑预览用媒体行（真实行以 DB 为准）。 */
function previewVideoRow(fileKey: string) {
    return {
        id: 'preview',
        journal_id: 'preview',
        file_key: fileKey,
        kind: 'video' as const,
        width: null,
        height: null,
        created_at: 0,
        deleted_at: null,
    };
}
