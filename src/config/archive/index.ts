import { createConfigStore } from '@/core/config-store';
import { crypto } from '@/core/crypto';

/**
 * archive 业务域配置。字段名对齐 zookeeper 协议的点分风格（x.x.x）。
 * 凭据类字段走 secure 选项（H10）。
 */
export const archiveConfig = createConfigStore(
    'archive.config',
    {
        'zookeeper.url': 'https://zookeeper.hatch.almightydb.cloud/channels/',
        'zookeeper.name': 'archive',
        'zookeeper.key': '917b7925-d324-11f1-a392-c454449c5e7e',
        'gateway.url': '',
        'gateway.key': '',
        'project.client.name': '',
        'project.client.key': '',
        'project.client.heartbeat': '',
        // 主题偏好：system（跟随系统）/ light（灰白）/ dark
        'ui.theme': 'system',
        // 个人资料（Me 页）：头像文件的 file-storage key（'' = 未设置头像；
        // 文件本体存 file-storage，固定 key 'profile/avatar.jpg' 覆盖写，禁进 sqlite）
        'ui.avatar': '',
        // 设备 UID：RFC 4122 v4 完整 UUID，首次使用后生成并持久化，之后不再变化
        'ui.uid': '',
    },
    {
        secure: ['zookeeper.key', 'gateway.key', 'project.client.key'],
    },
);

/**
 * 首启 UID 生成（幂等，多处调用安全）：'ui.uid' 为空时生成 v4 UUID 写回配置。
 * 完整 UUID 是唯一事实源（同步/导出等场景的稳定标识）；展示层可用短版（前 8 位），
 * 复制/上报一律取完整值。
 *
 * 调用时机约束：必须在配置注水（persist hydration）完成**之后**调用——未注水时
 * store 里是默认空值，此时生成的 uid 会被注水结果覆盖丢失（Me 页已按
 * hasHydrated / onFinishHydration 守卫调用，见 me-screen）。
 */
export function ensureUid(): string {
    const existing = archiveConfig.get()['ui.uid'];
    if (existing) return existing;
    // expo-crypto 的 randomUUID 带 web 非安全上下文兜底（getRandomValues 手拼 v4），
    // 三端可用；生成即写回，写回失败由 config-store 的 onError 上报钩子上浮
    const uid = crypto.randomUUID();
    archiveConfig.update({ 'ui.uid': uid });
    return uid;
}
