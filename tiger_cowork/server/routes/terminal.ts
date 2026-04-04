import { FastifyInstance } from "fastify";
import { spawn } from "child_process";
import { Server } from "socket.io";

let activePty: any = null;

export function setupTerminalSocket(io: Server) {
  // Dynamically import node-pty (native module)
  let pty: any = null;
  try {
    pty = require("node-pty");
  } catch {
    console.warn("[Terminal] node-pty not available — terminal will use fallback mode");
  }

  io.on("connection", (socket) => {
    socket.on("terminal:start", (opts?: { cols?: number; rows?: number }) => {
      // Kill existing session
      if (activePty) {
        try { activePty.kill(); } catch {}
        activePty = null;
      }

      const cols = opts?.cols || 120;
      const rows = opts?.rows || 30;

      if (pty) {
        // --- node-pty mode: real PTY with proper resize support ---
        const shell = pty.spawn("sudo", ["-i"], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: "/",
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          },
        });

        activePty = shell;
        socket.emit("terminal:started");

        shell.onData((data: string) => {
          socket.emit("terminal:output", data);
        });

        shell.onExit(({ exitCode }: { exitCode: number }) => {
          socket.emit("terminal:exit", { code: exitCode });
          activePty = null;
        });

        socket.on("terminal:input", (data: string) => {
          if (activePty) {
            shell.write(data);
          }
        });

        socket.on("terminal:resize", (size: { cols: number; rows: number }) => {
          if (activePty && size.cols > 0 && size.rows > 0) {
            try { shell.resize(size.cols, size.rows); } catch {}
          }
        });

        socket.on("disconnect", () => {
          if (activePty) {
            try { shell.kill(); } catch {}
            activePty = null;
          }
        });
      } else {
        // --- Fallback: script-based PTY (no resize support) ---
        const { spawn: spawnChild } = require("child_process");
        const shell = spawnChild("script", ["-q", "/dev/null", "-c", "sudo -i"], {
          cwd: "/",
          env: {
            ...process.env,
            TERM: "xterm-256color",
            COLUMNS: String(cols),
            LINES: String(rows),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        activePty = shell;
        socket.emit("terminal:started");

        shell.stdout?.on("data", (data: Buffer) => {
          socket.emit("terminal:output", data.toString());
        });
        shell.stderr?.on("data", (data: Buffer) => {
          socket.emit("terminal:output", data.toString());
        });
        shell.on("close", (code: number) => {
          socket.emit("terminal:exit", { code: code ?? 0 });
          activePty = null;
        });

        socket.on("terminal:input", (data: string) => {
          if (shell && !shell.killed) {
            shell.stdin?.write(data);
          }
        });

        socket.on("disconnect", () => {
          if (shell && !shell.killed) {
            shell.kill();
            activePty = null;
          }
        });
      }
    });

    socket.on("terminal:stop", () => {
      if (activePty) {
        try {
          if (typeof activePty.kill === "function") activePty.kill();
        } catch {}
        activePty = null;
      }
    });
  });
}

export async function terminalRoutes(fastify: FastifyInstance) {
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
