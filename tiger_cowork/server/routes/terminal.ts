import { FastifyInstance } from "fastify";
import { spawn, ChildProcess } from "child_process";
import { Server } from "socket.io";

let activeShell: ChildProcess | null = null;

export function setupTerminalSocket(io: Server) {
  io.on("connection", (socket) => {
    socket.on("terminal:start", (opts?: { cols?: number; rows?: number }) => {
      // Kill existing shell if any
      if (activeShell && !activeShell.killed) {
        activeShell.kill();
      }

      const cols = opts?.cols || 120;
      const rows = opts?.rows || 30;

      // Use `script` to allocate a real PTY — gives proper prompt,
      // colors, tab completion, history, and ANSI support.
      // `script -q /dev/null` creates a PTY without recording.
      const shell = spawn("script", ["-q", "/dev/null", "-c", "sudo -i"], {
        cwd: "/",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLUMNS: String(cols),
          LINES: String(rows),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      activeShell = shell;

      socket.emit("terminal:started");

      shell.stdout?.on("data", (data: Buffer) => {
        socket.emit("terminal:output", data.toString());
      });

      shell.stderr?.on("data", (data: Buffer) => {
        socket.emit("terminal:output", data.toString());
      });

      shell.on("close", (code) => {
        socket.emit("terminal:exit", { code: code ?? 0 });
        activeShell = null;
      });

      shell.on("error", (err) => {
        socket.emit("terminal:output", `\r\nError: ${err.message}\r\n`);
      });

      // Forward user input directly — xterm.js sends raw key data
      socket.on("terminal:input", (data: string) => {
        if (shell && !shell.killed) {
          shell.stdin?.write(data);
        }
      });

      // Handle terminal resize — send SIGWINCH via stty
      socket.on("terminal:resize", (size: { cols: number; rows: number }) => {
        if (shell && !shell.killed && size.cols > 0 && size.rows > 0) {
          // Write stty command to resize the PTY
          shell.stdin?.write(`stty cols ${size.cols} rows ${size.rows}\n`);
        }
      });

      socket.on("disconnect", () => {
        if (shell && !shell.killed) {
          shell.kill();
          activeShell = null;
        }
      });
    });

    socket.on("terminal:stop", () => {
      if (activeShell && !activeShell.killed) {
        activeShell.kill();
        activeShell = null;
      }
    });
  });
}

export async function terminalRoutes(fastify: FastifyInstance) {
  // Simple exec endpoint for one-off commands (always as root)
  fastify.post<{ Body: { command: string } }>("/exec", async (request) => {
    const { command } = request.body;
    if (!command) return { error: "No command provided" };

    return new Promise((resolve) => {
      const proc = spawn("sudo", ["/bin/bash", "-c", command], {
        cwd: process.env.SANDBOX_DIR || process.cwd(),
        env: { ...process.env, TERM: "dumb" },
        timeout: 30000,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        resolve({ stdout, stderr, exitCode: code });
      });
      proc.on("error", (err) => {
        resolve({ error: err.message, exitCode: 1 });
      });
    });
  });
}
