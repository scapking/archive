import * as Crypto from 'expo-crypto';

export * from './encryption';

/**
 * 用随机字节按 RFC 4122 v4 规范拼出 UUID：
 * byte[6] 高 4 位置 0x40 标记版本 4，byte[8] 高 2 位置 0x80 标记 RFC 4122 变体，
 * 再按 8-4-4-4-12 段十六进制格式化。
 */
function formatUuidV4FromBytes(bytes: Uint8Array): string {
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    // 128 位即 32 个十六进制字符，按 8-4-4-4-12 分段。
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 通用加密/随机接口（expo-crypto，三端走 WebCrypto 语义）。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const crypto = {
    /**
     * RFC 4122 v4 UUID。
     * 兜底：web 端非安全上下文（如经 LAN IP 的 http://192.168.x.x:8081）
     * 没有 crypto.randomUUID，expo-crypto 的转发实现会抛 TypeError；
     * 而同场景下 getRandomValues 不受该限制，故抛错时改用它手拼 v4 UUID。
     */
    randomUUID: (): string => {
        // 优先走 expo-crypto 原生实现（native 与 web 安全上下文的正常路径）。
        try {
            return Crypto.randomUUID();
        } catch {
            return formatUuidV4FromBytes(Crypto.getRandomValues(new Uint8Array(16)));
        }
    },

    /** 加密安全随机字节。 */
    getRandomBytesAsync: Crypto.getRandomBytesAsync,

    /** 填充给定的 TypedArray（对齐 WebCrypto getRandomValues）。 */
    getRandomValues: Crypto.getRandomValues,

    /** 对字符串做摘要（SHA-256 等），返回 hex 编码。 */
    digestStringAsync: Crypto.digestStringAsync,

    /** 对二进制数据做摘要，返回 ArrayBuffer。 */
    digest: Crypto.digest,
};

export type { CryptoDigestAlgorithm, CryptoDigestOptions, Digest } from 'expo-crypto';
