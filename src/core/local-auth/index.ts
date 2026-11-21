import * as LocalAuthentication from 'expo-local-authentication';

/**
 * 本地身份认证接口（面容/指纹/设备凭据，glossary §3 已登记）。
 *
 * 薄封装（error-handling.md R4）：不吞错误、不包装——底层 CodedError 原样抛出，
 * 调用方自行降级。三端口径：native 走系统生物识别/设备凭据（iOS FaceID/TouchID
 * + passcode 回退，Android BiometricPrompt + 设备凭据回退）；web 无系统认证
 * 语义，官方 web 构建为 stub（hasHardwareAsync 恒 false）——isSupportedAsync
 * 在 web 恒 false，调用方据此关闭入口（App 锁仅 native 生效）。
 */
export const localAuth = {
    /**
     * 当前设备是否具备可用的认证手段（硬件存在 且 已录入凭据）。
     * App 锁开关与门禁解锁前的唯一探测口径——硬件存在但未录入时同样视为
     * 不可用（认证必然失败，不能把用户锁在门外）。
     */
    async isSupportedAsync(): Promise<boolean> {
        const [hasHardware, enrolled] = await Promise.all([
            LocalAuthentication.hasHardwareAsync(),
            LocalAuthentication.isEnrolledAsync(),
        ]);
        return hasHardware && enrolled;
    },

    /**
     * 拉起系统认证（指纹/设备凭据回退，系统 UI 自管）。
     * resolve true = 验证通过；false = 用户取消/验证失败（不抛错——取消是
     * 正常交互路径，区分原因由 UI 层文案兜底，不作为异常传播）。
     *
     * **biometricsSecurityLevel 默认 'strong'（2026-11-19 用户指令「去掉人脸、
     * 保持指纹」）**：Android 生物识别按安全等级分类，指纹恒为 Class 3
     * （strong），摄像头人脸多为 Class 2（weak）——'strong' 让系统提示只出
     * 指纹（Class 2 人脸被排除），即「仅指纹」语义。已知边界：Class 3 人脸
     * 设备（少数 3D 人脸）系统仍会提供，Expo Go 无按模态过滤的 API；iOS 该键
     * 被忽略（FaceID 照常）。
     *
     * **requireConfirmation 默认 false（Android）**：androidx BiometricPrompt 对
     * 被动识别（人脸）默认「识别成功后弹确认步」——正是「面部识别成功，请
     * 继续」停留弹窗的来源（2026-11-19 用户反馈）。识别成功立即回 app；iOS
     * LAPolicy 无此概念，该键被忽略。
     */
    async authenticateAsync(options?: {
        promptMessage?: string;
        requireConfirmation?: boolean;
    }): Promise<boolean> {
        const result = await LocalAuthentication.authenticateAsync({
            promptMessage: options?.promptMessage ?? '请验证身份',
            cancelLabel: '取消',
            requireConfirmation: options?.requireConfirmation ?? false,
            // 'strong' = 仅 Class 3 生物识别（指纹恒在，Class 2 人脸被系统排除）
            biometricsSecurityLevel: 'strong',
        });
        return result.success;
    },
};
