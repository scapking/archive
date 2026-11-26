import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { fileStorage } from '@/core/file-storage';
import { mediaByJournalIds } from '../db';
// v5 依赖反转：ui 层禁止 import store（require cycle 修复）。数据变化通知走
// 中立广播层（store mutation 时经 data-revision.notifyDataRevision 转发）。
import { useDataRevision } from '../data-revision';
import type { JournalMediaRow } from '../db';
// 状态机纯函数（v0.4.4 堆叠换张零占位帧的修复面，node 测试直接覆盖）
import {
    MISSING_FILE_URL_STATE,
    nextFileUrlState,
    type FileUrlState,
    type FileUrlStatus,
} from './file-url-state';

export type { FileUrlState, FileUrlStatus };

/**
 * 会话级 URL 缓存（web blob 层的性能修复面，「大文件加载慢」的第二根因）：
 *
 * 修前：useFileUrlState 每次挂载都走 fileStorage.url() → OPFS 全量字节读 →
 * 新 blob URL → 卸载即 revoke。FlatList 回收重挂 / 切屏回来 / 编辑器重渲 /
 * deck 前后卡同 key 并挂，全部重复 O(文件大小) 的读放大 + revoke 后重读。
 *
 * 修后：模块级 Map<fileKey, entry> 会话缓存——
 * - 挂载 acquire：命中（同 revision）零读取直接复用 URI，引用计数 +1；
 * - 卸载 release：计数 -1，归零后**延迟**（REVOKE_DELAY_MS）revoke——
 *   FlatList 回收/切屏的短窗重挂（< 10s）完全零读取零占位闪烁；
 * - LRU 上限（CACHE_LIMIT）：越界撤销最旧的零引用条目，内存有界（全部
 *   活跃时引用安全优先于上限，上限退化为「活跃消费方数量」）；
 * - 生命周期收口：缓存层接管 revoke——条目被失效摘出但仍有存活消费者
 *   （缩略图 + 全屏查看器同 key 并挂）时，撤销移交最后一次 release，
 *   不立即 revoke 打断在用方，也不泄漏（见 invalidateEntry）。
 *
 * 失效矩阵（与 data-revision 失效语义兼容）：
 * | 事件                        | 行为                                   |
 * |-----------------------------|----------------------------------------|
 * | 同 revision 缓存命中        | 零读取复用（快路径，含首渲染同步 peek）|
 * | revision 变化 + 内容未变    | O(1) stat 复验（size/modifiedAt 快照比对），续用既有 URI 免重读 |
 * | revision 变化 + 内容已变    | 同 key 重写（attachTripVideo 固定 key 重传）→ 摘出旧条目重新解析，旧 blob 按引用安全延迟撤销 |
 * | 文件被删（remove media/trip）| 行级联删除后无新挂载引用该 key；存量活跃条目随卸载走延迟撤销，不悬挂 |
 * | key 变化                    | 旧条目正常 release，新 key 独立解析（unchanged 语义）|
 *
 * native 侧：file:// 直路径本身 O(1)（validateKey + exists 检查，无字节
 * 搬运），不建缓存对象——直接复用路径字符串，三态语义与 web 一致。
 */

/** 缓存条目。 */
interface FileUrlCacheEntry {
    uri: string;
    /** 存活消费者数（挂载 +1 / 卸载 -1）。 */
    refCount: number;
    /** 归零后的延迟撤销定时器（null = 无挂起撤销）。 */
    revokeTimer: ReturnType<typeof setTimeout> | null;
    /** 条目创建/复验时的数据版本（revision 漂移触发 stat 复验）。 */
    revision: number;
    /** 解析时的 stat 快照：复验比对基准（文件重写则 size/modifiedAt 漂移）。 */
    size: number | null;
    modifiedAt: number | null;
    /** 已被失效摘出 map：等最后一个持有者 release 时立即撤销（防泄漏）。 */
    invalidated?: boolean;
}

/** LRU 上限：越界撤销最旧的零引用条目（32 个 blob 的常驻内存 = 解码缓存，
    字节本体由浏览器 blob registry 惰性分页，不等于全量内存占用）。 */
