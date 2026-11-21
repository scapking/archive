import { createConfigStore } from '@/core/config-store';

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
        // 笔记媒体块对齐（单张与堆叠共用）：left（靠左，默认）/ center / right
        'ui.mediaAlign': 'left',
        // Web Desktop 全局侧栏折叠态（ui/desktop-shell 消费）：false = 默认展开
        // 常驻；true = 折叠为 48dp 窄条把手。纯展示偏好，随 config 持久化。
        'ui.sidebarCollapsed': false,
        // App 锁三档模式（M3，features/archive/app-lock 消费）：off = 关闭（默认）；
        // balanced = 平衡（开启时的推荐档）——本次 JS 会话内验证一次全程有效：
        // 冷启需验证一次，成功后本会话内切后台 / 系统权限弹窗 / 回前台均不再重锁，
        // 仅进程重启（冷启）才需再验证；aggressive = 激进——只要离开前台（含系统
        // 权限弹窗导致的短暂退后台）回前台即重新验证。解锁走面容 / 指纹 / 设备
        // 凭据（仅 local-auth isSupportedAsync 通过时允许离开 off 档，web 无系统
        // 认证恒关闭）。值存字符串、读取处 cast（同 ui.theme 写法）。旧版布尔
        // 字段 security.appLock 不再是配置项：存量文档残留值由 app-lock 读取做
        // 兼容回退（本字段为 off 且旧值为 true 时按 balanced 生效），设置页切档
        // 时写入 false 清除。
        'security.appLockMode': 'off',
        // 防截屏与录屏（设置页安全卡消费；core/screen-capture 执行）。切档即生效
        // （设置页先执行系统能力、成功才写本字段）；冷启生效由根级 effect 接线
        // （挂载时读本档位一次性应用）。平台差异：Android FLAG_SECURE 系统级真防
        // （截屏黑图/录屏黑屏/最近任务预览同黑）；iOS 系统无官方阻止 API，库内
        // SecureWindowCanvas 覆盖层近似防护；web 无此语义恒 no-op。
        'security.preventCapture': false,
    },
    {
        secure: ['zookeeper.key', 'gateway.key', 'project.client.key'],
    },
);
