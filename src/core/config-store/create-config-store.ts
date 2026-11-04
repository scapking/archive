import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { createSecureFieldStorage, type SecureStorageErrorHandler } from './secure-storage';
import { ConfigStorageError } from './errors';

export interface ConfigStoreOptions<T> {
    /**
     * 需要加密存储的字段名（凭据类：key / token / secret / password）。
     * native 走 SecureStore（Keychain / Keystore），web 走非导出 AES-GCM 密钥加密。
     */
    secure?: Array<keyof T & string>;
    /**
     * 存储层错误上报钩子。zustand persist 会吞掉存储层的 rejection，
     * 想感知"配置没存上/凭据解密失败"必须提供此回调（上报后错误仍会重抛）。
     */
    onError?: SecureStorageErrorHandler;
}

export function createConfigStore<T extends object>(
    name: string,
    defaults: T,
    options: ConfigStoreOptions<T> = {},
) {
    const secureKeys = options.secure ?? [];
    const onError: SecureStorageErrorHandler = (error) => {
        options.onError?.(error);
        if (!options.onError) {
            // 未接上报钩子时至少保证错误在控制台可见（error-handling.md R3：禁止静默吞错）
            console.warn(`[config-store] ${error.code}: ${error.message}`, error.cause);
        }
    };

    const storage: PersistStorage<T> =
        secureKeys.length > 0
            ? createSecureFieldStorage<T>(name, secureKeys, onError)
            : wrapPlainStorage(name, onError);

    const useConfig = create<T>()(
        persist(() => ({ ...defaults }), {
            name,
            storage,
        }),
    );

    return {
        use: useConfig,
        get: () => useConfig.getState(),
        update: (partial: Partial<T>) => useConfig.setState(partial),
        reset: () => useConfig.setState({ ...defaults }),
    };
}

/** 无 secure 字段时的存储：同样接上报钩子，保证读写失败有信号。 */
function wrapPlainStorage<T extends object>(name: string, onError: SecureStorageErrorHandler): PersistStorage<T> {
    return {
        async getItem() {
            try {
                const raw = await AsyncStorage.getItem(name);
                return raw ? (JSON.parse(raw) as StorageValue<T>) : null;
            } catch (error) {
                onError(new ConfigStorageError('config-store/read', `读取配置文档失败（${name}）`, error));
                throw error;
            }
        },
        async setItem(_name, value) {
            try {
                await AsyncStorage.setItem(name, JSON.stringify(value));
            } catch (error) {
                onError(new ConfigStorageError('config-store/write', `写入配置文档失败（${name}）`, error));
                throw error;
            }
        },
        async removeItem(_name) {
            try {
                await AsyncStorage.removeItem(name);
            } catch (error) {
                onError(new ConfigStorageError('config-store/write', `删除配置文档失败（${name}）`, error));
                throw error;
            }
        },
    };
}
