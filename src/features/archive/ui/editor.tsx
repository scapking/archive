import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { BouncyPressable, LucideImage, LucideTrash, LucideVideo } from '@/core/icons';
import type { JournalBlock, JournalMediaRow } from '../db';
import { MediaBlock } from './media-view';

/**
 * 共享连续编辑器（行程日记 / 日常日记通用）：块模型自上而下——
 * 文本段（自动增高）与行内媒体（图/视频）混排；末段持续写入，媒体随写随插。
 * 纯受控组件：blocks / media 由屏持有，媒体选取由屏编排（store 落盘后追加块）。
 */

function TextBlockInput({
    value,
    editable,
    onChange,
    placeholder,
}: {
    value: string;
    editable: boolean;
    onChange(text: string): void;
    placeholder: string;
}) {
    const [height, setHeight] = useState(96);
    return (
        <TextInput
            multiline
            value={value}
            editable={editable}
            onChangeText={onChange}
            onContentSizeChange={(event) =>
                setHeight(Math.max(96, event.nativeEvent.contentSize.height))
            }
            placeholder={placeholder}
            placeholderTextColor="#8B939C"
            className="text-[15px] leading-7 text-ink-text dark:text-inkd-text"
            style={{ height }}
            textAlignVertical="top"
        />
    );
}

export function BlockEditor({
    blocks,
    mediaById,
    editable,
    onChange,
    onPickImage,
    onPickVideo,
    busy = false,
}: {
    blocks: JournalBlock[];
    mediaById: Map<string, JournalMediaRow>;
    editable: boolean;
    onChange(blocks: JournalBlock[]): void;
    onPickImage(): void;
    onPickVideo(): void;
    /** 媒体落盘中（防抖保存照常，工具条禁用防重复插） */
    busy?: boolean;
}) {
    const updateText = (index: number, text: string) => {
        const next = blocks.map((block, i) => (i === index && block.t === 'p' ? { t: 'p' as const, text } : block));
        onChange(next);
    };
    const removeMedia = (index: number) => {
        // 块移除；媒体行与文件保留（软删除语义，防误删丢失）
        onChange(blocks.filter((_, i) => i !== index));
    };

    return (
        <View className="gap-3">
            {blocks.map((block, index) => {
                if (block.t === 'p') {
                    const isLast = index === blocks.length - 1;
                    return (
                        <TextBlockInput
                            key={`p-${index}`}
                            value={block.text}
                            editable={editable}
                            onChange={(text) => updateText(index, text)}
                            placeholder={
                                isLast && blocks.length === 1
                                    ? '从这里开始写。想到什么写什么，图片和视频随时插入。'
                                    : '继续写…'
                            }
                        />
                    );
                }
                const media = mediaById.get(block.mediaId);
                if (!media) return null;
                return (
                    <View key={`m-${block.mediaId}`}>
                        <MediaBlock media={media} />
                        {editable ? (
                            <BouncyPressable onPress={() => removeMedia(index)} scaleTo={0.85}>
                                <View className="absolute right-2 top-2 h-7 w-7 items-center justify-center rounded-full border border-ink-border bg-ink-base/90 dark:border-inkd-border dark:bg-inkd-base/90">
                                    <LucideTrash size={13} color="#DC4A5E" />
                                </View>
                            </BouncyPressable>
                        ) : null}
                    </View>
                );
            })}

            {editable ? (
                <View className="mt-2 flex-row items-center gap-2">
                    <ToolButton
                        label="图片"
                        icon={<LucideImage size={15} color="#5A626B" />}
                        disabled={busy}
                        onPress={onPickImage}
                    />
                    <ToolButton
                        label="视频"
                        icon={<LucideVideo size={15} color="#5A626B" />}
                        disabled={busy}
                        onPress={onPickVideo}
                    />
                    {busy ? (
                        <Text className="text-[11px] text-ink-muted dark:text-inkd-muted">上传中…</Text>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

function ToolButton({
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
        <Pressable
            onPress={disabled ? undefined : onPress}
            className={`h-9 flex-row items-center gap-1.5 rounded-md border border-ink-border bg-ink-surface px-3 active:bg-ink-raised dark:border-inkd-border dark:bg-inkd-surface dark:active:bg-inkd-raised ${
                disabled ? 'opacity-50' : ''
            }`}
            accessibilityRole="button"
            accessibilityLabel={label}
        >
            {icon}
            <Text className="text-[12px] text-ink-secondary dark:text-inkd-secondary">{label}</Text>
        </Pressable>
    );
}
