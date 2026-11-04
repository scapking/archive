import { CodedError } from 'expo-modules-core';

/**
 * config-store 存储层的类型化错误（读写 AsyncStorage / SecureStore / web 加密信封失败）。
 * code 遵循 error-handling.md 的 `<capability>/<kind>` 契约。
 *
 * zustand persist 会吞掉存储层的写入 rejection，因此 config-store 的所有存储操作
 * 失败时必须先经 onError 上报（createConfigStore 的 options），再重抛。
 */
export type ConfigStorageErrorCode = 'config-store/read' | 'config-store/write' | 'config-store/corrupt';

export class ConfigStorageError extends CodedError {
    readonly cause?: unknown;

    constructor(code: ConfigStorageErrorCode, message: string, cause?: unknown) {
        super(code, message);
        this.name = 'ConfigStorageError';
        this.cause = cause;
    }
}
