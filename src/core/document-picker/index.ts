import * as DocumentPicker from 'expo-document-picker';
import { DocumentPickerError, type DocumentPickerErrorCode } from './errors';

/**
 * 系统文档选取接口（expo-document-picker，glossary §3 已登记）：
 * 用户从系统文件选取器挑一个文件（本域消费面 = 备份包导入）。
 *
 * 薄封装（error-handling.md R4）：不吞错误，底层 CodedError 原样透传；仅把
 * 「选取过程异常」归一为本能力的 pick 类型化错误（用户取消是正常路径——
 * canceled: true 返回，不作为异常）。三端口径：native 系统文档面板（默认
 * copyToCacheDirectory 产出 file:// URI）；web 走浏览器文件输入（uri 为
 * blob: 引用）——字节读取由调用方统一走 file-storage.readUriBytes。
 */
export interface PickedDocument {
    /** 本地可读 URI（native file:// / web blob:）。 */
    uri: string;
    /** 文件名（系统面板自带；web 为浏览器侧文件名）。 */
    name: string;
    /** 字节数（平台可能缺省）。 */
    size: number | null;
    /** MIME 类型（平台可能缺省）。 */
    mimeType: string | null;
}

export const documentPicker = {
    /**
     * 选取一个文件。type 为 MIME/扩展白名单（透传 expo-document-picker 的
     * `type` 选项，native 面板按它过滤；web 侧作为 accept 提示）。
     * 用户取消 → { canceled: true, document: null }。
     */
    async pickAsync(options?: {
        type?: string | string[];
    }): Promise<{ canceled: boolean; document: PickedDocument | null }> {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: options?.type ?? ['*/*'],
                multiple: false,
                // 默认拷贝到 cache：native 侧拿到稳定的 file:// URI（原始 uri 可能是
                // content://，File API 读不了）；字节读取统一走 readUriBytes
                copyToCacheDirectory: true,
            });
            if (result.canceled || result.assets.length === 0) {
                return { canceled: true, document: null };
            }
            const asset = result.assets[0];
            return {
                canceled: false,
                document: {
                    uri: asset.uri,
                    name: asset.name,
                    size: asset.size ?? null,
                    mimeType: asset.mimeType ?? null,
                },
            };
        } catch (error) {
            const code: DocumentPickerErrorCode =
                error instanceof DocumentPickerError ? (error.code as DocumentPickerErrorCode) : 'document-picker/pick';
            throw new DocumentPickerError(
                code,
                `documentPicker.pickAsync: ${error instanceof Error ? error.message : String(error)}`,
                error,
            );
        }
    },
};

export { DocumentPickerError };
export type { DocumentPickerErrorCode };
