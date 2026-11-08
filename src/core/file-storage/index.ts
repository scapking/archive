import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { openDatabase } from '@/core/database';
import { opfsBackend } from './web-opfs';
import { FileStorageError, toFileStorageError } from './errors';

/** web 分流标记：SDK 58 expo-file-system 的 web 变体是纯 stub（见 web-opfs.ts 头注）。 */
const WEB = Platform.OS === 'web';

/**
 * SDK 58 native 变体 web 缺失引发的兼容层（web 由 OPFS 承担后，以下 polyfill
 * 仅对 native 生效路径保留防御意义；上游修复后移除，见 AGENTS.md 偏差表）。
 */
if (!WEB) {
    for (const klass of [Directory, File]) {
        if (typeof klass.prototype.validatePath !== 'function') {
            (klass.prototype as { validatePath?: () => void }).validatePath = () => undefined;
        }
    }
}

/**
 * web 端申请持久化存储：OPFS 与 IndexedDB 一样，未申请时可能被浏览器清除。
 */
function requestWebPersistentStorage(): void {
    if (!WEB) return;
    if (globalThis.navigator?.storage?.persist === undefined) return;
    void globalThis.navigator.storage.persist().catch(() => undefined);
}

/**
 * 文件元数据表：三端统一的 SHA-256 checksum（native 的 md5 仅原生可得，web 无实现，
 * 因此统一为写入时自算 SHA-256；缺元数据时 stat 懒计算兜底）。
 * 与 data-store/cache-store 共库（almightydb.db），版本号互不相同且递增。
 */
const META_MIGRATIONS = [
    {
        version: 3,
        statements: [
            `CREATE TABLE IF NOT EXISTS file_meta (
                key TEXT PRIMARY KEY,
                sha256 TEXT NOT NULL,
                size INTEGER NOT NULL,
                modified_at INTEGER
            )`,
        ],
    },
];

const DATABASE_NAME = 'almightydb.db';

async function metaDb() {
    return openDatabase(DATABASE_NAME, { migrations: META_MIGRATIONS });
}

interface MetaRow {
    key: string;
    sha256: string;
    size: number;
    modified_at: number | null;
}

/**
 * 通用文件调用接口：二进制/文本内容的持久化（mp4、jpg、pdf…）。
 * API 形态对齐 S3/Supabase Storage 社区惯例（put/get/stat/list/remove）。
 * 底座：native = expo-file-system File/Directory 类；web = OPFS 直连（glossary §3）。
 *
 * 存储 key 是相对路径（"a/b/c.mp4"），直接映射到存储根目录下的子路径，
 * 严禁 `..` 与绝对路径（见 validateKey）。
 */
const STORAGE_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
const MAX_KEY_LENGTH = 512;
const MAX_KEY_SEGMENTS = 16;

function validateKey(key: string, action: string): void {
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
        throw new FileStorageError('file-storage/invalid-key', `fileStorage.${action}: key 长度须在 1..${MAX_KEY_LENGTH}，收到 ${key.length}`);
    }
    if (!STORAGE_KEY_PATTERN.test(key)) {
        throw new FileStorageError(
            'file-storage/invalid-key',
            `fileStorage.${action}: key 必须形如 "a/b/c"（段内 [a-zA-Z0-9._-]，段首字母或数字），收到 "${key}"`,
        );
    }
    if (key.split('/').length > MAX_KEY_SEGMENTS) {
        throw new FileStorageError('file-storage/invalid-key', `fileStorage.${action}: key 层级不得超过 ${MAX_KEY_SEGMENTS} 段`);
    }
}

/** 文件元数据（stat/list 返回）。 */
export interface StoredFileInfo {
    key: string;
    size: number;
    /** 内容 SHA-256 hex（三端统一；写入时计算并持久化到 file_meta，缺元数据时 stat 懒计算） */
    checksum: string | null;
    /** 最后修改时间（epoch 毫秒），平台未提供时 null */
    modifiedAt: number | null;
}

