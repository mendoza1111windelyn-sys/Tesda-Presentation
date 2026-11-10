import { useEffect, useRef, useState } from "react";

type Handlers = {
  onMessage: (message: any) => void;
};

// Reconnecting websocket hook. `send` queues nothing: messages sent while closed are dropped.
export function useSocket(query: string, handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    let retry: number | undefined;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws?${query}`);
      socketRef.current = socket;
      socket.onopen = () => setConnected(true);
      socket.onmessage = (event) => {
        try {
          handlersRef.current.onMessage(JSON.parse(event.data));
        } catch {
          /* ignore malformed messages */
        }
      };
      socket.onclose = (event) => {
        setConnected(false);
        if (!closed && event.code !== 4000) retry = window.setTimeout(connect, 1500 + Math.random() * 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socketRef.current?.close();
    };
  }, [query]);

  const send = (message: unknown) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
  };
  return { connected, send };
}