const URL_CACHE_LIMIT = 32;

/** 归零延迟撤销窗口（ms）：覆盖 FlatList 回收重挂/切屏往返的短窗。 */
const URL_REVOKE_DELAY_MS = 10_000;

/** 会话缓存（Map 迭代序 = 插入序，delete+set 实现 LRU 触碰）。 */
const urlCache = new Map<string, FileUrlCacheEntry>();

const WEB = Platform.OS === 'web';

/**
 * native 侧 key → file:// 路径的同步 memo（v0.5.2 堆叠切换修复面）：
 * web 有 urlCache 同步 peek（v0.4.4「换张零占位帧」），native 旧版每次
 * 挂载都要 await fileStorage.url(key) 的异步解析——deck 前卡按
 * key={media.id} 换张重挂，首帧恒经历 loading 占位底 → 真图，即用户报
 * 「每次切换都会刷新一下」的 native 病灶。file:// 路径是 key 的确定函数
 * （同 key 重写路径不变），故 memo 不随 revision 失效；上界 FIFO 防会话
 * 无界增长。失效口径诚实披露：文件被外部删除后 memo 仍返回旧路径，
 * 表现为破图而非 missing 态——本 App 的媒体删除只发生在块删除/行程删除
 * 之后（消费方已卸载，无挂载者），可达性极低，接受该降级（冷解析路径
 * 的 exists 检查仍是事实源，新挂载首见者走冷解析不受影响）。
 */
const NATIVE_URI_MEMO_LIMIT = 128;
const nativeUriMemo = new Map<string, string>();

/** 撤销条目的 blob 引用（幂等；native file:// 非 blob 直接跳过）。 */
function revokeEntryBlob(entry: FileUrlCacheEntry): void {
    if (entry.revokeTimer != null) {
        clearTimeout(entry.revokeTimer);
        entry.revokeTimer = null;
    }
    if (entry.uri.startsWith('blob:')) {
        fileStorage.revokeUrl(entry.uri);
    }
}

/** 引用归零的撤销路径：失效条目立即撤销；活跃缓存条目延迟撤销（重挂快路径）。 */
function releaseEntry(entry: FileUrlCacheEntry): void {
    entry.refCount = Math.max(entry.refCount - 1, 0);
    if (entry.refCount > 0) return;
    if (entry.invalidated) {
        // 已失效摘出（同 key 内容变更）：没有复用价值，立即撤销防泄漏
        revokeEntryBlob(entry);
        return;
    }
    // 幂等：已有挂起撤销就不重复排（并发 release/adopt 竞态下安全）
    if (entry.revokeTimer != null) return;
    entry.revokeTimer = setTimeout(() => {
        entry.revokeTimer = null;
        revokeEntryBlob(entry);
    }, URL_REVOKE_DELAY_MS);
}

/**
 * 失效摘出：条目移出缓存（后续 acquire 不再命中）。仍有存活消费者时**不得
 * 立即 revoke**（缩略图 + 全屏查看器同 key 并挂是常态）——撤销移交最后一
 * 次 releaseEntry（invalidated 标记）；零引用时立即撤销。
 */
function invalidateEntry(key: string, entry: FileUrlCacheEntry): void {
    urlCache.delete(key);
    if (entry.refCount > 0) {
        entry.invalidated = true;
        if (entry.revokeTimer != null) {
            clearTimeout(entry.revokeTimer);
            entry.revokeTimer = null;
        }
        return;
    }
    revokeEntryBlob(entry);
}

/** LRU 越界逐出：从最旧端撤销首个零引用条目；全部活跃则停止（引用安全优先）。 */
function evictOverflow(): void {
    while (urlCache.size > URL_CACHE_LIMIT) {
        let evicted = false;
        for (const [evictKey, candidate] of urlCache) {
            if (candidate.refCount <= 0) {
                urlCache.delete(evictKey);
                revokeEntryBlob(candidate);
                evicted = true;
                break;
            }
        }
        if (!evicted) return;
    }
}