/** put 接受的内容形态：二进制或 UTF-8 文本。 */
export type FileContent = Uint8Array | ArrayBuffer | string;

function toBytes(content: FileContent): Uint8Array {
    return typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content instanceof Uint8Array
            ? content
            : new Uint8Array(content);
}

/** 本地文件 URI → 字节（picker/manipulator 产物落盘用；web 走 fetch，native 走 File API）。 */
export async function readUriBytes(uri: string): Promise<Uint8Array> {
    if (WEB) {
        const response = await fetch(uri);
        return new Uint8Array(await response.arrayBuffer());
    }
    return new File(uri).bytes();
}

/** putFromUri 复用同一通道。 */
async function bytesFromUri(uri: string): Promise<Uint8Array> {
    return readUriBytes(uri);
}

/* ------------------------------------------------------------------ */
/* 大文件直迁（moveFromUri/copyFromUri，2026-11-08 登记，glossary §3）  */
/* ------------------------------------------------------------------ */

/**
 * 直迁进度快照：bytesWritten / totalBytes（总大小未知时 totalBytes = null——
 * web 无 Content-Length 的源没有可靠总量，消费方须按「未知总量」降级展示，
 * 不得伪造百分比）。
 */
export interface PutProgress {
    bytesWritten: number;
    totalBytes: number | null;
}

export type PutProgressListener = (progress: PutProgress) => void;

export interface PutFromUriOptions {
    /**
     * native 直迁语义：true = move（源文件移入存储，cache 临时产物零残留），
     * false/undefined = copy（源保留）。web 无文件系统级 move，两者同为流式
     * 拷贝（源是 blob:/临时 URL，由浏览器会话生命周期回收）。
     */
    move?: boolean;
    /**
     * 进度上抛（原始节拍：web 每个写入块一拍、native 仅起点/终点两拍——原生
     * File.move/copy 无逐字节事件，JS 线程零参与）。**节流由调用方负责**
     * （100ms 一帧防重渲风暴），本层不缓冲不丢拍。
     */
    onProgress?: PutProgressListener;
}

/** web 流式写入块粒度：2MB（1-4MB 档中值）——单块 write 的 JS→浏览器字节
    拷贝耗时与「让出主线程」频率的平衡点，几十 MB 视频写盘不卡输入/渲染。 */
const WEB_STREAM_CHUNK_BYTES = 2 * 1024 * 1024;

/** 拼接字节块（分块读源的合并写入用）。 */
function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/** web 端主线程让步：宏任务级（setTimeout 0）——微任务不足以让浏览器处理
    输入事件与渲染帧（大文件写入期间保持界面可交互的关键）。 */
function yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * web 流式直迁：fetch 源 URI → ReadableStream 分块读 → 累积到 2MB 块 → OPFS
 * 句柄写入 → 每块间让出主线程。checksum 在块流过时增量计算（sha256 增量
 * update，与旧「全量字节一次算」三端口径一致，无额外 O(n) 读）。源无流
 * （response.body 缺失的旧环境）回退一次性 arrayBuffer（原 putFromUri 行为，
 * 保底不劣化）。
 */
