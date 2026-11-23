/**
 * file-storage key → 可渲染 URI 的**状态机纯函数**（v0.4.4，用户反馈「堆叠
 * 切换会刷新/加载一下」的修复面）：useFileUrlState 的派生逻辑收口于此，node
 * 测试直接覆盖。核心保证 = **换 key 时缓存命中同步 ready**——deck 换张的新
 * 前卡（原邻卡）URI 一定已在会话缓存里，换 key 不再经过 LOADING 占位帧。
 */

export type FileUrlStatus = 'loading' | 'ready' | 'missing';

export interface FileUrlState {
    status: FileUrlStatus;
    /** 仅 status === 'ready' 时非空；blob 生命周期由会话缓存层接管（见 use-file-url）。 */
    uri: string | null;
}

/** 模块级单例态（引用稳定 → React 可跳过无谓重渲）。 */
export const LOADING_FILE_URL_STATE: FileUrlState = { status: 'loading', uri: null };
export const MISSING_FILE_URL_STATE: FileUrlState = { status: 'missing', uri: null };

/**
 * 下一个渲染态：
 * - key 缺失 → missing（媒体行在、二进制缺失属可自愈降级，同 use-file-url 口径）；
 * - uri 未就绪（未命中缓存）→ loading；
 * - 同 uri（revision 复验复验命中）→ **返回 prev 本体**（引用稳定，不触发重渲）；
 * - 其余（新 uri / 换 key 命中缓存）→ ready 新 uri。
 */
export function nextFileUrlState(
    prev: FileUrlState,
    key: string | null,
    uri: string | null,
): FileUrlState {
    if (!key) return MISSING_FILE_URL_STATE;
    if (uri == null) return LOADING_FILE_URL_STATE;
    if (prev.status === 'ready' && prev.uri === uri) return prev;
    return { status: 'ready', uri };
}