/** 缓存命中采用：计数 +1、取消挂起撤销、刷新 LRU 位次。 */
function adoptCachedEntry(key: string, entry: FileUrlCacheEntry): { uri: string; release(): void } {
    entry.refCount += 1;
    if (entry.revokeTimer != null) {
        clearTimeout(entry.revokeTimer);
        entry.revokeTimer = null;
    }
    urlCache.delete(key);
    urlCache.set(key, entry);
    return { uri: entry.uri, release: () => releaseEntry(entry) };
}

/**
 * 首渲染同步 peek：
 * - native：直接查 nativeUriMemo（路径解析 O(1) 且稳定，见其注）；
 * - web：未失效条目**乐观信任既有 URI**，含 revision 漂移的场景——旧口径
 *   要求 `entry.revision === revision` 才命中，于是「打字触发的每次自动保存
 *   bump revision 后，第一次切堆叠」新挂载的前卡/露边层 peek 必 miss →
 *   LOADING 占位帧（v0.4.4 修的「切换刷新一下」只修了同 revision 的一半）。
 *   乐观读的代价：blob 仍有效（内容未变则续用；同 key 真被重写时旧 blob 是
 *   旧内容快照，acquire 的 stat 复验完成即 setState 换新 uri 自愈）——最坏
 *   一帧旧图，好过一帧占位底；「防 URI 串位」在换 key 场景不受影响（peek
 *   按 key 查询）。引用归零、撤销挂起中的条目同理可信任（10s 窗口 vs 毫秒
 *   级 effect 时序；即便真踩中，acquire 冷解析后自愈）。
 */
function peekCachedUrl(key: string, revision: number): string | null {
    if (!WEB) return nativeUriMemo.get(key) ?? null;
    void revision; // 乐观读不比 revision：复验由 acquire 的 stat 通道收口（见注）
    const entry = urlCache.get(key);
    if (!entry || entry.invalidated) {
        return null;
    }
    return entry.uri;
}

/**
 * key → 可渲染 URI 的引用获取（与返回的 release() 严格配对）。
 * 命中快路径零读取；revision 漂移时 O(1) stat 复验决定复用或重解析；
 * 失败（缺文件等）reject，由调用方转 missing 态。
 */
async function acquireFileUrl(key: string, revision: number): Promise<{ uri: string; release(): void }> {
    if (!WEB) {
        // native：file:// 直路径 O(1)，无缓存对象（路径字符串本身即可复用）。
        // v0.5.2 起路径进 nativeUriMemo：peek 同步命中 + 重复挂载免 await
        const memo = nativeUriMemo.get(key);
        if (memo != null) {
            return { uri: memo, release: () => undefined };
        }
        const uri = await fileStorage.url(key);
        nativeUriMemo.set(key, uri);
        if (nativeUriMemo.size > NATIVE_URI_MEMO_LIMIT) {
            // FIFO 摘最旧（Map 插入序）：native 路径字符串零字节成本，上限
            // 只防会话无界增长，摘除无资源回收语义
            const oldest = nativeUriMemo.keys().next().value;
            if (oldest != null) nativeUriMemo.delete(oldest);
        }
        return { uri, release: () => undefined };
    }
    const cached = urlCache.get(key);
    if (cached) {
        if (cached.revision === revision) {
            return adoptCachedEntry(key, cached);
        }
        // revision 漂移（任何 store mutation 后都会广播）：stat 复验，仅当
        // 内容真变更（同 key 重写/删除）才失效——无关 mutation（改文字、
        // 上传其他媒体）不触发重读，保住时间线全量媒体的零重读
        const info = await fileStorage.stat(key).catch(() => null);
        if (info && info.size === cached.size && info.modifiedAt === cached.modifiedAt) {
            cached.revision = revision;
            return adoptCachedEntry(key, cached);
        }
        invalidateEntry(key, cached);
    }
    // 冷解析：web 走零拷贝 getFile → createObjectURL（O(1) 句柄级，无字节
    // 搬运），stat 快照供后续复验。stat 与 url 之间的极小窗口若恰逢同 key
    // 重写，快照反映新内容、blob 是旧快照——下次 revision 复验自愈，注释
    // 在案（并发写同 key 本就是被 createWritable 独占锁串行化的罕见路径）。
    const uri = await fileStorage.url(key);
    const info = await fileStorage.stat(key).catch(() => null);
    const entry: FileUrlCacheEntry = {
        uri,
        refCount: 1,
        revokeTimer: null,
        revision,
        size: info?.size ?? null,
        modifiedAt: info?.modifiedAt ?? null,
    };
    urlCache.set(key, entry);
    evictOverflow();
    return { uri, release: () => releaseEntry(entry) };
}

