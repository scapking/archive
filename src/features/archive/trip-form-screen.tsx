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

/**
 * 行程表单（新建 / 编辑双模式）：图标 + 名称 + 起止日期 + 描述 + 封面视频。
 * 编辑模式含软删除（二次确认）。
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
    const [formError, setFormError] = useState<string | null>(null);

    const isEdit = Boolean(trip);
    const validation = useMemo(
        () => validateTripInput({ title, startDate, endDate }),
        [title, startDate, endDate],
    );
    const canSubmit =
        !submitting && validation === null && isDateInputComplete(startDate) && isDateInputComplete(endDate);

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
                    paddingBottom: insets.bottom + 24,
                    paddingHorizontal: 24,
                }}
                keyboardShouldPersistTaps="handled"
            >
                <ScreenHeader
                    title={isEdit ? '编辑行程' : '新建行程'}
                    subtitle={isEdit ? '修改后立即生效。' : '定下起止日期，每天会自动生成一格。'}
                />
                <View className="gap-5">
                    <View>
                        <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">图标</Text>
                        <View className="flex-row flex-wrap gap-2">
                            {ICON_CHOICES.map((choice) => (
                                <Pressable
                                    key={choice}
                                    onPress={() => setIcon(choice)}
                                    className={`h-11 w-11 items-center justify-center rounded-lg border text-[20px] ${
                                        icon === choice
                                            ? 'border-ink-accent bg-ink-accent-bg dark:border-inkd-accent dark:bg-inkd-accent-bg'
                                            : 'border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface'
                                    }`}
                                    accessibilityRole="button"
                                    accessibilityLabel={`图标 ${choice}`}
                                >
                                    <Text className="text-[20px]">{choice}</Text>
                                </Pressable>
                            ))}
                        </View>
                    </View>

                    <View>
                        <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">行程名</Text>
                        <TextInput
                            className="h-12 rounded-lg border border-ink-border bg-ink-surface px-4 text-[15px] text-ink-text dark:border-inkd-border dark:bg-inkd-surface dark:text-inkd-text"
                            placeholder="比如：京都红叶五日"
                            placeholderTextColor="#8B939C"
                            value={title}
                            onChangeText={setTitle}
                            maxLength={40}
                            returnKeyType="next"
                        />
                    </View>

                    <View>
                        <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">出发日期</Text>
                        <DateInput value={startDate} onChange={setStartDate} placeholder="出发" />
                    </View>

                    <View>
                        <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">返回日期</Text>
                        <DateInput value={endDate} onChange={setEndDate} placeholder="返回" />
                    </View>

                    <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                        {isDateInputComplete(startDate) &&
                        isDateInputComplete(endDate) &&
                        endDate >= startDate &&
                        isValidLocalDate(startDate)
                            ? `共 ${dayDiff(startDate, endDate) + 1} 天`
                            : ' '}
                    </Text>

                    <View>
                        <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">描述</Text>
                        <TextInput
                            multiline
                            className="min-h-[88px] rounded-lg border border-ink-border bg-ink-surface px-4 py-3 text-[14px] leading-6 text-ink-text dark:border-inkd-border dark:bg-inkd-surface dark:text-inkd-text"
                            placeholder="一句话说明这次出行（可选）"
                            placeholderTextColor="#8B939C"
                            value={description}
                            onChangeText={setDescription}
                            maxLength={500}
                            textAlignVertical="top"
                        />
                    </View>

                    {isEdit ? (
                        <View>
                            <Text className="mb-2 text-[12px] text-ink-secondary dark:text-inkd-secondary">
                                封面视频（展示在行程页顶部）
                            </Text>
                            {videoKey ? (
                                <View className="gap-2">
                                    <MediaVideo media={previewVideoRow(videoKey)} height={170} />
                                    <Pressable
                                        onPress={() => void removeVideo()}
                                        className="h-9 items-center justify-center rounded-md border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface"
                                    >
                                        <Text className="text-[12px] text-ink-negative dark:text-inkd-negative">
                                            移除视频
                                        </Text>
                                    </Pressable>
                                </View>
                            ) : (
                                <BouncyPressable onPress={() => void pickVideo()} scaleTo={0.97}>
                                    <View
                                        className={`h-12 flex-row items-center justify-center gap-2 rounded-lg border border-dashed border-ink-border bg-ink-surface active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                                            videoBusy ? 'opacity-50' : ''
                                        }`}
                                        accessibilityRole="button"
                                        accessibilityLabel="选择视频"
                                    >
                                        <LucideVideo size={16} color="#8B939C" />
                                        <Text className="text-[13px] text-ink-secondary dark:text-inkd-secondary">
                                            {videoBusy ? '上传中…' : '从相册选择视频'}
                                        </Text>
                                    </View>
                                </BouncyPressable>
                            )}
                        </View>
                    ) : (
                        <Text className="text-[12px] text-ink-muted dark:text-inkd-muted">
                            创建后可在行程页补封面视频。
                        </Text>
                    )}

                    {validation ? (
                        <Text className="text-[12px] text-ink-negative dark:text-inkd-negative">{validation}</Text>
                    ) : null}
                    {!validation && (storeError || formError) ? (
                        <Text className="text-[12px] text-ink-negative dark:text-inkd-negative">
                            {storeError ?? formError}
                        </Text>
                    ) : null}

                    <PrimaryButton
                        label={isEdit ? '保存修改' : '创建行程'}
                        onPress={() => void submit()}
                        disabled={!canSubmit}
                    />

                    {isEdit ? (
                        <Pressable
                            onPress={() => void remove()}
                            className="h-11 items-center justify-center rounded-lg border border-ink-border bg-ink-surface dark:border-inkd-border dark:bg-inkd-surface"
                            accessibilityRole="button"
                            accessibilityLabel="删除行程"
                        >
                            <View className="flex-row items-center gap-1.5">
                                <LucideTrash size={14} color="#DC4A5E" />
                                <Text className="text-[13px] text-ink-negative dark:text-inkd-negative">
                                    {confirmDelete ? '再点一次确认删除' : '删除行程'}
                                </Text>
                            </View>
                        </Pressable>
                    ) : null}
                    {submitting || videoBusy ? (
                        <ActivityIndicator color="#3B82F6" style={{ position: 'absolute', alignSelf: 'center', bottom: -4 }} />
                    ) : null}
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

/** 编辑预览用媒体行（真实行以行程详情加载为准）。 */
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
