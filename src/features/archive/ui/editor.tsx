import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import { BouncyPressable, LucideImage, LucidePlus, LucideTrash, LucideVideo } from '@/core/icons';
import type { JournalBlock, JournalMediaRow } from '../db';
import { MediaBlock } from './media-view';

/**
 * 共享连续编辑器（行程日记 / 日常日记通用）——大厂编辑器规格：
 *
 * - 画布无盒子：正文直接落在页面底上（16px/28 行高，journaling 可读性口径），
 *   媒体块横向出血通栏（Day One 手感，破出阅读列边距）；
 * - 块模型自上而下：文本段（自动增高、可聚焦续写）与行内媒体（图/视频）混排，
 *   媒体插入即显示 pending 占位（上传中不阻塞继续写字）；
 * - 删除 afforded：媒体右上角小圆 chip（40pt 命中区），移块不删文件；
 * - 失焦即存回调（GitLab 规范：防抖 + blur 双通道）；
 * - 纯受控组件：blocks/media 由屏持有，媒体选取由屏编排（store 落盘后回填）。
 */

/** 插入中占位 id（屏层上传完成回填真实 mediaId）。 */
export const PENDING_MEDIA_ID = '__pending__';

/** 编辑器内容的横向出血量（与屏层阅读列 padding 对齐）。 */
export const EDITOR_BLEED = 24;

function TextBlockInput({
    value,
    editable,
    autoFocus,
    onChange,
    onFocus,
    onBlur,
    placeholder,
}: {
    value: string;
    editable: boolean;
    autoFocus?: boolean;
    onChange(text: string): void;
    onFocus?(): void;
    onBlur?(): void;
    placeholder: string;
}) {
    const [height, setHeight] = useState(72);
    return (
        <TextInput
            multiline
            value={value}
            editable={editable}
            autoFocus={autoFocus}
            onChangeText={onChange}
            onFocus={onFocus}
            onBlur={onBlur}
            onContentSizeChange={(event) =>
                setHeight(Math.max(72, event.nativeEvent.contentSize.height))
            }
            placeholder={placeholder}
            placeholderTextColor="#8B939C"
            className="text-[16px] leading-7 text-ink-text dark:text-inkd-text"
            style={{ height }}
            textAlignVertical="top"
        />
    );
}

/** 媒体上传占位（虚线框 + spinner + 文案，与大厂上传态一致）。 */
function PendingMediaBlock() {
    return (
        <View className="h-[132px] items-center justify-center gap-2 rounded-xl border border-dashed border-ink-accent/40 bg-ink-accent-bg/40 dark:border-inkd-accent/40 dark:bg-inkd-accent-bg/40">
            <ActivityIndicator color="#3B82F6" />
            <Text className="text-[12px] text-ink-secondary dark:text-inkd-secondary">
                正在上传…
            </Text>
        </View>
    );
}