const LOADING_STATE: FileUrlState = { status: 'loading', uri: null };
const MISSING_STATE: FileUrlState = { status: 'missing', uri: null };

/** useFileUrl 的三态版本：媒体块需要区分「解析中」与「解析失败」两态时用。 */
export function useFileUrlState(key: string | null): FileUrlState {
    const revision = useDataRevision();
    // 首渲染同步快路径：会话缓存有效命中（同 revision、引用中）直接 ready，
    // FlatList 回收重挂/切屏回来不闪占位底（initializer 与 effect 的 acquire
    // 各自独立，引用计数由 effect 收口）
    const [state, setState] = useState<FileUrlState>(() =>
        nextFileUrlState(LOADING_STATE, key, key ? peekCachedUrl(key, revision) : null),
    );
    // 换 key 的派生在**渲染期同步**完成（React 派生态调整模式）：deck 换张的
    // 新前卡（原邻卡）URI 恒在会话缓存里，命中即 ready——不再经过「先 LOADING
    // 一帧 → 异步 acquire」的占位闪烁（v0.4.4 用户反馈「切换堆叠会刷新/加载
    // 一下」的根因）。同 key 的 revision 复验不清回 loading（保持已就绪画面
    // 静默换源），防 URI 串位的职责由「仅换 key 才派生」承担
    const prevKeyRef = useRef<string | null>(null);
    if (prevKeyRef.current !== key) {
        prevKeyRef.current = key;
        const next = nextFileUrlState(state, key, key ? peekCachedUrl(key, revision) : null);
        if (next !== state) setState(next);
    }

    useEffect(() => {
        if (!key) {
            // 无 key = 无媒体行数据，直接按缺失处理（与 catch 分支同降级）
            setState(MISSING_STATE);
            return;
        }
        let active = true;
        let handle: { release(): void } | null = null;
        acquireFileUrl(key, revision)
            .then((acquired) => {
                if (!active) {
                    // 竞态兜底：解析完成前 effect 已被换 key/卸载取代——立即
                    // 归还引用，防引用计数悬挂导致 blob 延迟泄漏
                    acquired.release();
                    return;
                }
                handle = acquired;
                // 同 URI 幂等（引用稳定）：revision 复验复用既有条目时不触发
                // 多余重渲（nextFileUrlState 返回 prev 本体）
                setState((prev) => nextFileUrlState(prev, key, acquired.uri));
            })
            .catch(() => {
                // 缺文件时静默置空是安全的：媒体行在、二进制缺失属可自愈状态
                if (active) setState(MISSING_STATE);
            });
        return () => {
            active = false;
            handle?.release();
        };
    }, [key, revision]);

    return state;
}

/**
 * file-storage key → 可渲染 URI（native: file://，web: blob:）。
 * blob 生命周期由会话缓存层接管（引用计数归零延迟撤销）；读取失败按空处理
 * （缺文件的缩略图降级为空白，属文档化降级：文件删除/损坏不应打断时间线浏览）。
 *
 * 兼容薄包装：既有消费者只关心 uri；需要区分加载/失败态的媒体块用 useFileUrlState。
 */
export function useFileUrl(key: string | null): string | null {
    return useFileUrlState(key).uri;
}

/**
 * 预热（v0.4.4 deck 邻卡）：acquire 后立即 release——条目留在会话缓存
 * （引用计数 0 + 延迟撤销），消费方换 key 首渲染 peek 命中即 ready（同步
 * 路径），不再有 LOADING 占位帧。失败静默（预热是增强，非数据依赖）。
 */
