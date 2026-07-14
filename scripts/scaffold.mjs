// scaffold.mjs — create a new teleport project from `project-template/` (RFC 09 Phase 2).
//
// A hand-run CLI (NOT daemon/Telegram — that's `/setup`, deferred). It copies the
// type-neutral `core/` plus one profile's `overlay.md` into a new sibling folder,
// substitutes the template placeholders (`<PROJECT>`, `<profile>`, …), and does the
// first `git init` + commit. One command, no missed placeholders.
//
// Usage:
//   node ../teleport/scripts/scaffold.mjs <project> --type <code-bot|code-web|monorepo|content>
//                                         [--dry-run] [--no-git] [--into <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-direct-run.mjs';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = path.join(__dirname, '..', 'project-template');
// Workspace root: new projects are siblings of teleport (../<project>).
export const PARENT_DIR = path.resolve(__dirname, '..', '..');
export const PROFILES = ['code-bot', 'code-web', 'monorepo', 'content'];

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

export function parseScaffoldArgs(argv) {
  const out = { project: null, type: null, dryRun: false, git: true, into: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') out.type = argv[++i];
    else if (a.startsWith('--type=')) out.type = a.slice('--type='.length);
    else if (a === '--into') out.into = argv[++i];
    else if (a.startsWith('--into=')) out.into = a.slice('--into='.length);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-git') out.git = false;
    else if (!a.startsWith('-') && out.project == null) out.project = a;
  }
  return out;
}

// Validate the project name: a single path segment, no traversal, safe chars only
// (it becomes a directory name AND the projects.json key / display code).
export function validateProjectName(name) {
  if (!name) return 'usage: scaffold <project> --type <code-bot|code-web|monorepo|content>';
  if (name === '.' || name === '..' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return `invalid project name: ${JSON.stringify(name)} (use letters/digits/._- , no path separators)`;
  }
  return null;
}

export function validateType(type) {
  if (!type) return 'missing --type (one of: ' + PROFILES.join(', ') + ')';
  if (!PROFILES.includes(type)) return `unknown --type ${JSON.stringify(type)} (one of: ${PROFILES.join(', ')})`;
  return null;
}

// Replace every template placeholder. Longest/most-specific first so a substring
// placeholder can't partially match another. `<one-line description>` is left for
// the human to fill (the tool can't know it).
export function applyPlaceholders(content, { project, type }) {
  return content
    .split('<code-bot | code-web | monorepo | content>').join(type)
    .split('<PROJECT>').join(project)
    .split('<profile>').join(type);
}

// Files we substitute placeholders in (text). Anything else is copied byte-for-byte.
const TEXT_NAMES = new Set(['.gitignore', '.gitkeep']);
const TEXT_EXTS = new Set(['.md', '.txt', '.json']);
export function isTextFile(filename) {
  return TEXT_NAMES.has(filename) || TEXT_EXTS.has(path.extname(filename));
}

// ── Tree copy ─────────────────────────────────────────────────────────────────

// Recursively copy `srcDir` → `destDir`, applying placeholders to text files.
// Returns the list of created relative paths. Pure-ish: all fs access via injected
// `io` so tests can run without touching disk; defaults to real fs.
export function copyTree(srcDir, destDir, ctx, io = fs, created = [], rel = '') {
  io.mkdirSync(destDir, { recursive: true });
  for (const entry of io.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      copyTree(src, dest, ctx, io, created, childRel);
    } else {
      if (isTextFile(entry.name)) {
        const out = applyPlaceholders(io.readFileSync(src, 'utf8'), ctx);
        io.writeFileSync(dest, out);
      } else {
        io.copyFileSync(src, dest);
      }
      created.push(childRel);
    }
  }
  return created;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

// Plan the scaffold without touching disk — what would be created. Pure given io.
export function planScaffold({ project, type, parentDir = PARENT_DIR, into = null, templateDir = TEMPLATE_DIR }, io = fs) {
  const dest = into ? path.resolve(into) : path.join(parentDir, project);
  const coreDir = path.join(templateDir, 'core');
  const overlay = path.join(templateDir, 'profiles', type, 'overlay.md');
  const errors = [];
  if (!io.existsSync(coreDir)) errors.push(`template core not found: ${coreDir}`);
  if (!io.existsSync(overlay)) errors.push(`profile overlay not found: ${overlay}`);
  // Refuse a non-empty destination (never clobber an existing project).
  if (io.existsSync(dest) && io.readdirSync(dest).length > 0) errors.push(`destination exists and is not empty: ${dest}`);
  return { dest, coreDir, overlay, errors };
}

export function scaffold(opts, io = fs, runGit = defaultGit) {
  const { project, type, dryRun = false, git = true } = opts;
  const plan = planScaffold(opts, io);
  if (plan.errors.length) return { ok: false, errors: plan.errors };
  const ctx = { project, type };
  if (dryRun) {
    return { ok: true, dryRun: true, dest: plan.dest, files: copyTree(plan.coreDir, plan.dest, ctx, dryIo(io)).concat('overlay.md') };
  }
  const files = copyTree(plan.coreDir, plan.dest, ctx, io);
  // Profile overlay → <project>/overlay.md (referenced by name in core docs).
  io.writeFileSync(path.join(plan.dest, 'overlay.md'), applyPlaceholders(io.readFileSync(plan.overlay, 'utf8'), ctx));
  files.push('overlay.md');
  let git_ = null;
  if (git) git_ = runGit(plan.dest);
  return { ok: true, dest: plan.dest, files, git: git_ };
}

// Dry-run io: reads pass through, writes/mkdir are no-ops (so we can list files).
function dryIo(io) {
  return {
    ...io,
    mkdirSync: () => {},
    writeFileSync: () => {},
    copyFileSync: () => {},
    readdirSync: io.readdirSync.bind(io),
    readFileSync: io.readFileSync.bind(io),
  };
}

function defaultGit(dest) {
  try {
    execFileSync('git', ['init', '-q'], { cwd: dest });
    execFileSync('git', ['add', '-A'], { cwd: dest });
    execFileSync('git', ['commit', '-q', '-m', 'chore: scaffold from teleport project-template (RFC 09)'], { cwd: dest });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const isDirectRun = isMainModule(import.meta.url);
if (isDirectRun) {
  const args = parseScaffoldArgs(process.argv.slice(2));
  const e1 = validateProjectName(args.project);
  if (e1) { console.error(`❌ ${e1}`); process.exit(2); }
  const e2 = validateType(args.type);
  if (e2) { console.error(`❌ ${e2}`); process.exit(2); }

  const res = scaffold(args);
  if (!res.ok) { for (const err of res.errors) console.error(`❌ ${err}`); process.exit(1); }

  if (res.dryRun) {
    console.log(`[scaffold] DRY RUN — would create ${res.files.length} files in ${res.dest}:`);
    for (const f of res.files) console.log(`  ${f}`);
    process.exit(0);
  }
  console.log(`✅ scaffolded ${args.project} (${args.type}) → ${res.dest} (${res.files.length} files)`);
  if (res.git && !res.git.ok) console.error(`⚠️ git init/commit failed: ${res.git.error} — folder created, commit by hand`);
  else if (res.git) console.log('   git: initialized + first commit');
  console.log('   Next: fill <one-line description> + CLAUDE.md project context + docs/project_overview.md.');
}
