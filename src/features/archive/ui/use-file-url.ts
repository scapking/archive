import { useEffect, useState } from 'react';
import { fileStorage } from '@/core/file-storage';

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
                // 缺文件时静默置空是安全的：photo 行在、二进制缺失属可自愈状态
                if (active) setUri(null);
            });
        return () => {
            active = false;
            if (blobUrl) fileStorage.revokeUrl(blobUrl);
        };
    }, [key]);

    return uri;
}
