import { PostError } from './errors';

export { PostError, type PostErrorCode } from './errors';

/**
 * 通用 POST 接口：JSON 收发 + 超时控制，与业务无关——URL 与鉴权头由调用方注入。
 * 非 2xx 抛 `post/http`；网络失败/超时抛 `post/network`（retryable）。
 * 响应体优先 JSON.parse，解析失败保留原始文本（调用方自行按内容类型处理）。
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PostOptions {
    /** 附加请求头（鉴权等）；Content-Type 由 body 自动带出 */
    headers?: Record<string, string>;
    /** 超时毫秒数，默认 15s */
    timeoutMs?: number;
}

export interface PostResult<T> {
    status: number;
    data: T;
}

export async function post<T = unknown>(
    url: string,
    body?: unknown,
    options: PostOptions = {},
): Promise<PostResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers,
            },
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new PostError('post/http', `post(${url}): HTTP ${response.status}`);
        }
        const text = await response.text();
        let data: unknown = text;
        if (text.length > 0) {
            try {
                data = JSON.parse(text);
            } catch {
                // 非 JSON 响应按原始文本返回，由调用方按内容类型处理
            }
        }
        return { status: response.status, data: data as T };
    } catch (error) {
        if (error instanceof PostError) throw error;
        throw new PostError('post/network', `post(${url}) 请求失败`, error, true);
    } finally {
        clearTimeout(timer);
    }
}
