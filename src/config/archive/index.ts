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
    },
    {
        secure: ['zookeeper.key', 'gateway.key', 'project.client.key'],
    },
);