async function webRelocateFromUri(
    key: string,
    uri: string,
    options: PutFromUriOptions | undefined,
    action: 'move' | 'copy',
): Promise<StoredFileInfo> {
    requestWebPersistentStorage();
    const response = await fetch(uri);
    if (!response.ok && response.status !== 0) {
        throw new FileStorageError(
            'file-storage/io',
            `fileStorage.${action}FromUri(${key}): 源读取失败 HTTP ${response.status}`,
        );
    }
    const totalHeader = Number(response.headers.get('Content-Length'));
    const totalBytes = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : null;
    const info: StoredFileInfo = {
        key,
        size: 0,
        checksum: null,
        modifiedAt: Date.now(),
    };
    const body = response.body;
    if (!body) {
        // 保底回退（无 ReadableStream 支持的旧浏览器）：一次性读入，语义同旧
        const bytes = new Uint8Array(await response.arrayBuffer());
        await opfsBackend.put(key, bytes);
        info.size = bytes.byteLength;
        info.checksum = bytesToHex(sha256(bytes));
        await upsertMeta(info);
        options?.onProgress?.({ bytesWritten: info.size, totalBytes: info.size });
        return info;
    }
    const hash = sha256.create();
    const writable = await opfsBackend.openWritable(key);
    let written = 0;
    try {
        const reader = body.getReader();
        let pending: Uint8Array[] = [];
        let pendingLength = 0;
        const flush = async (): Promise<void> => {
            if (pendingLength === 0) return;
            const block = concatChunks(pending, pendingLength);
            pending = [];
            pendingLength = 0;
            await writable.write(block);
            written += block.byteLength;
            hash.update(block);
            options?.onProgress?.({ bytesWritten: written, totalBytes });
            // 让出主线程：块间把控制权交还浏览器（输入/渲染不被大文件写入饿死）
            await yieldToMainThread();
        };
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;
            pending.push(value);
            pendingLength += value.byteLength;
            if (pendingLength >= WEB_STREAM_CHUNK_BYTES) await flush();
        }
        await flush();
        await writable.close();
    } catch (error) {
        // 写入段失败：abort 释放 OPFS 句柄锁（漏了会锁死该 key 到页面刷新），
        // 并尽力摘除半成品文件（半文件无 checksum 无引用，留着只会被 GC 误认
        // 在途——直接删干净）
        await writable.abort();
        await opfsBackend.remove(key).catch(() => undefined);
        throw error;
    }
    // 元数据段在写入段收口之后、且不在半成品清理的 catch 内（对齐 put 口径：
    // 文件已完整落盘时元数据失败不回滚文件——stat 懒计算可补 checksum，行
    // 落库失败另有调用方回滚链）
    info.size = written;
    info.checksum = bytesToHex(hash.digest());
    await upsertMeta(info);
    return info;
}

/**
 * native 直迁：源文件 → 目标 key 全程原生层执行（File.move/copy，promise 落
 * 在原生线程，JS 主线程零字节拷贝——大视频落盘卡界面的根治点）；checksum
 * 用原生 File.digest('SHA-256')（同样不进 JS 字节面，替代旧「全量字节读进
 * JS 算哈希」的主线程 O(大小) 卡顿源）。进度：原生 relocation 无逐字节事件，
 * 只发起点/终点两拍（总大小来自源 stat 元数据，O(1)）。非 file:// 源
 * （content:// 等）自动回退字节路径（readUriBytes 同源限制，行为不劣化）。
 */
async function nativeRelocateFromUri(
    key: string,
    uri: string,
    options: PutFromUriOptions | undefined,
    action: 'move' | 'copy',
): Promise<StoredFileInfo> {
    if (!uri.startsWith('file://')) {
        // 非 file:// 源（罕见：picker 特殊配置可能给 content://）：字节路径兜底，
        // 语义/元数据口径与直迁一致，仅进度退化为终点单拍
        const bytes = await readUriBytes(uri);
        const info: StoredFileInfo = {
            key,
            size: bytes.byteLength,
            checksum: bytesToHex(sha256(bytes)),
            modifiedAt: null,
        };
        const file = resolve(key);
        file.parentDirectory.create({ idempotent: true, intermediates: true });
        await file.write(bytes);
        info.modifiedAt = file.modificationTime;
        await upsertMeta(info);
        options?.onProgress?.({ bytesWritten: info.size, totalBytes: info.size });
        return info;
    }
    const source = new File(uri);
    if (!source.exists) {
        throw new FileStorageError(
            'file-storage/not-found',
            `fileStorage.${action}FromUri(${key}): 源不存在 "${uri}"`,
        );
    }
    const totalBytes = source.size;
    options?.onProgress?.({ bytesWritten: 0, totalBytes });
    const target = resolve(key);
    target.parentDirectory.create({ idempotent: true, intermediates: true });
    if (action === 'move') {
        await source.move(target, { overwrite: true });
    } else {
        await source.copy(target, { overwrite: true });
    }
    // 原生摘要 + 原生 stat：大小/修改时间不搬运字节（digest 失败不回滚落盘——
    // 文件已就位，不写元数据行，checksum 缺失由 stat 懒计算兜底——写空串会让
    // stat 命中元数据行返回空 checksum，破坏「空串 ≠ 有效哈希」的消费口径）
    let checksum: string | null = null;
    try {
        checksum = await target.digest('SHA-256');
    } catch (digestError) {
        console.warn(`[file-storage] ${action}FromUri(${key}) 原生 SHA-256 计算失败，stat 懒计算兜底:`, digestError);
    }
    const info: StoredFileInfo = {
        key,
        size: target.size,
        checksum,
        modifiedAt: target.modificationTime,
    };
    if (checksum != null) await upsertMeta(info);
    options?.onProgress?.({ bytesWritten: info.size, totalBytes: info.size });
    return info;
}

