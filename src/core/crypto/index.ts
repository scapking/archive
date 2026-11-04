import * as Crypto from 'expo-crypto';

export * from './encryption';

/**
 * 通用加密/随机接口（expo-crypto，三端走 WebCrypto 语义）。
 * 薄封装：不吞错误，底层 CodedError 原样抛出。
 */
export const crypto = {
    /** RFC 4122 v4 UUID。 */
    randomUUID: Crypto.randomUUID,

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
