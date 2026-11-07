import { useEffect, useState } from 'react';
import { fileStorage } from '@/core/file-storage';
import { mediaByJournalIds } from '../db';
// v5 依赖反转：ui 层禁止 import store（require cycle 修复）。数据变化通知走
// 中立广播层（store mutation 时经 data-revision.notifyDataRevision 转发）。
import { useDataRevision } from '../data-revision';
import type { JournalMediaRow } from '../db';

/**
 * file-storage key 的解析三态：
 * - loading：key 存在，文件 URL 解析中（渲染占位底，不裸黑块）；
 * - ready：拿到可渲染 URI（native: file://，web: blob:）；
 * - missing：读取失败 / key 缺失（文件删除或损坏，属文档化可自愈降级：
 *   缺文件的媒体不应打断时间线浏览，渲染为明确的失败态而非永久占位）。
 */
export type FileUrlStatus = 'loading' | 'ready' | 'missing';

export interface FileUrlState {
    status: FileUrlStatus;
    /** 仅 status === 'ready' 时非空；blob 引用由内部在卸载时统一释放。 */
    uri: string | null;
}

/** useFileUrl 的三态版本：媒体块需要区分「解析中」与「解析失败」两态时用。 */
export function useFileUrlState(key: string | null): FileUrlState {
    const [state, setState] = useState<FileUrlState>({ status: 'loading', uri: null });

    useEffect(() => {
        if (!key) {
            // 无 key = 无媒体行数据，直接按缺失处理（与 catch 分支同降级）
            setState({ status: 'missing', uri: null });
            return;
        }
        let active = true;
        let blobUrl: string | null = null;
        // key 变化先回到 loading：避免上一张图的 URI 串位到下一格
        setState({ status: 'loading', uri: null });
        fileStorage
            .url(key)
            .then((resolved) => {
                if (resolved.startsWith('blob:')) blobUrl = resolved;
                if (active) setState({ status: 'ready', uri: resolved });
            })
            .catch(() => {
                // 缺文件时静默置空是安全的：媒体行在、二进制缺失属可自愈状态
                if (active) setState({ status: 'missing', uri: null });
            });
        return () => {
            active = false;
            if (blobUrl) fileStorage.revokeUrl(blobUrl);
        };
    }, [key]);

    return state;
}

/**
 * file-storage key → 可渲染 URI（native: file://，web: blob:）。
 * blob 引用在卸载时释放；读取失败按空处理（缺文件的缩略图降级为空白，
 * 属文档化降级：文件删除/损坏不应打断时间线浏览）。
 *
 * 兼容薄包装：既有消费者只关心 uri；需要区分加载/失败态的媒体块用 useFileUrlState。
 */
export function useFileUrl(key: string | null): string | null {
    return useFileUrlState(key).uri;
}

/** 某篇日记的媒体行（数据版本变化自动重载；订阅经 data-revision，不经 store）。 */
export function useJournalMedia(journalId: string | null): JournalMediaRow[] {
    const [rows, setRows] = useState<JournalMediaRow[]>([]);
    const revision = useDataRevision();
    useEffect(() => {
        if (!journalId) {
            setRows([]);
            return;
        }
        let active = true;
        mediaByJournalIds([journalId])
            .then((grouped) => {
                if (active) setRows(grouped.get(journalId) ?? []);
            })
            .catch(() => {
                // 中断场景：媒体行刷新 reject 不能 unhandled（红屏）。静默需注释：
                // ui 层禁 import store（v5 去环纪律）无 error 通道；失败保留上次
                // 行（封面降级为占位，不丢卡），revision 变化自动重试
            });
        return () => {
            active = false;
        };
    }, [journalId, revision]);
    return rows;
}