/**
 * 直迁共用入口：native 原生 move/copy（O(1) JS）、web 流式分块（让步调度）。
 * move 语义取舍：录像/录音产物（cache 临时件）用 move——原件移入存储后
 * cache 零残留（cache 清理兼容：产物本就是会话级临时文件，移走即清理，
 * 无需额外删除）；相册/外部产物用 copy（源归系统管理，不动原件）。
 */
async function relocateFromUri(
    key: string,
    uri: string,
    options: PutFromUriOptions | undefined,
    action: 'move' | 'copy',
): Promise<StoredFileInfo> {
    validateKey(key, `${action}FromUri`);
    try {
        return WEB
            ? await webRelocateFromUri(key, uri, options, action)
            : await nativeRelocateFromUri(key, uri, options, action);
    } catch (error) {
        if (error instanceof FileStorageError) throw error;
        throw toFileStorageError(error, `fileStorage.${action}FromUri(${key})`);
    }
}

let rootDirectory: Directory | null = null;

/** 存储根目录（native 专用，懒初始化；web 走 OPFS 无此概念）。 */
function storageRoot(): Directory {
    if (!rootDirectory) {
        rootDirectory = new Directory(Paths.document, 'almightydb', 'files');
    }
    return rootDirectory;
}

function resolve(key: string): File {
    return new File(storageRoot(), ...key.split('/'));
}