export function prewarmFileUrl(key: string, revision: number): void {
    if (!key) return;
    void acquireFileUrl(key, revision)
        .then((acquired) => acquired.release())
        .catch(() => undefined);
}

/**
 * 已预热档位表（v0.4.7）：key = `fileKey|revision|w×h`（尺寸取整到 2px 档，
 * 同档复用）。FIFO 上限防会话内无界增长。意义：连翻时邻卡变化 effect 反复
 * 重排预热不再重复排解码（同 (key,档位) 只解一次），于是去抖窗可以缩短到
 * 「一次转场收口之后」——v0.4.6 的 1000ms 长窗在连滑节奏（~450ms/张）下
 * 永远等不到预热落地，每次收口帧都在现场解码，正是「滑动切换时加载图片
 * 卡一下」的直接病灶；去重后 350ms 短窗连滑期也能命中。
 */
const WARMED_DECODE_LIMIT = 64;
const warmedDecodes = new Set<string>();

/**
 * 邻卡位图预解码（v0.4.6 性能红线，web-only）：prewarmFileUrl 只预热 blob
 * URL——换张收口帧首次绘制新位图仍要付解码/降采样的主线程成本（CDP 实测
 * 图片堆收口帧 88ms 帧距的落点）。本函数把解码挪进空闲窗：离屏 <img> 按
 * 目标显示尺寸（决定 Chromium 的 decode-time downscale 档位）requestIdleCallback
 * 排期 decode()，换张帧命中同源位图缓存只剩绘制。
 * 持有引用直到解码收口（防延迟撤销打断），失败静默（预热是增强——失败时
 * 从表里摘除，下次调用可重试）。native 直接 no-op：位图管线由原生层自管，
 * JS 侧无解码帧可挪。
 */
export function prewarmImageDecode(
    key: string,
    revision: number,
    width: number,
    height: number,
): void {
    if (!WEB || !key || !(width > 0) || !(height > 0)) return;
    const bucket = `${key}|${revision}|${Math.ceil(width / 2) * 2}x${Math.ceil(height / 2) * 2}`;
    if (warmedDecodes.has(bucket)) return;
    warmedDecodes.add(bucket);
    if (warmedDecodes.size > WARMED_DECODE_LIMIT) {
        // FIFO：Map 式插入序在 Set 上成立，摘最旧（重挂旧卡时最多重解一次）
        const oldest = warmedDecodes.values().next().value;
        if (oldest != null) warmedDecodes.delete(oldest);
    }
    void acquireFileUrl(key, revision)
        .then(({ uri, release }) => {
            const img = new window.Image();
            img.decoding = 'async';
            // 目标尺寸预置：detached 元素不参与布局，仅作为解码降采样的档位提示
            img.width = Math.ceil(width);
            img.height = Math.ceil(height);
            img.src = uri;
            const run = () =>
                img.decode().then(release, () => {
                    // 解码失败：摘除档位记忆，允许后续邻卡变化时重试
                    warmedDecodes.delete(bucket);
                    release();
                });
            if (typeof window.requestIdleCallback === 'function') {
                // timeout 兜底（v0.4.7 纵向滚动修复配套）：无 timeout 的 rIC 在
                // 繁忙页面里可能永不触发——预热不落地 = 滚动首现解码回来了
                // （CDP 高载复测实证 r1/r3 长任务回潮）。2.5s 上限把「空闲才解」
                // 换成「最迟 2.5s 解」，仍远离交互帧（滚轮 burst 在挂载 2.5s 后
                // 才可能开始，且单段解码 ≤~90ms、不在事件回调里连发）
                window.requestIdleCallback(() => run(), { timeout: 2500 });
            } else {
                setTimeout(run, 200);
            }
        })
        .catch(() => {
            warmedDecodes.delete(bucket);
        });
}

