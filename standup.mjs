#!/usr/bin/env node
// Daily standup — recap of the day's work, posted to Discord.
//
// Sources: Kilo session transcripts (local + ZimaOS server), second-brain
// notes (GitHub), GitHub commits across all owned repos, and new/touched
// projects on the Projects share.
//
// Usage:
//   node standup.mjs                     # yesterday if run before 06:00, else today
//   node standup.mjs --date 2026-10-01   # explicit target day
//   node standup.mjs --dry-run           # print the recap, send nothing
//   node standup.mjs --force             # send even if this date was already sent
//
// The sent-date state file makes the manual + scheduled runs idempotent:
// whichever runs first for a calendar day wins, the other exits quietly.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(HERE, 'state');
const SENT_STATE_PATH = join(STATE_DIR, 'sent.json');
const LAST_RUN_PATH = join(STATE_DIR, 'last-run.json');

// Claude/Kilo transcript format: assistant tool_use blocks that carry a file_path.
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// User phrasing that flags work as intentionally not done yet.
const DEFER_MARKERS = /\b(todo|to do|next time|remember to|come back (to|and)|not yet|still needs? to|wip\b|in progress|unfinished|for later|finish (this|it|up) (later|tomorrow)|pick (this|it) up)\b/i;
// CLI-internal marker written when the user interrupts a turn; it
// signals an interrupted session but is not itself a user prompt.
const INTERRUPT_MARKER = /^\[request interrupted by user\]/i;
const EMBED_DESCRIPTION_LIMIT = 3800; // Discord hard limit is 4096; leave headroom
const EMBED_FIELD_VALUE_LIMIT = 1000; // Discord hard limit is 1024
const EMBEDS_PER_MESSAGE = 10; // Discord hard limit
const MAX_FILES_LISTED = 50;
const MAX_NOTES_LISTED = 40;
const STATE_RETENTION_DAYS = 60;

// ---------- CLI ----------

const args = process.argv.slice(2);
const argDate = valueOfFlag(args, '--date');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

