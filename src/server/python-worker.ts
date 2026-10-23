// Runs Python (Pyodide) in a worker thread, so a runaway program can be stopped by ending the thread.
// /work is a real folder on disk: the project's folder, or the chat's own sandbox folder.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface Run {
  id: number;
  code: string;
}

const IMAGE = /^\.(png|jpe?g|gif|webp|svg)$/i;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const { workDir, cacheDir } = workerData as { workDir: string; cacheDir: string };

/** Image files in the work folder (top level and one below), with their modification times. */
function images(): Map<string, number> {
  const out = new Map<string, number>();
  const scan = (dir: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth < 1 && !e.name.startsWith('.') && e.name !== 'node_modules') scan(p, depth + 1);
      else if (e.isFile() && IMAGE.test(extname(e.name))) out.set(p, statSync(p).mtimeMs);
    }
  };
  try {
    scan(workDir, 0);
  } catch {
    // An unreadable folder has no images to report.
  }
  return out;
}

const { loadPyodide } = await import('pyodide');
const py = await loadPyodide({ packageCacheDir: cacheDir } as any);
py.FS.mkdirTree('/work');
py.FS.mount(py.FS.filesystems.NODEFS, { root: workDir }, '/work');
py.runPython("import os; os.chdir('/work'); os.environ['MPLBACKEND'] = 'Agg'");

let output = '';
py.setStdout({ batched: (s: string) => ((output += `${s}\n`), parentPort!.postMessage({ type: 'output', text: `${s}\n` })) });
py.setStderr({ batched: (s: string) => ((output += `${s}\n`), parentPort!.postMessage({ type: 'output', text: `${s}\n` })) });
parentPort!.postMessage({ type: 'ready' });

parentPort!.on('message', async ({ id, code }: Run) => {
  output = '';
  const before = images();
  let result: string | undefined;
  let error: string | undefined;
  try {
    // Packages the code imports (numpy, pandas, matplotlib…) load on first use.
    await py.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: (m: string) => (output += `${m}\n`) });
    const value = await py.runPythonAsync(code);
    if (value !== undefined && value !== null) {
      result = String(value);
      value.destroy?.();
    }
  } catch (err) {
    error = (err as Error).message;
  }
  // Charts the code drew but didn't save come back as images.
  const figures: string[] = [];
  try {
    const list = py.runPython(`
import sys
_mitzi_figs = []
if 'matplotlib.pyplot' in sys.modules:
    import matplotlib.pyplot as _plt, io as _io, base64 as _b64
    for _n in _plt.get_fignums():
        _buf = _io.BytesIO()
        _plt.figure(_n).savefig(_buf, format='png', dpi=110, bbox_inches='tight')
        _mitzi_figs.append(_b64.b64encode(_buf.getvalue()).decode())
    _plt.close('all')
_mitzi_figs`);
    figures.push(...(list.toJs() as string[]));
    list.destroy();
  } catch {
    // No figures.
  }
  const saved: { name: string; dataUrl: string }[] = [];
  for (const [path, mtime] of images()) {
    if (before.get(path) === mtime) continue;
    const ext = extname(path).toLowerCase();
    if (statSync(path).size > 5 * 1024 * 1024) continue;
    saved.push({ name: path.slice(workDir.length + 1).replace(/\\/g, '/'), dataUrl: `data:${MIME[ext]};base64,${readFileSync(path).toString('base64')}` });
  }
  parentPort!.postMessage({
    type: 'done',
    id,
    output,
    result,
    error,
    images: [...figures.map((b64, i) => ({ name: `Figure ${i + 1}`, dataUrl: `data:image/png;base64,${b64}` })), ...saved],
  });
});