/**
 * web 视频头字节预热（v0.5.2 堆叠预载的「播放器预热」web 退化实现）：
 * detached `<video preload="auto">` 让媒体管线开抓字节，收到首段数据
 * （loadeddata）或出错即断源释放——真正的前卡 <video> 后挂时命中浏览器
 * 媒体缓存。native 播放器预建**不做**：deck 前卡按 key={media.id} 换张
 * 重挂、各自 useVideoPlayer 建实例（v0.4.6 错内容闪帧的既定取舍），预建
 * 独立实例既交接不进消费卡又违背「每堆 ≤1 player」性能红线，native 视频
 * 的预热收益落在 poster（缩略图走 expo-image prefetch，见下）。
 */
function warmVideoBytesWeb(uri: string): void {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
        return;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.src = uri;
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeAttribute('src');
        video.load();
    };
    const timer = setTimeout(settle, 15_000);
    video.addEventListener('loadeddata', settle, { once: true });
    video.addEventListener('error', settle, { once: true });
}

/**
 * deck 预载执行面（v0.5.2 用户令 6，调度纯函数见 ui/deck-prefetch.ts）：
 * 对一个堆叠成员做「可安全提前做」的全部预热，重复调用幂等（各层自带去重）：
 * - **native**：①acquire uri → 写 nativeUriMemo（换张重挂的 peek 同步命中，
 *   首帧不再经历 await fileStorage.url 的 loading 占位——「每次切换刷新
 *   一下」的 native 主病灶）；②图片（含视频 poster）走 expo-image 静态
 *   prefetch 热其原生解码/内存缓存——deck 卡体已换用 expo-image 渲染，
 *   **渲染器与预取共用同一套原生缓存**，预取真实命中（RN Image 的 Fresco/
 *   RCTImageLoader 缓存 expo-image prefetch 打不进，这正是换渲染器的原因）。
 * - **web**：prewarmFileUrl 热 blob 句柄（render-phase peek 同步 ready）+
 *   位图解码档由调用方在去抖窗走 prewarmImageDecode（raster 预算纪律，
 *   v0.4.6/0.4.7 原口径不变）；视频字节经 warmVideoBytesWeb。
 * - **视频（native）player 预建不做**，理由见 warmVideoBytesWeb 注。
 * 内存账：web blob 由 urlCache 引用计数 + 10s 延迟撤销 + LRU(32) 收口
 * （预取 acquire 即 release，留延迟撤销窗——窗口淘汰不 revoke 在用者）；
 * native memo 只存路径字符串（上限 FIFO）；expo-image 缓存由其内部上界管理。
 * 一切失败静默（预载是增强，不是数据依赖）。
 */
export function prefetchDeckMedia(
    kind: 'image' | 'video',
    fileKey: string,
    revision: number,
): void {
    if (!fileKey) return;
    // poster key = `${fileKey}.thumb.jpg`（与 store.videoThumbKeyFor 对向镜像的
    // 第三处——ui 层禁 import store，media-view.videoThumbKeyFor 为对向镜像，
    // 格式串必须三侧锁步修改）
    const posterKey = kind === 'video' ? `${fileKey}.thumb.jpg` : null;
    if (!WEB) {
        // expo-image 静态 prefetch（模块级实现，非 hook 消费面）：热其原生
        // 解码/内存缓存——deck 卡体同一渲染栈，预取真实命中
        const prefetchImages = (uris: string[]) => {
            try {
                void ExpoImage.prefetch?.(uris).catch(() => undefined);
            } catch {
                // 个别宿主缺失静态方法：预载失败不影响按需加载兜底
            }
        };
        void acquireFileUrl(fileKey, revision)
            .then(({ uri, release }) => {
                release();
                prefetchImages([uri]);
            })
            .catch(() => undefined);
        if (posterKey) {
            void acquireFileUrl(posterKey, revision)
                .then(({ uri, release }) => {
                    release();
                    prefetchImages([uri]);
                })
                .catch(() => undefined);
        }
        return;
    }
    prewarmFileUrl(fileKey, revision);
    if (posterKey) {
        prewarmFileUrl(posterKey, revision);
    }
    if (kind === 'video') {
        void acquireFileUrl(fileKey, revision)
            .then(({ uri, release }) => {
                warmVideoBytesWeb(uri);
                release();
            })
            .catch(() => undefined);
    }
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
