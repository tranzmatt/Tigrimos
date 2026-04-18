import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { getSettings } from "./data";

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputFiles: string[];
}

export async function runPython(
  code: string,
  sandboxDir: string,
  timeout: number = 30000,
  projectOutputDir?: string
): Promise<PythonResult> {
  const settings = await getSettings();
  return new Promise((resolve) => {
    const pythonPath = settings.pythonPath || "python3";
    // Write temp scripts to /tmp (always writable, even under ProtectSystem=strict)
    // instead of sandboxDir which may be read-only
    const tmpDir = process.env.TMPDIR || "/tmp";
    const scriptPath = path.join(tmpDir, `_run_${Date.now()}.py`);

    // Use project working folder if provided, otherwise fall back to output_file/
    // Must match index.ts static serving root: process.env.SANDBOX_DIR || cwd
    const staticRoot = process.env.SANDBOX_DIR || path.resolve(".");
    let outputDir = projectOutputDir || path.join(staticRoot, "output_file");
    try {
      if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    } catch {
      // staticRoot is unreachable — try sandboxDir arg as second option
      outputDir = path.join(sandboxDir, "output_file");
      try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      } catch {
        // Both failed — use /tmp fallback (files will be copied to static root later)
        outputDir = path.join(tmpDir, "tigrimos_output");
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
      }
    }

    // Writable scratch directory for caches (matplotlib, fontconfig, pandas, etc.)
    const scratchDir = path.join(tmpDir, "tigrimos_python_cache");
    if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

    const wrappedCode = `
import os, sys, urllib.parse, urllib.request, json, tempfile

# ── Ensure writable HOME / cache paths BEFORE any library imports ──
_scratch = ${JSON.stringify(scratchDir)}
os.makedirs(_scratch, exist_ok=True)

# Redirect every cache / config directory that common libs probe
os.environ['HOME']            = _scratch
os.environ['MPLCONFIGDIR']    = os.path.join(_scratch, 'matplotlib')
os.environ['XDG_CACHE_HOME']  = os.path.join(_scratch, 'cache')
os.environ['XDG_CONFIG_HOME'] = os.path.join(_scratch, 'config')
os.environ['XDG_DATA_HOME']   = os.path.join(_scratch, 'data')
os.environ['FONTCONFIG_CACHE'] = os.path.join(_scratch, 'fontconfig')
os.environ['TMPDIR']          = _scratch
os.environ['TEMP']            = _scratch
os.environ['TMP']             = _scratch

# Pre-create the subdirs so libraries don't fail on first access
for _d in ['matplotlib', 'cache', 'config', 'data', 'fontconfig']:
    os.makedirs(os.path.join(_scratch, _d), exist_ok=True)

# Flush stdout/stderr on every print so output is never swallowed
sys.stdout.reconfigure(line_buffering=True) if hasattr(sys.stdout, 'reconfigure') else None
sys.stderr.reconfigure(line_buffering=True) if hasattr(sys.stderr, 'reconfigure') else None

# Set default User-Agent for web requests
opener = urllib.request.build_opener()
opener.addheaders = [('User-Agent', 'Tigrimos/1.0 (Python; Web Search)')]
urllib.request.install_opener(opener)

# Configure matplotlib for non-interactive backend (save to file, not show)
try:
    import matplotlib
    matplotlib.use('Agg')
except ImportError:
    pass

# PROJECT_DIR points to the project root (or project working folder if in project context)
PROJECT_DIR = ${JSON.stringify(projectOutputDir || sandboxDir)}
os.chdir(${JSON.stringify(outputDir)})

# ── Run user code inside try/except so errors ALWAYS appear in stdout ──
try:
${code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as _e:
    import traceback as _tb
    print(f"❌ PYTHON ERROR: {type(_e).__name__}: {_e}", flush=True)
    _tb.print_exc()
    sys.exit(1)
`;

    fs.writeFileSync(scriptPath, wrappedCode);

    // Record start time to detect files created during this execution
    const startTime = Date.now();

    // Use outputDir as cwd (guaranteed to exist after the mkdir above)
    const proc = spawn(pythonPath, [scriptPath], {
      cwd: outputDir,
      timeout,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        HOME: scratchDir,
        MPLCONFIGDIR: path.join(scratchDir, "matplotlib"),
        XDG_CACHE_HOME: path.join(scratchDir, "cache"),
        XDG_CONFIG_HOME: path.join(scratchDir, "config"),
        XDG_DATA_HOME: path.join(scratchDir, "data"),
        FONTCONFIG_CACHE: path.join(scratchDir, "fontconfig"),
        TMPDIR: scratchDir,
        TEMP: scratchDir,
        TMP: scratchDir,
      },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => { stdout += data.toString(); });
    proc.stderr.on("data", (data) => { stderr += data.toString(); });

    proc.on("close", (exitCode) => {
      // Clean up temp script
      try { fs.unlinkSync(scriptPath); } catch {}

      // Detect files created/modified during this execution in the output directory
      const outputFiles: string[] = [];
      const outputExts = [".pdf", ".docx", ".doc", ".xlsx", ".csv", ".png", ".jpg", ".jpeg", ".svg", ".html", ".gif", ".webp", ".txt", ".md", ".jsx.js"];
      const scanDirs = [outputDir];
      // Use staticRoot (SANDBOX_DIR env, defined above) for relative paths so the
      // client can fetch files via /sandbox/<relPath>.
      try {
        for (const dir of scanDirs) {
          if (!fs.existsSync(dir)) continue;
          const files = fs.readdirSync(dir);
          for (const f of files) {
            const ext = path.extname(f).toLowerCase();
            if (outputExts.includes(ext) || f.endsWith(".jsx.js")) {
              const fullPath = path.join(dir, f);
              const stat = fs.statSync(fullPath);
              // Include files modified after script started (not a fixed window)
              if (stat.mtimeMs >= startTime - 1000) {
                const relPath = path.relative(staticRoot, fullPath);
                // Skip files outside the static root (relative path starts with ..)
                if (relPath.startsWith("..")) {
                  // Copy file into static root so it can be served
                  const destDir = path.join(staticRoot, "output_file");
                  try { if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true }); } catch {}
                  const destPath = path.join(destDir, f);
                  try { fs.copyFileSync(fullPath, destPath); } catch {}
                  outputFiles.push(path.relative(staticRoot, destPath));
                } else {
                  outputFiles.push(relPath);
                }
              }
            }
          }
        }
      } catch {}

      resolve({ stdout, stderr, exitCode: exitCode ?? 1, outputFiles });
    });

    proc.on("error", (err) => {
      try { fs.unlinkSync(scriptPath); } catch {}
      resolve({ stdout: "", stderr: err.message, exitCode: 1, outputFiles: [] });
    });
  });
}
