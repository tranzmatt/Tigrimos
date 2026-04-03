import { useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getAccessToken } from "../utils/api";

interface TerminalProps {
  onClose: () => void;
}

export default function Terminal({ onClose }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const cleanup = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.emit("terminal:stop");
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create xterm instance
    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(containerRef.current);
    fitAddon.fit();

    term.writeln("\x1b[1;34m--- TigrimOS Terminal ---\x1b[0m");
    term.writeln("\x1b[90mConnecting to sandbox...\x1b[0m\r\n");

    // Connect socket
    const token = getAccessToken();
    const socket = io(window.location.origin, {
      transports: ["websocket", "polling"],
      auth: { token },
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      const { cols, rows } = term;
      socket.emit("terminal:start", { cols, rows });
    });

    socket.on("terminal:output", (data: string) => {
      term.write(data);
    });

    socket.on("terminal:exit", ({ code }: { code: number }) => {
      term.writeln(`\r\n\x1b[90m--- Terminal exited (code ${code}) ---\x1b[0m`);
    });

    socket.on("disconnect", () => {
      term.writeln("\r\n\x1b[31m--- Disconnected ---\x1b[0m");
    });

    // Send user input to server
    term.onData((data) => {
      socket.emit("terminal:input", data);
    });

    // Handle resize
    term.onResize(({ cols, rows }) => {
      socket.emit("terminal:resize", { cols, rows });
    });

    const resizeObserver = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch {}
    });
    resizeObserver.observe(containerRef.current);

    // Focus terminal
    term.focus();

    return () => {
      resizeObserver.disconnect();
      cleanup();
    };
  }, [cleanup]);

  return (
    <div style={{
      background: "#0d1117",
      borderRadius: 8,
      border: "1px solid #30363d",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 12px", background: "#161b22", borderBottom: "1px solid #30363d",
        flexShrink: 0,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#3fb950" }} />
          <span style={{ fontSize: 12, color: "#8b949e", fontFamily: "monospace" }}>
            root@tigris — sandbox
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "transparent", border: "1px solid #30363d", borderRadius: 4,
            color: "#8b949e", fontSize: 11, padding: "2px 8px", cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      {/* Terminal */}
      <div
        ref={containerRef}
        style={{ height: 380, padding: "4px 0 4px 4px" }}
      />
    </div>
  );
}