export function BlockEditor({
    blocks,
    mediaById,
    editable,
    focusTextIndex,
    onChange,
    onFocusText,
    onBlurText,
    onPickImage,
    onPickVideo,
    busy = false,
}: {
    blocks: JournalBlock[];
    mediaById: Map<string, JournalMediaRow>;
    editable: boolean;
    /** 需要聚焦的文本块下标（媒体插入后自动续写）。 */
    focusTextIndex?: number | null;
    onChange(blocks: JournalBlock[]): void;
    onFocusText?(index: number): void;
    /** 任一文本段失焦即存（配合防抖的双保险）。 */
    onBlurText?(): void;
    onPickImage(): void;
    onPickVideo(): void;
    busy?: boolean;
}) {
    const updateText = (index: number, text: string) => {
        const next = blocks.map((block, i) =>
            i === index && block.t === 'p' ? { t: 'p' as const, text } : block,
        );
        onChange(next);
    };
    const removeMedia = (index: number) => {
        // 移块不删文件：媒体行与二进制保留（软删除语义，防误删丢失）
        onChange(blocks.filter((_, i) => i !== index));
    };

    const isPending = (block: JournalBlock) =>
        block.t === 'media' && block.mediaId === PENDING_MEDIA_ID;

    return (
        <View className="gap-1">
            {blocks.map((block, index) => {
                if (block.t === 'p') {
                    const isLast = index === blocks.length - 1;
                    return (
                        <TextBlockInput
                            key={`p-${index}`}
                            value={block.text}
                            editable={editable}
                            autoFocus={focusTextIndex === index}
                            onChange={(text) => updateText(index, text)}
                            onFocus={() => onFocusText?.(index)}
                            onBlur={() => onBlurText?.()}
                            placeholder={
                                isLast && blocks.length === 1
                                    ? '想到什么写什么，图片和视频随时插进来。'
                                    : '继续写…'
                            }
                        />
                    );
                }
                if (isPending(block)) return <PendingMediaBlock key={`pending-${index}`} />;
                const media = mediaById.get(block.mediaId);
                if (!media) return null;
                return (
                    <View
                        key={`m-${block.mediaId}`}
                        className="my-3"
                        // 媒体横向出血：破出阅读列边距（Day One 的通栏照片手感）
                        style={{ marginLeft: -EDITOR_BLEED, marginRight: -EDITOR_BLEED }}
                    >
                        <MediaBlock media={media} />
                        {editable ? (
                            <BouncyPressable onPress={() => removeMedia(index)} scaleTo={0.85}>
                                <View className="absolute right-2.5 top-2.5 h-8 w-8 items-center justify-center rounded-full border border-ink-border bg-ink-base/95 dark:border-inkd-border dark:bg-inkd-base/95">
                                    <LucideTrash size={13} color="#DC4A5E" />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>
                );
            })}

            {/* 插入缝：媒体块与末段之间的提示线（只在编辑态且有媒体时出现） */}
            {editable && blocks.some((b) => b.t === 'media') ? (
                <View className="my-1 flex-row items-center gap-2 opacity-60">
                    <View className="h-px flex-1 bg-ink-accent/30 dark:bg-inkd-accent/30" />
                    <LucidePlus size={11} color="#3B82F6" />
                    <View className="h-px flex-1 bg-ink-accent/30 dark:bg-inkd-accent/30" />
                </View>
            ) : null}
        </View>
    );
}

/** 编辑器底部工具坞：图/视频 chip（40pt 命中）· 分隔点 · 字数 · 主行动。 */
export function EditorToolbar({
    editable,
    busy,
    saving,
    charCount,
    savedLabel,
    onPickImage,
    onPickVideo,
    primary,
}: {
    editable: boolean;
    busy: boolean;
    /** 防抖落库进行中（指示器：保存中… / 已保存） */
    saving?: boolean;
    charCount: number;
    savedLabel: string;
    onPickImage(): void;
    onPickVideo(): void;
    /** 右侧主行动（通常是「完成」收笔）。 */
    primary: React.ReactNode;
}) {
    // 只读态不渲染工具 chips（禁用灰 chip = 看起来坏掉的按钮，不呈现）
    const showTools = editable;
    return (
        <View className="border-t border-ink-rule bg-ink-base/95 px-4 pb-2 pt-2 dark:border-inkd-rule dark:bg-inkd-base/95">
            <View className="flex-row items-center gap-2">
                {showTools ? (
                    <>
                        <ToolChip
                            label="图片"
                            disabled={busy}
                            onPress={onPickImage}
                            icon={<LucideImage size={16} strokeWidth={1.9} color="#5A626B" />}
                        />
                        <ToolChip
                            label="视频"
                            disabled={busy}
                            onPress={onPickVideo}
                            icon={<LucideVideo size={16} strokeWidth={1.9} color="#5A626B" />}
                        />
                        <View className="mx-1 h-4 w-px bg-ink-border dark:bg-inkd-border" />
                    </>
                ) : null}
                {/* 保存状态指示器（SaaS/Pajamas 规范：贴近内容、持续可见、不打断） */}
                <Text
                    className={`text-[11px] ${
                        saving
                            ? 'text-ink-muted dark:text-inkd-muted'
                            : 'text-ink-accent dark:text-inkd-accent'
                    }`}
                >
                    {saving ? '保存中…' : savedLabel}
                </Text>
                <View className="flex-1" />
                <Text
                    className="mr-2 text-[11px] text-ink-muted dark:text-inkd-muted"
                    style={{ fontVariant: ['tabular-nums'] }}
                >
                    {charCount} 字
                </Text>
                {primary}
            </View>
        </View>
    );
}

function ToolChip({
    label,
    icon,
    onPress,
    disabled,
}: {
    label: string;
    icon: React.ReactNode;
    onPress(): void;
    disabled?: boolean;
}) {
    return (
        <BouncyPressable onPress={disabled ? undefined : onPress} scaleTo={0.94}>
            <View
                className={`h-10 flex-row items-center gap-1.5 rounded-lg border border-ink-border bg-ink-surface px-3.5 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                    disabled ? 'opacity-40' : ''
                }`}
                accessibilityRole="button"
                accessibilityLabel={label}
            >
                {icon}
                <Text className="text-[13px] font-medium text-ink-secondary dark:text-inkd-secondary">
                    {label}
                </Text>
            </View>
        </BouncyPressable>
    );
}