export const fileStorage = {
    /** 写入内容（覆盖已有）。自动创建中间目录；同时记录三端统一的 SHA-256 元数据。 */
    async put(key: string, content: FileContent): Promise<StoredFileInfo> {
        requestWebPersistentStorage();
        validateKey(key, 'put');
        try {
            const bytes = toBytes(content);
            const info: StoredFileInfo = {
                key,
                size: bytes.byteLength,
                checksum: bytesToHex(sha256(bytes)),
                modifiedAt: null,
            };
            if (WEB) {
                await opfsBackend.put(key, bytes);
                info.modifiedAt = Date.now();
            } else {
                const file = resolve(key);
                file.parentDirectory.create({ idempotent: true, intermediates: true });
                await file.write(bytes);
                info.modifiedAt = file.modificationTime;
            }
            await upsertMeta(info);
            return info;
        } catch (error) {
            throw toFileStorageError(error, `fileStorage.put(${key})`);
        }
    },

    /**
     * 从本地文件 URI 直接入库（picker / 变换产物，免二次中转）。语义 = copy
     * （源保留）；大文件（视频等）改用 moveFromUri/copyFromUri 直迁——本方法
     * 保持字节路径（web 全量、native 全量），只服务小文件与无进度诉求的调用方。
     */
    async putFromUri(key: string, uri: string): Promise<StoredFileInfo> {
        return fileStorage.put(key, await bytesFromUri(uri));
    },

    /**
     * 【大文件直迁】从本地文件 URI 移入存储（native 原生 move，cache 录像
     * 产物落盘专用——JS 线程零字节拷贝、原生 SHA-256；web 流式分块 + 主线程
     * 让步），进度经 options.onProgress 上抛（节流归调用方）。move 语义：
     * 源文件被移走（cache 临时产物零残留）；web 无文件级 move，等同流式 copy
     * （源是浏览器临时/blob URL，会话生命周期回收）。元数据与 put 同口径。
     */
    async moveFromUri(key: string, uri: string, options?: PutFromUriOptions): Promise<StoredFileInfo> {
        return relocateFromUri(key, uri, options, 'move');
    },

    /**
     * 【大文件直迁】从本地文件 URI 拷贝入库（相册/外部产物：不动原件）。
     * 实现与进度口径同 moveFromUri（native 原生 copy / web 流式分块）。
     */
    async copyFromUri(key: string, uri: string, options?: PutFromUriOptions): Promise<StoredFileInfo> {
        return relocateFromUri(key, uri, options, 'copy');
    },

    /** 读取二进制内容。不存在时抛 not-found（区别于 stat 的 null）。 */
    async get(key: string): Promise<Uint8Array> {
        validateKey(key, 'get');
        if (WEB) {
            try {
                return await opfsBackend.get(key);
            } catch (error) {
                if (error instanceof DOMException && error.name === 'NotFoundError') {
                    throw new FileStorageError('file-storage/not-found', `fileStorage: 不存在 "${key}"`);
                }
                throw toFileStorageError(error, `fileStorage(${key})`);
            }
        }
        return withExisting(key, (file) => file.bytes());
    },

    /** 读取文本内容。 */
    async getText(key: string): Promise<string> {
        const bytes = await fileStorage.get(key);
        return new TextDecoder().decode(bytes);
    },

    /** 查询元数据；不存在返回 null，不抛错。checksum 为三端统一的 SHA-256。 */
    async stat(key: string): Promise<StoredFileInfo | null> {
        validateKey(key, 'stat');
        if (WEB) {
            const info = await opfsBackend.info(key);
            if (!info) {
                await deleteMeta(key);
                return null;
            }
            const meta = await getMeta(key);
            return {
                key,
                size: info.size,
                checksum: meta?.sha256 ?? null,
                modifiedAt: info.modifiedAt,
            };
        }
        const file = resolve(key);
        if (!file.exists) {
            await deleteMeta(key);
            return null;
        }
        const meta = await getMeta(key);
        if (meta) {
            return {
                key,
                size: meta.size,
                checksum: meta.sha256,
                modifiedAt: meta.modified_at,
            };
        }
        // 元数据缺失（旧数据/迁移直拷的文件）：懒计算并回填
        const info = await withExisting(key, (f) => lazyInfo(key, f));
        return info;
    },

    async exists(key: string): Promise<boolean> {
        if (WEB) return opfsBackend.exists(key);
        return (await fileStorage.stat(key)) !== null;
    },

    /** 删除；目标不存在也视为成功（幂等，对齐 S3 DeleteObject 语义）。 */
    async remove(key: string): Promise<void> {
        validateKey(key, 'remove');
        if (WEB) {
            await opfsBackend.remove(key);
            await deleteMeta(key);
            return;
        }
        const file = resolve(key);
        if (file.exists) {
            try {
                file.delete();
            } catch (error) {
                throw toFileStorageError(error, `fileStorage.remove(${key})`);
            }
        }
        await deleteMeta(key);
    },

    /** 递归列出；prefix 为空时列出全部。结果按 key 字典序，checksum 来自元数据表。 */
    async list(prefix?: string): Promise<StoredFileInfo[]> {
        if (prefix !== undefined) validateKey(prefix, 'list');
        if (WEB) {
            const keys = await opfsBackend.list(prefix);
            const metas = await listMeta();
            return keys
                .filter((key) => prefix === undefined || key.startsWith(prefix))
                .sort((a, b) => (a < b ? -1 : 1))
                .map((key) => {
                    const meta = metas.get(key);
                    return { key, size: meta?.size ?? 0, checksum: meta?.sha256 ?? null, modifiedAt: meta?.modified_at ?? null };
                });
        }
        const root = storageRoot();
        if (!root.exists) return [];
        const metas = await listMeta(prefix);
        const files: StoredFileInfo[] = [];
        collect(root, '', files);
        return files
            .filter((info) => prefix === undefined || info.key.startsWith(prefix))
            .map((info) => {
                const meta = metas.get(info.key);
                return meta ? { ...info, checksum: meta.sha256 } : info;
            })
            .sort((a, b) => (a.key < b.key ? -1 : 1));
    },

    /**
     * 可用于预览/分享的本地 URL：native 为 file://，web 为本会话有效的 blob: URL。
     *
     * web 路径零拷贝口径（大文件加载慢的核心修复点）：直接
     * `getFileHandle().getFile()` 取文件快照（File 是 Blob 子类型）并对其
     * createObjectURL——句柄级元数据操作，复杂度 O(1)，无字节搬运；旧实现
     * `arrayBuffer() → new Blob([bytes])` 是 O(文件大小) 的「JS 堆全量读 +
     * Blob 二次拷贝 + 内存峰值翻倍」，几十 MB 视频表现为秒级卡顿。需要真
     * 字节的调用方（备份导出/校验和）继续走 get()，语义不变。
     */
    async url(key: string): Promise<string> {
        validateKey(key, 'url');
        if (WEB) {
            try {
                const file = await opfsBackend.getFile(key);
                return globalThis.URL.createObjectURL(file);
            } catch (error) {
                if (error instanceof DOMException && error.name === 'NotFoundError') {
                    throw new FileStorageError('file-storage/not-found', `fileStorage: 不存在 "${key}"`);
                }
                throw toFileStorageError(error, `fileStorage(${key})`);
            }
        }
        return withExisting(key, (file) => file.uri);
    },

    /** 释放 url() 产生的 blob 引用；native 上为空操作。 */
    revokeUrl(url: string): void {
        if (url.startsWith('blob:') && globalThis.URL?.revokeObjectURL) {
            globalThis.URL.revokeObjectURL(url);
        }
    },

    async move(from: string, to: string): Promise<void> {
        validateKey(from, 'move.from');
        validateKey(to, 'move.to');
        if (WEB) {
            const bytes = await fileStorage.get(from);
            await opfsBackend.put(to, bytes);
            await opfsBackend.remove(from);
            await renameMeta(from, to);
            return;
        }
        await relocate(from, to, 'move');
        await renameMeta(from, to);
    },

    async copy(from: string, to: string): Promise<void> {
        validateKey(from, 'copy.from');
        validateKey(to, 'copy.to');
        if (WEB) {
            const bytes = await fileStorage.get(from);
            await opfsBackend.put(to, bytes);
            const meta = await getMeta(from);
            if (meta) {
                await upsertMeta({ key: to, size: meta.size, checksum: meta.sha256, modifiedAt: meta.modified_at });
            }
            return;
        }
        await relocate(from, to, 'copy');
        const meta = await getMeta(from);
        if (meta) {
            await upsertMeta({ key: to, size: meta.size, checksum: meta.sha256, modifiedAt: meta.modified_at });
        } else {
            // 元数据缺失：按目标文件懒补
            const target = resolve(to);
            await lazyInfo(to, target);
        }
    },

    /**
     * 存储根目录。仅供同类基础设施（migration）组合使用，业务层勿用；web 走 OPFS 无此概念。
     */
    rootDirectory(): Directory {
        if (WEB) {
            throw new FileStorageError('file-storage/io', 'fileStorage.rootDirectory: web 端走 OPFS，无 native 根目录');
        }
        return storageRoot();
    },
};

