import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import { bytesToBase64, base64ToBytes } from '@/core/crypto';
import { ConfigStorageError } from './errors';

export type SecureStorageErrorHandler = (error: ConfigStorageError) => void;

/**
 * 字段级加密配置存储。
 *
 * 非敏感字段整体存 AsyncStorage（一个 JSON 文档）；列在 secureKeys 里的字段：
 * - native：逐个走系统加密存储（iOS Keychain / Android Keystore，expo-secure-store）；
 * - web：浏览器没有系统级密钥库，用 WebCrypto 非导出 AES-GCM 密钥加密后存 localStorage。
 *   密钥生成时 extractable=false 且只存 IndexedDB——XSS 可以"用"钥匙但拿不走钥匙，
 *   这是 web 端能做到的最强本地保密（详见 docs/platform-parity.md）。
 *
 * 错误纪律（error-handling.md R3）：所有存储失败先经 onError 上报再重抛；
 * web 端凭据解密失败（corrupt）上报后按字段缺失降级——配置读取不允许让 app 崩溃，
 * 但绝不允许无信号的数据丢失。
 */
export function createSecureFieldStorage<T extends object>(
    name: string,
    secureKeys: Array<keyof T & string>,
    onError: SecureStorageErrorHandler = () => undefined,
): PersistStorage<T> {
    const documentKey = name;
    // SecureStore 的 key 只允许 [A-Za-z0-9.\-_]，用 `.` 连接，恰好符合 naming.md §4 的存储 key 规范
    const secureFieldKey = (field: string) => `${name}.${field}`;

    const isWeb = Platform.OS === 'web';

    async function readSecureFields(): Promise<Partial<T>> {
        const fields: Record<string, unknown> = {};
        for (const field of secureKeys) {
            const key = secureFieldKey(field);
            try {
                const raw = isWeb ? await readWebValue(key, onError) : await SecureStore.getItemAsync(key);
                if (raw !== null) fields[field] = JSON.parse(raw);
            } catch (error) {
                onError(new ConfigStorageError('config-store/read', `读取 secure 字段失败（${key}）`, error));
                throw error;
            }
        }
        return fields as Partial<T>;
    }

    async function writeSecureFields(state: T): Promise<void> {
        for (const field of secureKeys) {
            const key = secureFieldKey(field);
            const value = state[field];
            try {
                if (value === undefined) {
                    // stripSecureFields 会把 undefined 字段从 AsyncStorage 文档剔除，
                    // 底层值若不显式删除，下次 getItem 又会合并回来——「清空凭据」静默复活
                    if (isWeb) globalThis.localStorage?.removeItem(key);
                    else await SecureStore.deleteItemAsync(key);
                    continue;
                }
                const raw = JSON.stringify(value);
                if (isWeb) await writeWebValue(key, raw, onError);
                else await SecureStore.setItemAsync(key, raw);
            } catch (error) {
                onError(new ConfigStorageError('config-store/write', `写入 secure 字段失败（${key}）`, error));
                throw error;
            }
        }
    }

    async function removeSecureFields(): Promise<void> {
        for (const field of secureKeys) {
            const key = secureFieldKey(field);
            try {
                if (isWeb) globalThis.localStorage?.removeItem(key);
                else await SecureStore.deleteItemAsync(key);
            } catch (error) {
                onError(new ConfigStorageError('config-store/write', `删除 secure 字段失败（${key}）`, error));
                throw error;
            }
        }
    }

    function stripSecureFields(state: T | undefined): Partial<T> {
        if (!state) return {};
        const rest: Record<string, unknown> = {};
        for (const [field, value] of Object.entries(state)) {
            if (!secureKeys.includes(field as keyof T & string)) rest[field] = value;
        }
        return rest as Partial<T>;
    }

    return {
        async getItem(): Promise<StorageValue<T> | null> {
            try {
                const raw = await AsyncStorage.getItem(documentKey);
                const base = raw ? (JSON.parse(raw) as StorageValue<T>) : null;
                const secureFields = await readSecureFields();
                const hasSecure = Object.keys(secureFields).length > 0;
                if (!base && !hasSecure) return null;
                // 敏感字段单独合并，避免首次运行时用默认空值覆盖已有凭据
                return {
                    state: { ...base?.state, ...secureFields } as T,
                    version: base?.version ?? 0,
                };
            } catch (error) {
                onError(new ConfigStorageError('config-store/read', `读取配置文档失败（${documentKey}）`, error));
                throw error;
            }
        },
        async setItem(_name: string, storageValue: StorageValue<T>): Promise<void> {
            try {
                await AsyncStorage.setItem(
                    documentKey,
                    JSON.stringify({
                        state: stripSecureFields(storageValue.state),
                        version: storageValue.version,
                    }),
                );
            } catch (error) {
                onError(new ConfigStorageError('config-store/write', `写入配置文档失败（${documentKey}）`, error));
                throw error;
            }
            await writeSecureFields(storageValue.state);
        },
        async removeItem(_name: string): Promise<void> {
            try {
                await AsyncStorage.removeItem(documentKey);
            } catch (error) {
                onError(new ConfigStorageError('config-store/write', `删除配置文档失败（${documentKey}）`, error));
                throw error;
            }
            await removeSecureFields();
        },
    };
}