function valueOfFlag(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

// ---------- Config ----------

function loadConfig() {
  const path = join(HERE, 'config.json');
  if (!existsSync(path)) {
    fail(`config.json not found. Copy config.example.json to config.json and paste your Discord webhook URL into discordWebhookUrls.`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`config.json is not valid JSON: ${err.message}`);
  }
}

const cfg = loadConfig();
// .env next to this script fills any variable not already set in the
// real environment, so real env vars always win (standard convention).
loadEnvFile();
const webhookUrls = resolveWebhookUrls();

function resolveWebhookUrls() {
  const fromEnv = process.env.STANDUP_WEBHOOK;
  const urls = fromEnv ? fromEnv.split(',').map(s => s.trim()).filter(Boolean) : cfg.discordWebhookUrls || [];
  return urls.filter(u => u && !u.includes('PASTE_'));
}

function loadEnvFile() {
  const path = join(HERE, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

// GitHub token: explicit env var wins, then config, then the brain-mcp config
// (reusing that PAT avoids a second credential and already has repo scope).
function resolveGitHubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (cfg.githubToken) return cfg.githubToken;
  if (cfg.githubTokenSource && existsSync(cfg.githubTokenSource)) {
    try {
      return JSON.parse(readFileSync(cfg.githubTokenSource, 'utf8')).token || null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------- Dates ----------

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  const c = new Date(d);
  c.setDate(c.getDate() + n);
  return c;
}

function parseDateArg(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) fail(`--date must be YYYY-MM-DD, got "${s}"`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// A run before the early-morning cutoff is wrapping up the previous day;
// the scheduled task fires at 00:05, so "yesterday" is the default then.
function resolveTargetDay() {
  if (argDate) return parseDateArg(argDate);
  const now = new Date();
  const cutoff = cfg.earlyMorningCutoffHour ?? 6;
  return now.getHours() < cutoff ? addDays(startOfLocalDay(now), -1) : startOfLocalDay(now);
}

const targetDay = resolveTargetDay();
const dayStartMs = targetDay.getTime();
const dayEndMs = addDays(targetDay, 1).getTime();
const dayStartISO = new Date(dayStartMs).toISOString(); // GitHub API expects an absolute instant
const dayEndISO = new Date(dayEndMs).toISOString();
const dateKey = targetDay.toISOString().slice(0, 10);

// ---------- State (idempotency) ----------

function loadSentState() {
  if (!existsSync(SENT_STATE_PATH)) return { dates: [] };
  try {
    const j = JSON.parse(readFileSync(SENT_STATE_PATH, 'utf8'));
    return { dates: Array.isArray(j.dates) ? j.dates : [] };
  } catch {
    return { dates: [] };
  }
}

function saveSentState(state) {
  // Prune entries older than the retention window so the file stays small.
  const cutoff = addDays(new Date(), -STATE_RETENTION_DAYS).toISOString().slice(0, 10);
  state.dates = [...new Set([...state.dates, dateKey])].filter(d => d >= cutoff);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SENT_STATE_PATH, JSON.stringify(state, null, 2));
}

// ---------- Kilo sessions ----------

function extractUserTexts(entry) {
  const m = entry.message;
  if (!m || m.role !== 'user') return [];
  const c = m.content;
  let texts = [];
  if (typeof c === 'string') {
    texts = [c];
  } else if (Array.isArray(c)) {
    // Tool results arrive as tool_result blocks and are excluded by the type filter.
    texts = c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
  }
  // Drop CLI-internal wrappers (command tags like <command-name>...).
  return texts.map(t => t.trim()).filter(t => t.length > 0 && !t.startsWith('<'));
}

function parseSessionFile(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const session = {
    id: basename(filePath, '.jsonl'),
    cwd: null,
    summaryTitle: null,
    firstTopicEver: null,
    userMsgs: 0,
    assistantMsgs: 0,
    files: new Set(),
    firstTs: null,
    lastTs: null,
    // Work-in-progress signals: what kind of turn closed the day,
    // the last prompt if it went unanswered, and prompts the user
    // explicitly flagged as not-done-yet.
    lastTurnType: null,
    lastUserText: null,
    deferred: [],
    interrupted: false,
  };
  let inDayFirstText = null;
  let anyInDay = false;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tolerate torn last lines from an interrupted run
    }
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
    const inDay = Number.isFinite(ts) && ts >= dayStartMs && ts < dayEndMs;

    if (entry.type === 'summary' && typeof entry.summary === 'string' && inDay && !session.summaryTitle) {
      session.summaryTitle = entry.summary;
    }
    if (entry.cwd && !session.cwd) session.cwd = entry.cwd;

    if (entry.type === 'user' && !entry.isMeta && !entry.isSidechain) {
      const texts = extractUserTexts(entry);
      if (texts.length) {
        if (!session.firstTopicEver) session.firstTopicEver = texts[0];
        if (inDay) {
          anyInDay = true;
          const real = texts.filter(t => !INTERRUPT_MARKER.test(t));
          if (texts.some(t => INTERRUPT_MARKER.test(t))) {
            // Interruption closes the session on the user's side: the
            // last real prompt went unanswered.
            session.interrupted = true;
            session.lastTurnType = 'user';
          }
          if (real.length) {
            session.userMsgs += real.length;
            if (!inDayFirstText) inDayFirstText = real[0];
            session.lastTurnType = 'user';
            session.lastUserText = real[real.length - 1];
            for (const t of real) {
              if (DEFER_MARKERS.test(t)) session.deferred.push(t);
            }
          }
        }
      }
    }

    if (entry.type === 'assistant' && !entry.isSidechain) {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        let hadText = false;
        for (const block of content) {
          if (block?.type === 'text' && block.text?.trim()) hadText = true;
          if (block?.type === 'tool_use' && FILE_EDIT_TOOLS.has(block.name) && block.input?.file_path) {
            session.files.add(block.input.file_path);
          }
        }
        if (hadText && inDay) {
          anyInDay = true;
          session.assistantMsgs++;
          session.lastTurnType = 'assistant';
        }
      }
    }

    if (inDay && Number.isFinite(ts)) {
      if (session.firstTs === null || ts < session.firstTs) session.firstTs = ts;
      if (session.lastTs === null || ts > session.lastTs) session.lastTs = ts;
    }
  }

  // Prefer the in-day summary title, then the first in-day prompt, then the
  // session's first-ever prompt (sessions can span midnight).
  session.topic = session.summaryTitle || inDayFirstText || session.firstTopicEver || '(untitled session)';
  return anyInDay ? session : null;
}

// Only files modified on/after the target day can contain in-day lines, so
// mtime is a cheap pre-filter that avoids re-reading the whole history.
function scanSessionRoot(root) {
  const projectsDir = join(root.path, 'projects');
  if (!existsSync(projectsDir)) return [];
  const sessions = [];
  for (const proj of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projDir = join(projectsDir, proj.name);
    let entries;
    try {
      entries = readdirSync(projDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = join(projDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < dayStartMs) continue;
      const session = parseSessionFile(filePath);
      if (session) {
        session.rootLabel = root.label;
        session.projectDir = proj.name;
        sessions.push(session);
      }
    }
  }
  return sessions;
}

// Modern Kilo (>=7.x) stores sessions in a SQLite DB at
// ~/.local/share/kilo/kilo.db. This is a best-effort bridge: if the
// Python helper exists and Python is available, query the DB and merge
// the results with the jsonl-based sessions. The DB is the source of
// truth for recent activity; the jsonl files are kept as a fallback.
function scanKiloDb(dateKey) {
  const script = join(HERE, 'lib', 'query-kilo-sessions.py');
  if (!existsSync(script)) return [];
  try {
    const py = 'C:\\Python314\\python.exe';
    const raw = execSync(`"${py}" "${script}" --date ${dateKey}`, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(raw);
    if (result.error) {
      console.error(`[standup] kilo db: ${result.error}`);
      return [];
    }
    return (result.sessions || []).map(s => ({
      id: s.id,
      title: s.title,
      directory: s.directory,
      project: s.project,
      time_created: s.time_created,
      time_updated: s.time_updated,
      rootLabel: 'kilo-db',
      topic: s.topic || '(untitled session)',
      userMsgs: s.user_msgs || 0,
      assistantMsgs: s.assistant_msgs || 0,
      files: new Set(s.files_touched || []),
      firstTs: s.first_ts || null,
      lastTs: s.last_ts || null,
      lastTurnType: s.unfinished ? 'user' : (s.discussed_only ? 'assistant' : null),
      interrupted: s.interrupted || false,
      deferred: s.deferred || [],
      todos: s.todos || [],
    }));
  } catch (err) {
    console.error(`[standup] kilo db query failed: ${err.message}`);
    return [];
  }
}

function projectNameForSession(session) {
  const raw = session.directory || session.cwd || '';
  const wt = raw.replace(/[\\/]+$/, '');
  let idx = wt.toLowerCase().indexOf('/.kilo/worktrees/');
  if (idx === -1) idx = wt.toLowerCase().indexOf('\\.kilo\\worktrees\\');
  if (idx !== -1) {
    const before = wt.slice(0, idx);
    const base = before.split(/[\\/]/).filter(Boolean).pop();
    if (base) return base;
  }
  const base2 = basename(wt);
  return base2 || session.rootLabel || 'global';
}

// ---------- GitHub ----------

async function gh(path, token) {
  const headers = { 'User-Agent': 'daily-standup' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${path}`);
  }
  return res.json();
}

function firstLine(s) {
  return (s || '').split('\n').map(t => t.trim()).find(Boolean) || '(no message)';
}

// Second brain: commits on the notes repo, with per-commit file lists so the
// recap can name the actual notes added/updated.
async function fetchSecondBrainNotes(token) {
  const repo = cfg.secondBrainRepo;
  if (!repo) return { notes: [], otherFiles: 0 };
  const commits = await gh(`/repos/${repo}/commits?since=${encodeURIComponent(dayStartISO)}&until=${encodeURIComponent(dayEndISO)}&per_page=100`, token);
  const notes = [];
  let otherFiles = 0;
  for (const commit of commits) {
    let files = [];
    try {
      const detail = await gh(`/repos/${repo}/commits/${commit.sha}`, token);
      files = detail.files || [];
    } catch {
      continue; // a single unreadable commit must not kill the whole recap
    }
    const message = firstLine(commit.commit.message);
    for (const f of files) {
      if (f.filename.endsWith('.md')) {
        notes.push({ path: f.filename, status: f.status, message, sha: commit.sha.slice(0, 7), url: commit.html_url });
      } else {
        otherFiles++;
      }
    }
  }
  return { notes: notes.slice(0, MAX_NOTES_LISTED), otherFiles, totalNotes: notes.length };
}

// All repos the user owns (private included when a token is available),
// filtered to those pushed on the target day, then commit-listed per repo.
async function fetchGitHubCommits(login, token) {
  const repos = [];
  let usedFallback = false;

  if (token) {
    const owned = await gh('/user/repos?per_page=100&sort=pushed&affiliation=owner', token);
    for (const r of owned) {
      if (Date.parse(r.pushed_at) >= dayStartMs && Date.parse(r.pushed_at) < dayEndMs) {
        repos.push({ fullName: r.full_name, private: !!r.private, createdAt: r.created_at });
      }
    }
  } else {
    // Unauthenticated: public events only, but they still carry repo names,
    // commit messages, and repository-creation events.
    usedFallback = true;
    const events = await gh(`/users/${login}/events/public?per_page=100`, null);
    for (const e of events) {
      const at = Date.parse(e.created_at);
      if (!(at >= dayStartMs && at < dayEndMs)) continue;
      if (e.type === 'PushEvent') {
        const existing = repos.find(r => r.fullName === e.repo.name);
        if (!existing) repos.push({ fullName: e.repo.name, private: false, createdAt: null });
      }
      if (e.type === 'CreateEvent' && e.payload?.ref_type === 'repository') {
        const existing = repos.find(r => r.fullName === e.repo.name);
        if (!existing) repos.push({ fullName: e.repo.name, private: false, createdAt: e.created_at });
      }
    }
  }

  const out = [];
  let totalCommits = 0;
  for (const r of repos) {
    let commits = [];
    try {
      commits = await gh(`/repos/${r.fullName}/commits?since=${encodeURIComponent(dayStartISO)}&until=${encodeURIComponent(dayEndISO)}&author=${encodeURIComponent(login)}&per_page=100`, token);
    } catch {
      continue;
    }
    // A push can carry co-authored or bot commits; if the author filter hides
    // them all, fall back to everything pushed that day so nothing is lost.
    if (commits.length === 0 && token) {
      try {
        commits = await gh(`/repos/${r.fullName}/commits?since=${encodeURIComponent(dayStartISO)}&until=${encodeURIComponent(dayEndISO)}&per_page=100`, token);
      } catch {
        continue;
      }
    }
    if (!commits.length) continue;
    const items = commits.map(c => ({
      message: firstLine(c.commit.message),
      sha: c.sha.slice(0, 7),
      url: c.html_url,
    }));
    totalCommits += items.length;
    out.push({ repo: r.fullName, private: r.private, createdRepo: !!r.createdAt && Date.parse(r.createdAt) >= dayStartMs, commits: items });
  }
  return { repos: out, totalCommits, usedFallback };
}

// ---------- Projects share ----------

function scanProjects(projectsRoot) {
  const newDirs = [];
  const touchedDirs = [];
  if (!projectsRoot || !existsSync(projectsRoot)) return { newDirs, touchedDirs };
  for (const d of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    let st;
    try {
      st = statSync(join(projectsRoot, d.name));
    } catch {
      continue;
    }
    // birthtime on SMB reflects the server-side creation time; mtime catches
    // anything modified in place, which is the best "active" signal available.
    if (st.birthtimeMs >= dayStartMs && st.birthtimeMs < dayEndMs) newDirs.push(d.name);
    if (st.mtimeMs >= dayStartMs && st.mtimeMs < dayEndMs) touchedDirs.push(d.name);
  }
  return { newDirs, touchedDirs };
}

// ---------- Formatting ----------

function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// Join list items within a character budget, reporting how many were cut.
// Discord field/description caps are per-string, so per-item counts
// matter more than character-exact truncation.
function truncateLines(items, max) {
  const lines = [];
  let len = 0;
  for (const item of items) {
    const add = item.length + (lines.length ? 1 : 0);
    if (len + add > max) break;
    lines.push(item);
    len += add;
  }
  let out = lines.join('\n');
  const hidden = items.length - lines.length;
  if (hidden > 0) out += `\n…and ${hidden} more`;
  return out;
}

function timeOfDay(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function relPath(p) {
  const roots = [cfg.projectsRoot, ...(cfg.sessionRoots || []).map(r => r.path)].filter(Boolean);
  const lower = p.toLowerCase();
  for (const root of roots) {
    if (lower.startsWith(root.toLowerCase())) {
      const rel = relative(root, p);
      if (rel && !rel.startsWith('..') && !rel.startsWith('/')) return rel;
    }
  }
  return p;
}

function sessionLine(s) {
  const parts = [`[${timeOfDay(s.firstTs)}] ${truncate(s.topic, 110)}`];
  const meta = [];
  const turns = s.userMsgs + s.assistantMsgs;
  if (turns > 0) meta.push(plural(turns, 'turn'));
  if (s.files.size > 0) meta.push(plural(s.files.size, 'file'));
  if (s.firstTs !== null && s.lastTs !== null && s.lastTs > s.firstTs) {
    const mins = Math.max(1, Math.round((s.lastTs - s.firstTs) / 60000));
    meta.push(`${mins}m`);
  }
  return `• ${parts.join('')}${meta.length ? ` _(${meta.join(', ')})_` : ''} — ${s.rootLabel}`;
}

// Work the user started but did not finish:
// - unanswered: the day's last turn was the user's, so the final
//   prompt never got a reply (session killed or interrupted mid-task)
// - discussed: real back-and-forth but zero files edited — planning
//   that never landed in code
// - deferred: prompts where the user explicitly said "later / TODO /
//   next time" etc.
function classifyPending(sessions) {
  const pending = { unanswered: [], discussed: [], deferred: [] };
  for (const s of sessions) {
    if (s.lastTurnType === 'user' && (s.userMsgs > 0 || s.interrupted)) {
      pending.unanswered.push(s);
    } else if (s.files.size === 0 && (s.userMsgs + s.assistantMsgs) >= 4) {
      // Short exchanges are finished Q&A; only longer back-and-forth
      // with nothing to show counts as work that never landed.
      pending.discussed.push(s);
    }
    for (const text of s.deferred) {
      pending.deferred.push({ session: s, text });
    }
  }
  return pending;
}

function pendingLine(s, detail) {
  const head = `[${timeOfDay(s.firstTs)}] ${s.project}: ${truncate(s.topic, 90)}`;
  return `• ${head}${detail ? ` — ${detail}` : ''}`;
}

function autoNarrative(d) {
  const parts = [];
  if (d.sessions.length) {
    const projects = new Set(d.sessions.map(s => s.project));
    parts.push(`${plural(d.sessions.length, 'Kilo session')} across ${plural(projects.size, 'project')}`);
    const counts = {};
    for (const s of d.sessions) counts[s.project] = (counts[s.project] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (top) parts.push(`most active: ${top[0]} (${plural(top[1], 'session')})`);
  }
  const unfinished = d.pending.unanswered.length + d.pending.discussed.length;
  if (unfinished) parts.push(`${plural(unfinished, 'session')} left unfinished`);
  if (d.github.totalCommits) {
    parts.push(`${plural(d.github.totalCommits, 'commit')} pushed to ${plural(d.github.repos.length, 'repo')}`);
  }
  if (d.brain.totalNotes) parts.push(`${plural(d.brain.totalNotes, 'second-brain note')} added or updated`);
  if (d.allFiles.length) parts.push(plural(d.allFiles.length, 'file') + ' edited');
  if (d.newProjects.length) parts.push(`new project${d.newProjects.length > 1 ? 's' : ''}: ${d.newProjects.join(', ')}`);
  if (!parts.length) return 'No recorded activity for this day.';
  const text = parts.join('; ');
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

function buildEmbeds(data, dateLabel) {
  if (data.quiet) {
    return [{
      title: `Daily Recap — ${dateLabel}`,
      description: 'Quiet day — no Kilo sessions, commits, notes, or new projects recorded.',
      color: 0xd29922,
      footer: { text: dateKey },
    }];
  }

  const stats = [
    ['Kilo sessions', data.sessions.length],
    ['Projects updated', data.projectsUpdated.length],
    ['Files touched', data.allFiles.length],
    ['Brain notes', data.brain.totalNotes],
    ['Commits', data.github.totalCommits],
    ['Repos pushed', data.github.repos.length],
    ['New projects', data.newProjects.length],
    ['Not finished', data.pending.unanswered.length + data.pending.discussed.length],
  ].filter(([, v]) => v > 0);

  return [{
    title: `Daily Recap — ${dateLabel}`,
    description: truncate(data.narrative || autoNarrative(data), EMBED_DESCRIPTION_LIMIT),
    color: 0x58a6ff,
    fields: stats.map(([name, value]) => ({ name, value: String(value), inline: true })),
    footer: { text: dateKey },
  }];
}

// ---------- Optional LLM narrative ----------

async function llmNarrative(data) {
  // Optional prose summary. Enable by pointing STANDUP_LLM_API_URL at
  // any OpenAI-compatible /chat/completions endpoint (e.g. the local
  // ModelRouter proxy); unset = the rule-based narrative is used.
  const apiUrl = process.env.STANDUP_LLM_API_URL || cfg.summarize?.apiUrl;
  if (!apiUrl) return null;
  const apiKey = process.env.STANDUP_LLM_API_KEY
    || (cfg.summarize?.apiKeyEnv ? process.env[cfg.summarize.apiKeyEnv] : null);
  const model = process.env.STANDUP_LLM_MODEL || cfg.summarize?.model || 'default';
  const digest = [
    `Date: ${dateKey}`,
    '',
    'Kilo sessions:',
    ...data.sessions.map(x => `- ${x.project}: ${x.topic} (${x.userMsgs} user msgs, ${x.assistantMsgs} replies, ${x.files.size} files)`),
    '',
    'Files touched:',
    ...data.allFiles.slice(0, 30).map(f => `- ${f}`),
    '',
    'Second brain notes:',
    ...data.brain.notes.map(n => `- ${n.message} (${n.path})`),
    '',
    'GitHub commits:',
    ...data.github.repos.flatMap(r => r.commits.map(c => `- ${r.repo}: ${c.message}`)),
  ].join('\n');

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers,
      body: JSON.stringify({
        model,
        max_tokens: 500,
        messages: [
          { role: 'system', content: 'Summarize the user\'s workday from the raw activity digest. Two to four sentences, plain prose, no bullet lists, no preamble.' },
          { role: 'user', content: digest.slice(0, 12000) },
        ],
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null; // fall back to the rule-based narrative
  }
}

// ---------- Discord delivery ----------

async function sendToWebhook(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('retry-after') || 1);
    await new Promise(r => setTimeout(r, Math.min(retryAfter, 15) * 1000));
    return sendToWebhook(url, payload);
  }
  if (!res.ok) {
    throw new Error(`webhook ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function sendEmbeds(embeds) {
  // Discord caps a webhook message at 10 embeds; longer recaps ship as
  // sequential messages, which read fine in a channel thread.
  for (let i = 0; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
    const chunk = embeds.slice(i, i + EMBEDS_PER_MESSAGE);
    if (i > 0) await new Promise(r => setTimeout(r, 300));
    for (const url of webhookUrls) {
      await sendToWebhook(url, { embeds: chunk });
    }
  }
}

// ---------- Main ----------

function fail(message) {
  console.error(`[standup] ${message}`);
  process.exit(1);
}

async function main() {
  if (!dryRun && webhookUrls.length === 0) {
    fail('no Discord webhook configured. Put your webhook URL in config.json (discordWebhookUrls) or set STANDUP_WEBHOOK.');
  }

  const state = loadSentState();
  if (!dryRun && !force && state.dates.includes(dateKey)) {
    console.log(`[standup] ${dateKey} already sent — nothing to do.`);
    return;
  }

  const token = resolveGitHubToken();

  const sessions = [];
  for (const root of cfg.sessionRoots || []) {
    sessions.push(...scanSessionRoot(root));
  }
  // Modern Kilo stores recent sessions in a SQLite DB at
  // ~/.local/share/kilo/kilo.db. The jsonl files are often stale or
  // cleaned up, so the DB is the authoritative source for today's work.
  const dbSessions = scanKiloDb(dateKey);
  sessions.push(...dbSessions);

  sessions.sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
  for (const s of sessions) {
    s.project = projectNameForSession(s);
  }

  const allFiles = [...new Set(sessions.flatMap(s => [...s.files]))].map(relPath).sort();

  const brain = await fetchSecondBrainNotes(token).catch(err => {
    console.error(`[standup] second brain fetch failed: ${err.message}`);
    return { notes: [], otherFiles: 0, totalNotes: 0 };
  });

  const github = await fetchGitHubCommits(cfg.githubUsername, token).catch(err => {
    console.error(`[standup] GitHub fetch failed: ${err.message}`);
    return { repos: [], totalCommits: 0, usedFallback: false };
  });

  const { newDirs } = scanProjects(cfg.projectsRoot);
  const sessionProjects = [...new Set(sessions.map(s => s.project))];
  const commitRepos = [...new Set(github.repos.filter(r => r.commits.length).map(r => r.repo.split('/')[1]))];
  const newProjectNames = [...new Set([
    ...newDirs,
    ...github.repos.filter(r => r.createdRepo).map(r => r.repo.split('/')[1]),
  ])];
  const projectsUpdated = [...new Set([...sessionProjects, ...commitRepos, ...newProjectNames])].sort();
  const newProjects = newProjectNames.sort();

  const data = {
    sessions,
    allFiles,
    brain,
    github,
    newProjects,
    projectsUpdated,
    pending: classifyPending(sessions),
    quiet: sessions.length === 0 && brain.totalNotes === 0 && github.totalCommits === 0 && newProjects.length === 0,
  };

  data.narrative = await llmNarrative(data);

  const dateLabel = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }).format(targetDay);
  const embeds = buildEmbeds(data, dateLabel);

  if (dryRun) {
    console.log(`[standup] dry run for ${dateKey} — would send ${embeds.length} embed(s):\n`);
    for (const e of embeds) {
    console.log(`--- ${e.title} ---`);
    if (e.description) console.log(e.description);
    for (const f of e.fields || []) console.log(`  ${f.name}: ${f.value}`);
    if (e.footer?.text) console.log(`  [${e.footer.text}]`);
    console.log('');
    }
    return;
  }

  await sendEmbeds(embeds);
  saveSentState(state);

  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LAST_RUN_PATH, JSON.stringify({
    ranAt: new Date().toISOString(),
    targetDate: dateKey,
    sent: true,
    counts: {
      sessions: sessions.length,
      files: allFiles.length,
      brainNotes: brain.totalNotes,
      commits: github.totalCommits,
      newProjects: newProjects.length,
    },
  }, null, 2));

  console.log(`[standup] sent ${dateKey} recap: ${plural(sessions.length, 'session')}, ${plural(github.totalCommits, 'commit')}, ${plural(brain.totalNotes, 'note')}.`);
}

main().catch(err => fail(err.stack || err.message));
