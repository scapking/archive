/**
 * web 端存储后端：OPFS（Origin Private File System）直连。
 *
 * 依据：SDK 58 expo-file-system 的 web 变体是纯 stub（build/ExpoFileSystem.web.js
 * 全部方法仅 console.warn + reject，无任何文件实现），新 File/Directory API 在 web
 * 完全不可用。此文件用浏览器原生 OPFS API 提供同等的持久文件能力（刷新不丢），
 * 供 index.ts 在 Platform.OS === 'web' 时分流。native 端不走此文件。
 *
 * OPFS 兼容：Chrome/Edge 102+、Safari 15.2+、Firefox 111+（createWritable）。
 * key 语义与 native 一致（相对路径，已由调用方 validateKey 校验）。
 */

/** OPFS 根句柄（惰性；浏览器不支持时抛出，由上层包装为 FileStorageError）。 */
let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

function opfsRoot(): Promise<FileSystemDirectoryHandle> {
    if (!rootPromise) {
        rootPromise = navigator.storage.getDirectory();
    }
    return rootPromise;
}

function splitKey(key: string): { dirs: string[]; name: string } {
    const segments = key.split('/');
    return { dirs: segments.slice(0, -1), name: segments[segments.length - 1] };
}

/** 逐级取目录句柄（create=false 时不创建，父目录缺失即抛）。 */
async function dirHandle(dirs: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
    let dir = await opfsRoot();
    for (const segment of dirs) {
        dir = await dir.getDirectoryHandle(segment, { create });
    }
    return dir;
}

export const opfsBackend = {
    /** 写入（覆盖）。父目录自动创建。 */
    async put(key: string, content: Uint8Array | ArrayBuffer | string): Promise<void> {
        const { dirs, name } = splitKey(key);
        const dir = await dirHandle(dirs, true);
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        try {
            await writable.write(content as FileSystemWriteChunkType);
            await writable.close();
        } catch (error) {
            // write/close 失败时必须 abort 释放句柄，否则 OPFS 文件锁泄漏，
            // 该 key 的后续读写会一直失败直到页面刷新
            await writable.abort().catch(() => undefined);
            throw error;
        }
    },

    /**
     * 读字节；不存在时抛 NotFoundError（DOMException），由上层转 FileStorageError。
     * O(文件大小)：整文件读入 JS 堆——仅供真正需要字节的调用方（备份导出/
     * 校验和/二次写入）；展示类 URL 一律走 fileStorage.url 的零拷贝路径。
     */
    async get(key: string): Promise<Uint8Array> {
        const file = await opfsBackend.getFile(key);
        return new Uint8Array(await file.arrayBuffer());
    },

    /**
     * 零拷贝取文件快照（File 是 Blob 子类型，可直接 createObjectURL）：
     * `getFileHandle().getFile()` 只拿文件句柄快照、不搬运字节，复杂度
     * O(1)（元数据级），对比 get() 的 O(文件大小) 字节读入——大视频（几十
     * MB）从「秒级读 + 全量内存峰值」降为毫秒级句柄获取。返回的 File 是
     * 快照：后续同 key 重写不影响既有快照/blob URL 的有效性（浏览器保证
     * 快照内容稳定）。
     *
     * OPFS 目录约定核实（重要）：本应用的媒体文件存放在
     * `navigator.storage.getDirectory()` 的 **origin 根目录**（put 由本
     * backend 全权管理）；expo-sqlite web 的 AccessHandlePoolVFS 管理的是
     * 它自己的 pool 块文件子树（core/database 独立通道），二者互不相交——
     * getFileHandle 直取本应用 key 无需经任何 VFS 封装，浏览器原生支持。
     */
    async getFile(key: string): Promise<File> {
        const { dirs, name } = splitKey(key);
        const dir = await dirHandle(dirs, false);
        const fileHandle = await dir.getFileHandle(name);
        return fileHandle.getFile();
    },

    async exists(key: string): Promise<boolean> {
        try {
            const { dirs, name } = splitKey(key);
            const dir = await dirHandle(dirs, false);
            await dir.getFileHandle(name);
            return true;
        } catch {
            return false;
        }
    },

    async remove(key: string): Promise<void> {
        const { dirs, name } = splitKey(key);
        const dir = await dirHandle(dirs, false);
        // key 指向的必是文件（fileStorage 的 key 语义无目录）；不存在时幂等成功
        await dir.removeEntry(name).catch(() => undefined);
    },

    /** 文件元信息；不存在返回 null。 */
    async info(key: string): Promise<{ size: number; modifiedAt: number | null } | null> {
        try {
            const { dirs, name } = splitKey(key);
            const dir = await dirHandle(dirs, false);
            const file = await (await dir.getFileHandle(name)).getFile();
            return { size: file.size, modifiedAt: file.lastModified };
        } catch {
            return null;
        }
    },

    /** 递归列出 prefix 目录下全部文件的相对 key（字典序由调用方排序）。 */
    async list(prefix: string | undefined): Promise<string[]> {
        const root = await opfsRoot();
        const keys: string[] = [];
        const walk = async (dir: FileSystemDirectoryHandle, base: string): Promise<void> => {
            for await (const [name, handle] of dir.entries()) {
                const key = base === '' ? name : `${base}/${name}`;
                if (handle.kind === 'directory') {
                    await walk(handle as FileSystemDirectoryHandle, key);
                } else {
                    keys.push(key);
                }
            }
        };
        if (prefix) {
            // 前缀可能是目录（如 "photos/"）或文件名前缀：先试目录，失败退化为全量过滤
            // （与 native 语义一致：全树收集后 startsWith 过滤，而非静默返回空列表）
            try {
                const dir = await dirHandle(prefix.replace(/\/+$/, '').split('/'), false);
                const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
                await walk(dir, base);
                return keys;
            } catch {
                // walk 可能已推入部分结果，先清空再全量收集，避免重复
                keys.length = 0;
                await walk(root, '');
                return keys.filter((key) => key.startsWith(prefix));
            }
        }
        await walk(root, '');
        return keys;
    },
};
