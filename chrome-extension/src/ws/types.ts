export type MessageType =
  | "register"          // node → server: 注册节点
  | "register_ack"      // server → node: 注册确认
  | "command"           // server → node: 执行指令
  | "command_result"    // node → server: 指令执行结果
  | "ping"              // 双向
  | "pong"              // 双向
  | "error";            // 双向错误

export interface BaseMessage {
  type: MessageType;
  id?: string;
}

export interface RegisterMessage extends BaseMessage {
  type: "register";
  payload: {
    nodeName: string;
  };
}

export interface RegisterAckMessage extends BaseMessage {
  type: "register_ack";
  payload: {
    nodeId: string;
  };
}

export interface CommandMessage extends BaseMessage {
  type: "command";
  payload: {
    command: string;
    params?: Record<string, unknown>;
  };
}

export interface CommandResultMessage extends BaseMessage {
  type: "command_result";
  payload: {
    commandId: string;
    success: boolean;
    data?: unknown;
    error?: string;
  };
}

export interface PingMessage extends BaseMessage {
  type: "ping";
  payload: {
    timestamp: number;
  };
}

export interface PongMessage extends BaseMessage {
  type: "pong";
  payload: {
    timestamp: number;
  };
}

export interface ErrorMessage extends BaseMessage {
  type: "error";
  payload: {
    message: string;
  };
}

export type Message =
  | RegisterMessage
  | RegisterAckMessage
  | CommandMessage
  | CommandResultMessage
  | PingMessage
  | PongMessage
  | ErrorMessage;