async function relocate(from: string, to: string, action: 'move' | 'copy'): Promise<void> {
    validateKey(from, `${action}.from`);
    validateKey(to, `${action}.to`);
    try {
        const source = resolve(from);
        if (!source.exists) {
            throw new FileStorageError('file-storage/not-found', `fileStorage.${action}: 源不存在 "${from}"`);
        }
        const target = resolve(to);
        target.parentDirectory.create({ idempotent: true, intermediates: true });
        await source[action](target, { overwrite: true });
    } catch (error) {
        throw toFileStorageError(error, `fileStorage.${action}(${from} -> ${to})`);
    }
}

function collect(dir: Directory, relativeBase: string, out: StoredFileInfo[]): void {
    for (const entry of dir.list()) {
        const key = relativeBase === '' ? entry.name : `${relativeBase}/${entry.name}`;
        if (entry instanceof Directory) {
            collect(entry, key, out);
        } else {
            out.push(syncInfo(key, entry as File));
        }
    }
}

/** 同步快照：不含 checksum（由元数据表合并填充）。 */
function syncInfo(key: string, file: File): StoredFileInfo {
    return {
        key,
        size: file.size,
        checksum: null,
        modifiedAt: file.modificationTime,
    };
}

/** 懒计算快照（stat/迁移兜底路径）：回读文件算 SHA-256 并回填元数据表。 */
async function lazyInfo(key: string, file: File): Promise<StoredFileInfo> {
    const bytes = await file.bytes();
    const info: StoredFileInfo = {
        key,
        size: bytes.byteLength,
        checksum: bytesToHex(sha256(bytes)),
        modifiedAt: file.modificationTime,
    };
    await upsertMeta(info);
    return info;
}

