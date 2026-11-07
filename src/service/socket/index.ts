import { Platform } from 'react-native';
import { SocketError } from './errors';

export { SocketError, type SocketErrorCode } from './errors';

/**
 * 通用 WebSocket 接口（ws/wss 工厂）：URL 与鉴权头由调用方注入，
 * 连接（connect）与出口（close）由外部驱动；断线自动重连。
 *
 * 行为：
 * - createSocket 后为 closed，须显式 connect()（幂等）；
 * - 断线自动重连：0.4s 起指数退避，封顶为每次 1–4s 的随机间隔；open 后归零；
 * - 连接中 send 进入有界离箱队列（100 条，超出抛 socket/full），open 后按序冲刷；
 * - 未连接（从未 connect 或手动 close 后）send 抛 socket/closed；
 * - 接收端统一 JSON.parse 分发给 onMessage 订阅者（非 JSON 帧告警后丢弃）。
 *
 * 平台差异（见 docs/platform-parity.md）：native 经 options 携带自定义头；
 * web 的 WebSocket 不允许自定义头，headers 被忽略——需要鉴权时由调用方把凭据拼入 URL。
 */
export type SocketState = 'connecting' | 'open' | 'closed';

export interface SocketSubscription {
    remove(): void;
}

export interface SocketOptions {
    url: string;
    /** 附加请求头（鉴权等）；web 端被忽略（平台限制） */
    headers?: Record<string, string>;
}

export interface Socket {
    connect(): void;
    send(message: unknown): void;
    onMessage(listener: (message: unknown) => void): SocketSubscription;
    onState(listener: (state: SocketState) => void): SocketSubscription;
    close(): void;
    readonly state: SocketState;
}

const BASE_DELAY_MS = 400;
const CAP_FLOOR_MS = 1_000;
const CAP_CEILING_MS = 4_000;
const CONNECT_TIMEOUT_MS = 10_000;
const OUTBOX_LIMIT = 100;

// RN 原生 WebSocket 支持第三参 options.headers（自定义头），类型定义未标注——本地收窄
type WebSocketWithOptions = new (
    url: string,
    protocols?: string | string[] | null,
    options?: { headers?: Record<string, string> },
) => WebSocket;

export function createSocket(options: SocketOptions): Socket {
    return new SocketClient(options);
}

class SocketClient implements Socket {
    private readonly options: SocketOptions;
    private socket: WebSocket | null = null;
    private currentState: SocketState = 'closed';
    private attempt = 0;
    private manualClose = false;
    private outbox: string[] = [];
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private connectTimer: ReturnType<typeof setTimeout> | null = null;
    private messageListeners = new Set<(message: unknown) => void>();
    private stateListeners = new Set<(state: SocketState) => void>();

    constructor(options: SocketOptions) {
        this.options = options;
    }

    get state(): SocketState {
        return this.currentState;
    }

    connect(): void {
        if (this.currentState !== 'closed') return;
        this.manualClose = false;
        this.open();
    }

    send(message: unknown): void {
        const payload = JSON.stringify(message);
        if (this.currentState === 'open' && this.socket) {
            this.socket.send(payload);
            return;
        }
        if (this.currentState === 'connecting') {
            if (this.outbox.length >= OUTBOX_LIMIT) {
                throw new SocketError('socket/full', `socket.send: 离箱队列已满（${OUTBOX_LIMIT} 条）`);
            }
            this.outbox.push(payload);
            return;
        }
        throw new SocketError('socket/closed', 'socket.send: 连接未建立，先调用 connect()');
    }

    onMessage(listener: (message: unknown) => void): SocketSubscription {
        this.messageListeners.add(listener);
        return { remove: () => this.messageListeners.delete(listener) };
    }

    onState(listener: (state: SocketState) => void): SocketSubscription {
        this.stateListeners.add(listener);
        return { remove: () => this.stateListeners.delete(listener) };
    }

    /** 手动关闭：停止重连、清空离箱队列。再次使用需显式 connect()。 */
    close(): void {
        this.manualClose = true;
        this.clearTimers();
        this.outbox = [];
        this.socket?.close();
        this.setState('closed');
    }

    private setState(state: SocketState): void {
        if (this.currentState === state) return;
        this.currentState = state;
        for (const listener of [...this.stateListeners]) listener(state);
    }

    private clearTimers(): void {
        if (this.retryTimer !== null) clearTimeout(this.retryTimer);
        if (this.connectTimer !== null) clearTimeout(this.connectTimer);
        this.retryTimer = null;
        this.connectTimer = null;
    }

    private open(): void {
        this.setState('connecting');
        let socket: WebSocket;
        try {
            if (Platform.OS === 'web') {
                socket = new WebSocket(this.options.url);
            } else {
                const NativeWebSocket = WebSocket as unknown as WebSocketWithOptions;
                socket = new NativeWebSocket(this.options.url, [], { headers: this.options.headers });
            }
        } catch (error) {
            // 构造器同步抛错（如 URL 非法的 TypeError）属于配置类永久错误：
            // 重试必然复现，停止自动重连并走现有错误上报通道；state 归位 closed 供调用方感知
            this.setState('closed');
            console.warn('[socket] 连接创建失败，停止重连:', error instanceof Error ? error.message : error);
            return;
        }
        this.socket = socket;

        // 连接挂死兜底：超时仍未 open 则主动关闭，走 onclose 的重连路径
        this.connectTimer = setTimeout(() => {
            if (this.currentState === 'connecting') socket.close();
        }, CONNECT_TIMEOUT_MS);

        socket.onopen = () => {
            if (this.connectTimer !== null) clearTimeout(this.connectTimer);
            this.connectTimer = null;
            this.attempt = 0;
            this.setState('open');
            this.flushOutbox();
        };
        socket.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            try {
                const message: unknown = JSON.parse(event.data);
                for (const listener of [...this.messageListeners]) listener(message);
            } catch (error) {
                // 非 JSON 帧不属于本协议：告警后丢弃（error-handling.md R3 ②上报后降级）
                console.warn('[socket] 丢弃非 JSON 帧:', error instanceof Error ? error.message : error);
            }
        };
        socket.onerror = () => {
            // 具体错误由紧随的 onclose 统一处理
        };
        socket.onclose = () => {
            if (this.socket === socket) this.socket = null;
            this.setState('closed');
            if (!this.manualClose) this.scheduleReconnect();
        };
    }

    private scheduleReconnect(): void {
        this.attempt += 1;
        // 0.4s 起指数退避；封顶为每次 1–4s 的随机间隔
        const cap = CAP_FLOOR_MS + Math.random() * (CAP_CEILING_MS - CAP_FLOOR_MS);
        const delay = Math.min(BASE_DELAY_MS * 2 ** (this.attempt - 1), cap);
        this.retryTimer = setTimeout(() => this.open(), delay);
    }

    private flushOutbox(): void {
        while (this.outbox.length > 0 && this.currentState === 'open' && this.socket) {
            this.socket.send(this.outbox.shift()!);
        }
    }
}
