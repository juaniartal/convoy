// --- Config ---
const POLL_MS = 5000; // polling our own backend, not GitHub — no rate limit concern here
// Cards older than this get a muted look and sink to the bottom on sort —
// never hidden outright. A repo that's gone quiet still belongs on the
// board with its last known state; disappearing entirely reads as "broken",
// not "idle." See README/CONTRIBUTING for the reasoning.
const STALE_AFTER_HOURS = 48;

// --- State ---
let currentTab = 'deploys';
let currentFilter = 'all';
let searchQuery = '';
let hideInactive = false;
let lastRuns = [];
let lastError = null;
let lastFetchedAt = null;
const prevBuckets = new Map(); // run id -> bucket, to flash on change across polls

// --- Status vocabulary (mirrors the backend's stateOf/classify semantics) ---

function stateOf(run) {
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return 'success';
    if (run.conclusion === 'skipped') return 'skipped';
    if (run.conclusion === 'cancelled') return 'cancelled';
    return 'failure';
  }
  if (run.status === 'in_progress') return 'running';
  return 'queued';
}

const ICON = {
  success: '✓',
  failure: '✕',
  running: '●',
  queued: '○',
  skipped: '–',
  cancelled: '–',
};
const BADGE_LABEL = {
  success: 'Arrived',
  failure: 'Down',
  running: 'Rolling',
  queued: 'Staged',
  skipped: 'Skip',
  cancelled: 'Pulled',
};

// Card border/badge color bucket — skipped and cancelled share the same
// "pulled" visual treatment (neither is a real failure).
function styleBucket(label) {
  return {
    success: 'arrived',
    failure: 'down',
    running: 'rolling',
    queued: 'staged',
    skipped: 'pulled',
    cancelled: 'pulled',
  }[label];
}

// Top-line counts fold cancelled into "down" (it still needs a human look)
// and skipped into "staged" (it's a resolved-but-uninteresting state), to
// keep the summary bar at four numbers.
function countBucket(label) {
  return {
    success: 'arrived',
    failure: 'down',
    cancelled: 'down',
    running: 'rolling',
    queued: 'staged',
    skipped: 'staged',
  }[label];
}

function fmtDur(a, b) {
  if (!a) return '';
  const s = new Date(a),
    e = b ? new Date(b) : new Date();
  const secs = Math.max(0, Math.round((e - s) / 1000));
  return secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm' + (secs % 60) + 's';
}

