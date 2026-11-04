/**
 * service 层对外 API 收口（业务层只 import 这里，不深挖子目录——layering.md L3）。
 */
export { post, type PostOptions, type PostResult } from './post';
export { PostError, type PostErrorCode } from './post';
export { createSocket, type Socket, type SocketOptions, type SocketState, type SocketSubscription } from './socket';
export { SocketError, type SocketErrorCode } from './socket';
