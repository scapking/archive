import { gcm } from '@noble/ciphers/aes.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import * as ExpoCrypto from 'expo-crypto';
import { CodedError } from 'expo-modules-core';

/**
 * 加密接口：AES-256-GCM（认证加密）+ PBKDF2 密钥派生。
 *
 * 为什么不用 WebCrypto subtle：Hermes/RN 未提供完整 WebCrypto，
 * 因此三端统一走 @noble/ciphers + @noble/hashes（零依赖、经审计的纯 JS 实现），
 * 同一密文三端可互解。
 *
 * 信封格式：nonce(12B) || ciphertext || tag(16B)。
 * 密钥是原始 32 字节；不要硬编码在代码里——来自 config-store 的 secure 字段
 * 或由 deriveKey 从口令派生。
 */
export const KEY_BYTES = 32;
export const NONCE_BYTES = 12;
/** OWASP 推荐的 PBKDF2-SHA256 迭代次数下限 */
export const PBKDF2_ITERATIONS = 310_000;

/**
 * 加密模块的类型化错误（H11：core 运行时错误必须是 CodedError 子类）。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约；此处各 kind
 * 均为确定性输入/参数错误，重试必然复现，retryable 一律 false。
 */
export type CryptoErrorCode =
    | 'crypto/weak-params'
    | 'crypto/invalid-envelope'
    | 'crypto/invalid-key'
    | 'crypto/invalid-base64';

export class CryptoError extends CodedError {
    readonly cause?: unknown;
    readonly retryable: boolean;

    constructor(code: CryptoErrorCode, message: string, cause?: unknown, retryable = false) {
        super(code, message);
        this.name = 'CryptoError';
        this.cause = cause;
        this.retryable = retryable;
    }
}

/** 生成 256 位对称密钥（加密安全随机）。 */
export async function generateKey(): Promise<Uint8Array> {
    return ExpoCrypto.getRandomBytesAsync(KEY_BYTES);
}

/**
 * 从口令派生密钥（PBKDF2-SHA256）。同一 password+salt+iterations 三端派生结果一致。
 * salt 应随机且固定存储（可与密文一起保存）。
 */
export async function deriveKey(
    password: string,
    salt: string | Uint8Array,
    iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
    if (iterations < 10_000) {
        throw new CryptoError('crypto/weak-params', `crypto.deriveKey: iterations 过低（${iterations}），至少 10_000`);
    }
    return pbkdf2Async(sha256, password, salt, { c: iterations, dkLen: KEY_BYTES });
}

/** 加密字节或 UTF-8 文本；返回 nonce||ciphertext||tag 信封。aad 参与认证但不加密。 */
export async function encrypt(
    key: Uint8Array,
    plaintext: Uint8Array | string,
    aad?: Uint8Array,
): Promise<Uint8Array> {
    assertKey(key);
    const nonce = ExpoCrypto.getRandomBytes(NONCE_BYTES);
    const data = typeof plaintext === 'string' ? utf8ToBytes(plaintext) : plaintext;
    const sealed = gcm(key, nonce, aad).encrypt(data);
    return concat(nonce, sealed);
}

/** 解密信封；密钥/aad 不匹配或密文被篡改时抛错（GCM 认证失败）。 */
export async function decrypt(
    key: Uint8Array,
    envelope: Uint8Array,
    aad?: Uint8Array,
): Promise<Uint8Array> {
    assertKey(key);
    if (envelope.length <= NONCE_BYTES) {
        throw new CryptoError('crypto/invalid-envelope', 'crypto.decrypt: 信封长度不合法（缺少 nonce 或密文）');
    }
    const nonce = envelope.slice(0, NONCE_BYTES);
    const sealed = envelope.slice(NONCE_BYTES);
    return gcm(key, nonce, aad).decrypt(sealed);
}

/** 加密文本 → base64 信封（可直接存入 config-store / data-store）。 */
export async function encryptText(key: Uint8Array, plaintext: string, aad?: Uint8Array): Promise<string> {
    return bytesToBase64(await encrypt(key, plaintext, aad));
}

/** base64 信封 → 文本。 */
export async function decryptText(key: Uint8Array, envelopeBase64: string, aad?: Uint8Array): Promise<string> {
    return bytesToUtf8(await decrypt(key, base64ToBytes(envelopeBase64), aad));
}

function assertKey(key: Uint8Array): void {
    if (key.length !== KEY_BYTES) {
        throw new CryptoError('crypto/invalid-key', `crypto: 密钥必须为 ${KEY_BYTES} 字节（AES-256），收到 ${key.length}`);
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function utf8ToBytes(text: string): Uint8Array {
    return utf8Encoder.encode(text);
}

function bytesToUtf8(bytes: Uint8Array): string {
    return utf8Decoder.decode(bytes);
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 字节 → base64（标准字母表 + padding）。导出供同层模块复用。 */
export function bytesToBase64(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i];
        const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += BASE64_ALPHABET[b0 >> 2];
        out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
        out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
        out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
    }
    return out;
}

const BASE64_LOOKUP = new Map<string, number>(
    [...BASE64_ALPHABET].map((char, index) => [char, index] as const),
);

/** base64 → 字节（接受 padding）。导出供同层模块复用。 */
export function base64ToBytes(text: string): Uint8Array {
    const clean = text.replace(/=+$/, '');
    if (clean.length % 4 === 1) {
        throw new CryptoError('crypto/invalid-base64', 'crypto: base64 长度不合法');
    }
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let offset = 0;
    let buffer = 0;
    let bits = 0;
    for (const char of clean) {
        const value = BASE64_LOOKUP.get(char);
        if (value === undefined) throw new CryptoError('crypto/invalid-base64', `crypto: base64 含非法字符 "${char}"`);
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[offset++] = (buffer >> bits) & 0xff;
        }
    }
    return out.slice(0, offset);
}