function fmtAgo(iso) {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

function isStale(run) {
  return Date.now() - new Date(run.updatedAt).getTime() > STALE_AFTER_HOURS * 3600_000;
}

// --- Fetch ---

async function fetchState() {
  try {
    const params = new URLSearchParams({ view: currentTab });
    if (searchQuery) params.set('q', searchQuery);
    if (hideInactive) params.set('maxAgeHours', String(STALE_AFTER_HOURS));
    const res = await fetch(`/api/state?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastRuns = data.runs;
    lastError = null;
    lastFetchedAt = Date.now();
  } catch (err) {
    lastError = err.message || 'fetch failed';
  }
  render();
}

function setTab(tab) {
  currentTab = tab;
  document
    .querySelectorAll('.tab')
    .forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  prevBuckets.clear();
  fetchState();
}

function setFilter(f) {
  currentFilter = f;
  render();
}

function onSearchInput(value) {
  searchQuery = value;
  fetchState();
}

function onToggleHideInactive(checked) {
  hideInactive = checked;
  fetchState();
}

// --- Rendering ---

function countBuckets(runs) {
  const c = { arrived: 0, down: 0, rolling: 0, staged: 0, total: runs.length };
  for (const run of runs) c[countBucket(stateOf(run))]++;
  return c;
}

function render() {
  renderSummary();
  renderProgress();
  renderGrid();
}

function renderSummary() {
  const c = countBuckets(lastRuns);
  const el = document.getElementById('summary');
  const liveState = lastError ? 'error' : 'live';
  const liveLabel = lastError ? 'ERROR' : 'LIVE';
  const updatedText = lastFetchedAt
    ? `· updated ${Math.max(0, Math.round((Date.now() - lastFetchedAt) / 1000))}s ago`
    : '';

  const filters = [
    ['all', 'All'],
    ['down', 'Down'],
    ['rolling', 'Rolling'],
    ['staged', 'Staged'],
  ]
    .map(
      ([f, label]) =>
        `<button class="ghost ${currentFilter === f ? 'active' : ''}" onclick="setFilter('${f}')">${label}</button>`,
    )
    .join('');

  el.innerHTML = `
    <div class="ctrl-row">
      <span class="live-tag"><span class="live-dot ${liveState}"></span>${liveLabel}</span>
      <span class="headline">${c.total} ${currentTab}</span>
      <span class="pill green">${c.arrived} arrived</span>
      <span class="pill red">${c.down} down</span>
      <span class="pill yellow">${c.rolling} rolling</span>
      <span class="pill gray">${c.staged} staged</span>
      <span class="muted" id="updatedText">${updatedText}</span>
      ${lastError ? `<span class="muted">(${lastError})</span>` : ''}
      <div class="ctrl-actions">
        <label class="toggle"><input type="checkbox" ${hideInactive ? 'checked' : ''}
          onchange="onToggleHideInactive(this.checked)"> Hide inactive (48h+)</label>
        <input class="search" type="search" placeholder="Search repo or tag…" value="${escapeAttr(searchQuery)}"
          oninput="onSearchInput(this.value)">
      </div>
    </div>
    <div class="filter-row">${filters}</div>
  `;
}

function renderProgress() {
  const c = countBuckets(lastRuns);
  const track = document.getElementById('progressTrack');
  if (!c.total) {
    track.innerHTML = '';
    return;
  }
  const seg = (n, cls) =>
    n ? `<div class="progress-seg ${cls}" style="width:${(n / c.total) * 100}%"></div>` : '';
  track.innerHTML =
    seg(c.arrived, 'arrived') +
    seg(c.down, 'down') +
    seg(c.rolling, 'rolling') +
    seg(c.staged, 'staged');
}

function cardHtml(run) {
  const label = stateOf(run);
  const bucket = styleBucket(label);
  const prevBucket = prevBuckets.get(run.id);
  const flashClass = prevBucket && prevBucket !== bucket ? `flash-${bucket}` : '';
  prevBuckets.set(run.id, bucket);
  const staleClass = isStale(run) ? 'stale' : '';

  const jobs = (run.jobs || [])
    .map((j) => {
      const js = stateOf({ status: j.status, conclusion: j.conclusion });
      const jb = styleBucket(js);
      const startedAttr = j.startedAt && !j.completedAt ? `data-started="${j.startedAt}"` : '';
      return `
        <div class="job">
          <div class="job-node ${jb}">${ICON[js]}</div>
          <div class="job-name">${j.name} <span class="dur" ${startedAttr}>${fmtDur(j.startedAt, j.completedAt)}</span></div>
        </div>`;
    })
    .join('');

  const jobsTotal = (run.jobs || []).length;
  const jobsDone = (run.jobs || []).filter((j) => {
    const s = stateOf({ status: j.status, conclusion: j.conclusion });
    return s !== 'running' && s !== 'queued';
  }).length;

  const runStartedAttr = label === 'running' ? `data-started="${run.createdAt}"` : '';
  const runDur = fmtDur(run.createdAt, label === 'running' ? null : run.updatedAt);
  const actorLine = run.actor ? `<div class="run-actor">by ${run.actor}</div>` : '';

  return `
    <div class="run ${bucket} ${staleClass} ${flashClass}">
      <div class="run-head">
        <div>
          <div class="run-repo">${run.repo}</div>
          <div class="run-ref">${run.headBranch ?? run.event} · <span class="dur" ${runStartedAttr}>${runDur}</span></div>
          ${actorLine}
        </div>
        <div class="run-actions">
          <span class="badge ${bucket}">${BADGE_LABEL[label]}</span>
          <a href="${run.htmlUrl}" target="_blank" title="open on GitHub">↗</a>
        </div>
      </div>
      <div class="jobs">${jobs || '<span class="msg">no job detail yet</span>'}</div>
      ${jobsTotal ? `<div class="job-progress">${jobsDone}/${jobsTotal} jobs</div>` : ''}
      <div class="run-updated">updated ${fmtAgo(run.updatedAt)}</div>
    </div>`;
}

function renderGrid() {
  const grid = document.getElementById('grid');
  const runs = lastRuns.filter(
    (r) => currentFilter === 'all' || countBucket(stateOf(r)) === currentFilter,
  );

  grid.innerHTML =
    runs.map(cardHtml).join('') ||
    `<div class="empty-msg">${lastRuns.length ? 'Nothing matches this filter.' : 'No runs seen yet — waiting on webhooks / first reconciliation pass.'}</div>`;

  setTimeout(() => {
    grid.querySelectorAll('[class*="flash-"]').forEach((el) => {
      el.className = el.className.replace(/\bflash-[a-z]+\b/g, '').trim();
    });
  }, 1500);
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function tick() {
  document.querySelectorAll('.dur[data-started]').forEach((el) => {
    el.textContent = fmtDur(el.dataset.started, null);
  });
  const updatedEl = document.getElementById('updatedText');
  if (updatedEl && lastFetchedAt) {
    updatedEl.textContent = `· updated ${Math.max(0, Math.round((Date.now() - lastFetchedAt) / 1000))}s ago`;
  }
}

fetchState();
setInterval(fetchState, POLL_MS);
setInterval(tick, 1000);
