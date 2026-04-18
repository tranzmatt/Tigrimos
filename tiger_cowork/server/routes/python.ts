import { FastifyInstance } from "fastify";
import { runPython } from "../services/python";
import { getSettings } from "../services/data";
import path from "path";
import fs from "fs";

function resolveSandboxDir(configured?: string): string {
  if (configured && fs.existsSync(configured)) return configured;
  const envDir = process.env.SANDBOX_DIR;
  if (envDir && fs.existsSync(envDir)) return envDir;
  const cwd = process.cwd();
  if (fs.existsSync(cwd)) return cwd;
  const tmp = path.join(process.env.TMPDIR || "/tmp", "tigrimos_sandbox");
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

export async function pythonRoutes(fastify: FastifyInstance) {
  fastify.post("/run", async (request, reply) => {
    const { code } = request.body as any;
    if (!code) { reply.code(400); return { error: "code required" }; }

    const settings = await getSettings();
    const sandboxDir = resolveSandboxDir(settings.sandboxDir);
    const result = await runPython(code, sandboxDir);
    return result;
  });
}
