import { useEffect, useState } from 'react';
import { fileStorage } from '@/core/file-storage';
import { mediaByJournalIds } from '../db';
import { useArchiveRevision } from '../store';
import type { JournalMediaRow } from '../db';

/**
 * file-storage key → 可渲染 URI（native: file://，web: blob:）。
 * blob 引用在卸载时释放；读取失败按空处理（缺文件的缩略图降级为空白，
 * 属文档化降级：文件删除/损坏不应打断时间线浏览）。
 */
export function useFileUrl(key: string | null): string | null {
    const [uri, setUri] = useState<string | null>(null);

    useEffect(() => {
        if (!key) {
            setUri(null);
            return;
        }
        let active = true;
        let blobUrl: string | null = null;
        fileStorage
            .url(key)
            .then((resolved) => {
                if (resolved.startsWith('blob:')) blobUrl = resolved;
                if (active) setUri(resolved);
            })
            .catch(() => {
                // 缺文件时静默置空是安全的：媒体行在、二进制缺失属可自愈状态
                if (active) setUri(null);
            });
        return () => {
            active = false;
            if (blobUrl) fileStorage.revokeUrl(blobUrl);
        };
    }, [key]);

    return uri;
}

/** 某篇日记的媒体行（revision 变化自动重载）。 */
export function useJournalMedia(journalId: string | null): JournalMediaRow[] {
    const [rows, setRows] = useState<JournalMediaRow[]>([]);
    const revision = useArchiveRevision();
    useEffect(() => {
        if (!journalId) {
            setRows([]);
            return;
        }
        let active = true;
        mediaByJournalIds([journalId]).then((grouped) => {
            if (active) setRows(grouped.get(journalId) ?? []);
        });
        return () => {
            active = false;
        };
    }, [journalId, revision]);
    return rows;
}
