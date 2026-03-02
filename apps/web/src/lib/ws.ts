/**
 * WebSocket client for receiving real-time updates from the LocalCut server.
 */

type MessageHandler = (data: WsMessage) => void;

export interface WsMessage {
  type: string;
  data: Record<string, unknown>;
}

let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const handlers = new Set<MessageHandler>();

const WS_URL = `ws://${window.location.hostname || 'localhost'}:9470/ws`;
const RECONNECT_DELAY = 3000;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
      console.log('[WS] Connected to server');
    };

    socket.onmessage = (event) => {
      try {
        const msg: WsMessage = JSON.parse(event.data);
        handlers.forEach((handler) => handler(msg));
      } catch {
        // Ignore parse errors
      }
    };

    socket.onclose = () => {
      console.log('[WS] Disconnected, reconnecting...');
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket?.close();
    };
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY);
}

/**
 * Subscribe to WebSocket messages.
 * Returns an unsubscribe function.
 */
export function subscribe(handler: MessageHandler): () => void {
  handlers.add(handler);

  // Auto-connect on first subscriber
  if (handlers.size === 1) {
    connect();
  }

  return () => {
    handlers.delete(handler);
    // Disconnect when no subscribers
    if (handlers.size === 0 && socket) {
      socket.close();
      socket = null;
    }
  };
}

/**
 * Send a message to the server.
 */
export function send(msg: WsMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/**
 * Subscribe to messages of a specific type.
 */
export function on(type: string, handler: (data: Record<string, unknown>) => void): () => void {
  return subscribe((msg) => {
    if (msg.type === type) {
      handler(msg.data);
    }
  });
}