// ---------- web 端：非导出 AES-GCM 密钥 + IndexedDB 密钥保管 ----------

const WEB_ENVELOPE_PREFIX = 'enc.v1:';
const KEY_DB_NAME = 'core.secure-keys';
const KEY_DB_STORE = 'keys';
const KEY_RECORD_ID = 'config';

let webKeyPromise: Promise<CryptoKey | null> | null = null;

function getWebSubtle(): SubtleCrypto | null {
    return globalThis.crypto?.subtle ?? null;
}

async function openKeyDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(KEY_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(KEY_DB_STORE)) {
                request.result.createObjectStore(KEY_DB_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function idbRequest<T>(store: IDBObjectStore, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
        const transaction = store.transaction;
        const request = run(store);
        transaction.oncomplete = () => resolve(request.result as T);
        transaction.onerror = () => reject(transaction.error);
    });
}

/** 取（或首次生成）非导出 AES-GCM 密钥；环境不支持时返回 null（调用方退化为明文）。 */
async function getWebKey(onError: SecureStorageErrorHandler): Promise<CryptoKey | null> {
    const subtle = getWebSubtle();
    if (!subtle || globalThis.indexedDB === undefined) return null;
    webKeyPromise ??= (async () => {
        const db = await openKeyDatabase();
        const store = db.transaction(KEY_DB_STORE, 'readonly').objectStore(KEY_DB_STORE);
        const existing = await idbRequest<CryptoKey | undefined>(store, 'readonly', (s) => s.get(KEY_RECORD_ID));
        if (existing) return existing;
        const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const writeStore = db.transaction(KEY_DB_STORE, 'readwrite').objectStore(KEY_DB_STORE);
        await idbRequest<void>(writeStore, 'readwrite', (s) => s.put(key, KEY_RECORD_ID));
        return key;
    })().catch((error) => {
        onError(new ConfigStorageError('config-store/write', 'web 加密密钥初始化失败，退化为明文存储', error));
        return null;
    });
    return webKeyPromise;
}

async function readWebValue(key: string, onError: SecureStorageErrorHandler): Promise<string | null> {
    const raw = globalThis.localStorage?.getItem(key) ?? null;
    if (raw === null) return null;
    if (!raw.startsWith(WEB_ENVELOPE_PREFIX)) return raw; // 旧明文值，原样返回
    const webKey = await getWebKey(onError);
    if (!webKey) return null; // 有密文但环境不支持解密：上报后视为缺失
    try {
        const bytes = base64ToBytes(raw.slice(WEB_ENVELOPE_PREFIX.length));
        const iv = bytes.slice(0, 12);
        const ciphertext = bytes.slice(12);
        const plain = await getWebSubtle()!.decrypt({ name: 'AES-GCM', iv }, webKey, ciphertext);
        return new TextDecoder().decode(plain);
    } catch (error) {
        // corrupt：降级为缺失（配置读取不允许崩溃），但必须上报——这是无信号数据丢失的防线
        onError(new ConfigStorageError('config-store/corrupt', `web 凭据解密失败，按缺失处理（${key}）`, error));
        return null;
    }
}

async function writeWebValue(key: string, plaintext: string, onError: SecureStorageErrorHandler): Promise<void> {
    const webKey = await getWebKey(onError);
    if (!webKey) {
        globalThis.localStorage?.setItem(key, plaintext);
        return;
    }
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await getWebSubtle()!.encrypt(
        { name: 'AES-GCM', iv },
        webKey,
        new TextEncoder().encode(plaintext),
    );
    const envelope = new Uint8Array(iv.length + ciphertext.byteLength);
    envelope.set(iv, 0);
    envelope.set(new Uint8Array(ciphertext), iv.length);
    globalThis.localStorage?.setItem(key, WEB_ENVELOPE_PREFIX + bytesToBase64(envelope));
}