async function upsertMeta(info: StoredFileInfo): Promise<void> {
    try {
        const db = await metaDb();
        await db.run(
            `INSERT INTO file_meta (key, sha256, size, modified_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, modified_at = excluded.modified_at`,
            [info.key, info.checksum ?? '', info.size, info.modifiedAt],
        );
    } catch (error) {
        throw toFileStorageError(error, `fileStorage.meta.put(${info.key})`);
    }
}

async function getMeta(key: string): Promise<MetaRow | null> {
    try {
        const db = await metaDb();
        return await db.getFirst<MetaRow>('SELECT key, sha256, size, modified_at FROM file_meta WHERE key = ?', [key]);
    } catch (error) {
        throw toFileStorageError(error, `fileStorage.meta.get(${key})`);
    }
}

async function deleteMeta(key: string): Promise<void> {
    try {
        const db = await metaDb();
        await db.run('DELETE FROM file_meta WHERE key = ?', [key]);
    } catch (error) {
        throw toFileStorageError(error, `fileStorage.meta.delete(${key})`);
    }
}

async function renameMeta(from: string, to: string): Promise<void> {
    try {
        const db = await metaDb();
        await db.run('UPDATE file_meta SET key = ? WHERE key = ?', [to, from]);
    } catch (error) {
        throw toFileStorageError(error, `fileStorage.meta.rename(${from} -> ${to})`);
    }
}

async function listMeta(prefix?: string): Promise<Map<string, MetaRow>> {
    try {
        const db = await metaDb();
        const rows = prefix
            ? await db.getAll<MetaRow>('SELECT key, sha256, size, modified_at FROM file_meta WHERE key LIKE ?', [`${prefix}%`])
            : await db.getAll<MetaRow>('SELECT key, sha256, size, modified_at FROM file_meta');
        return new Map(rows.map((row) => [row.key, row]));
    } catch (error) {
        throw toFileStorageError(error, `fileStorage.meta.list()`);
    }
}

async function withExisting<T>(key: string, action: (file: File) => T | Promise<T>): Promise<T> {
    const file = resolve(key);
    if (!file.exists) {
        throw new FileStorageError('file-storage/not-found', `fileStorage: 不存在 "${key}"`);
    }
    try {
        return await action(file);
    } catch (error) {
        throw toFileStorageError(error, `fileStorage(${key})`);
    }
}
