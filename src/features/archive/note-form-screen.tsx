import { useState } from 'react';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Text,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useArchiveStore } from './store';
import { JOURNAL_TITLE_MAX, NOTE_DESCRIPTION_MAX } from './journal-logic';
import { PrimaryButton, ScreenHeader, usePalette } from './ui';
// 深路径注记：FieldInput 未入 ui/index.ts 出口（该文件不在本组改动权限内），
// 域内深取；ui/index.ts 出口扩充时收口（同 close-button / editor-icons 先例）。
import { FieldInput } from './ui/field-input';

/**
 * 新建独立笔记表单（v8，/note/new）：标题与描述均选填（store.createNote 校验
 * 同口径），成功 router.replace 进 /note/[id] 编辑器。
 *
 * 极简形态（对齐 trip-form-screen 的表单骨架，取其最小子集）：
 * - ScreenHeader「新建笔记」不带副标（描述性副标已全线退役，2026-11-19 口径）；
 * - 两个字段自说明（placeholder 即说明），无分区标题、无图标、无日期、无危险区
 *   ——笔记没有行程的出发/结束语义，也没有「创建后再删」的表单内危险动作
 *   （删除入口在编辑器与库卡，不属建页流程）；
 * - 标题单行 h-14（56dp 档）+ 描述 multiline 默认展开（R4「默认一个输入框」，
 *   minHeight 80 + paddingTop 16 的 trip-form 既有口径——调用侧 style 位于
 *   合并数组末位，覆盖 INPUT_TRANSPARENT_STYLE 的 paddingVertical: 0）；
 * - 不 autofocus：进表单即弹键盘会盖住描述字段（trip-form 同决策）。
 *
 * 提交契约：createNote 失败返回 null（文案经 store.error 上浮，按钮不禁用可直接
 * 重试）；成功返回新行，replace（非 push）让「返回」从编辑器直达入口屏，不在
 * 栈里留一层已无意义的空表单。submitting 置位由 PrimaryButton 禁用兜底；
 * finally 复位防「store 方法意外 reject」把按钮永久禁用（trip-form 同款防御）。
 */
export function NoteFormScreen() {
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const palette = usePalette();
    const createNote = useArchiveStore((s) => s.createNote);
    const storeError = useArchiveStore((s) => s.error);

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const submit = async () => {
        // 双击/进行中防重入（PrimaryButton 的 disabled 是视觉层，这里是闸门层）
        if (submitting) return;
        setSubmitting(true);
        try {
            const created = await createNote({ title, description });
            if (created) {
                // typedRoutes 类型未生成 → as never 最小妥协（仓库既有口径，
                // me 页 /search 同款；类型生成后可整体删除）
                router.replace({ pathname: '/note/[id]', params: { id: created.id } } as never);
            }
        } catch (caught) {
            // 防御：createNote 契约不 throw（失败走 null + store.error），这里只兜
            // 环境级意外，不让异常变 unhandled rejection（trip-form 同款注释口径）
            useArchiveStore.setState({
                error: `笔记创建失败：${caught instanceof Error ? caught.message : String(caught)}`,
            });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-ink-base dark:bg-inkd-base"
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            {/* 屏头固定带（journal-edit / trip-detail / search / trip-form 同一
                几何口径）：ScreenHeader 在滚动容器之外，px-6 与字段列对齐 */}
            <View style={{ paddingTop: insets.top }}>
                <ScreenHeader title="新建笔记" />
            </View>
            <ScrollView
                contentContainerStyle={{
                    paddingBottom: insets.bottom + 32,
                    paddingHorizontal: 24,
                }}
                keyboardShouldPersistTaps="handled"
            >
                {/* ── 标题（选填，空串落库 = 未命名，展示层兜底「未命名笔记」）── */}
                <FieldInput
                    tone="surface"
                    value={title}
                    onChangeText={setTitle}
                    placeholder="笔记名称"
                    maxLength={JOURNAL_TITLE_MAX}
                    returnKeyType="next"
                    containerClassName="h-14"
                />

                {/* ── 描述（选填，默认展开的输入框，R4）：多行起手高度 + 顶距同
                    trip-form 描述字段口径（minHeight 80 / paddingTop 16）── */}
                <View className="mt-5">
                    <FieldInput
                        tone="surface"
                        multiline
                        value={description}
                        onChangeText={setDescription}
                        placeholder="笔记描述"
                        maxLength={NOTE_DESCRIPTION_MAX}
                        style={{ minHeight: 80, paddingTop: 16 }}
                    />
                </View>

                {/* 失败文案槽位（trip-form 同槽位口径）：createNote 失败经
                    store.error 上浮，按钮上方红字展示、可直接重试 */}
                {storeError ? (
                    <Text className="mt-3 text-[12px] text-ink-negative dark:text-inkd-negative">
                        {storeError}
                    </Text>
                ) : null}

                <View className="mt-6">
                    <PrimaryButton label="创建笔记" onPress={() => void submit()} disabled={submitting} />
                </View>

                {submitting ? (
                    <ActivityIndicator color={palette.spinner} style={{ marginTop: 12 }} />
                ) : null}
            </ScrollView>
        </KeyboardAvoidingView>
    );
}
