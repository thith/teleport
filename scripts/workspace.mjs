// Workspace layout shared by the daemon and the scripts it runs (no imports of
// daemon.mjs here — merge.mjs depends on this file, and daemon.mjs imports
// merge.mjs, so anything placed here must stay dependency-light).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Common parent of teleport and its sibling projects (the workspace root). The
// daemon orchestrates across siblings, so `/spawn <project>` resolves to
// `<PARENT_DIR>/<project>`.
export const PARENT_DIR = path.resolve(__dirname, '..', '..');

// Resolve `<folder>` (positional first token when needsProject) to a sibling
// directory under PARENT_DIR. Returns
// { cwd } or { error }. Validates the project token (no path traversal) and that
// the directory exists with a package.json (teleport's project convention).
export function resolveSpawnCwd(project, { parentDir = PARENT_DIR, statSync = fs.statSync, realpathSync = fs.realpathSync } = {}) {
  if (!project) return { error: 'usage: /spawn <project>' };
  if (!/^[A-Za-z0-9._-]+$/.test(project) || project === '.' || project === '..') {
    return { error: `invalid project name: ${JSON.stringify(project)}` };
  }
  const cwd = path.join(parentDir, project);
  try {
    if (!statSync(cwd).isDirectory()) return { error: `not a directory: ${cwd}` };
  } catch {
    return { error: `project folder not found: ${cwd}` };
  }
  // Containment after following symlinks: a project dir that's a symlink to
  // OUTSIDE the workspace parent must not let /spawn or /run execute elsewhere.
  try {
    const realParent = realpathSync(parentDir);
    const realCwd = realpathSync(cwd);
    if (realCwd !== realParent && !realCwd.startsWith(realParent + path.sep)) {
      return { error: `project resolves outside the workspace: ${project}` };
    }
  } catch {
    return { error: `cannot resolve project path: ${cwd}` };
  }
  return { cwd };
}

