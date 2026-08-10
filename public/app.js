// --- Config ---
const POLL_MS = 5000; // polling our own backend, not GitHub — no rate limit concern here
// A repo's row gets a muted look once ALL its pipelines have gone this long
// without an update — never hidden outright. A repo that's gone quiet still
// belongs on the board with its last known state; disappearing entirely
// reads as "broken", not "idle."
const STALE_AFTER_HOURS = 48;
// Deploy-category runs that started within this window of the most recent
// one are treated as "the current release" — the Deploys tab shows just
// that by default, the same scoped view the old paste-a-list tool gave you,
// derived automatically instead of pasted.
const RELEASE_WINDOW_MS = 60 * 60 * 1000;

// Worst-first: a repo's overall dot reflects whichever of its pipelines
// needs the most attention, not just its most recent one.
const BUCKET_PRIORITY = ['down', 'rolling', 'pulled', 'staged', 'arrived'];

// A repo with many concurrent branches (qa/sandbox/feature-*/...) can easily
// have a dozen live pipelines at once — a card showing all of them by
// default becomes a wall of text you can't scan alongside the other repos.
// Preview the most recent few on the card; the repo's own detail page (one
// click away) always shows the full list.
const CARD_PREVIEW_LIMIT = 5;

// --- State ---
let currentTab = 'deploys';
let currentFilter = 'all';
let searchQuery = '';
let hideInactive = false;
let showAllDeploys = false;
let lastRuns = [];
let installedRepos = []; // every repo the GitHub App is installed on, regardless of activity
let lastError = null;
let lastFetchedAt = null;
let selectedRepo = repoFromHash(); // null = grid view; otherwise a repo full name
let favoritesOnly = false;
const favorites = new Set(JSON.parse(localStorage.getItem('convoy-favorites') || '[]'));
const prevBuckets = new Map(); // run id -> bucket, to flash a pipeline card on change
const prevRepoOverall = new Map(); // repo -> overall bucket, to flash a repo card on change

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

// Small inline vectors instead of Unicode glyphs — consistent stroke width
// and alignment across platforms/fonts, and they pick up the job-node's
// color via currentColor rather than needing their own color rules.
const ICON = {
  success: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  failure: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  running: '<svg viewBox="0 0 16 16" width="9" height="9"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>',
  queued: '<svg viewBox="0 0 16 16" width="9" height="9"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  skipped: '<svg viewBox="0 0 16 16" width="11" height="7"><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  cancelled: '<svg viewBox="0 0 16 16" width="11" height="7"><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};
const BADGE_LABEL = {
  success: 'Arrived',
  failure: 'Down',
  running: 'Rolling',
  queued: 'Staged',
  skipped: 'Skip',
  cancelled: 'Pulled',
};

// Card/pip/dot color bucket — skipped and cancelled share the same "pulled"
// visual treatment (neither is a real failure).
function styleBucket(label) {
  return { success: 'arrived', failure: 'down', running: 'rolling', queued: 'staged', skipped: 'pulled', cancelled: 'pulled' }[
    label
  ];
}

// The 4-number summary folds "pulled" into "staged" to stay at four
// countable buckets — a cancelled/skipped pipeline isn't urgent, but a real
// failure anywhere in a repo (even alongside other healthy pipelines) still
// counts that whole repo as "down".
function foldForCount(bucket) {
  return bucket === 'pulled' ? 'staged' : bucket;
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

// --- Navigation: grid of repo cards is the default view; clicking one
// drills into a dedicated page for just that repo. Backed by the URL hash
// so it survives a refresh and works with the browser's back button. ---

function repoFromHash() {
  const m = /^#repo\/(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function openRepo(repo) {
  location.hash = `repo/${encodeURIComponent(repo)}`;
}

function closeRepo() {
  history.pushState('', document.title, window.location.pathname + window.location.search);
  selectedRepo = null;
  render();
}

window.addEventListener('hashchange', () => {
  selectedRepo = repoFromHash();
  render();
});

// --- Theme: the inline script in <head> already set data-theme before
// first paint (to avoid a flash); this just keeps the toggle button's
// label in sync and persists explicit choices. ---

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('convoy-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.innerHTML = theme === 'dark' ? '<span>☀ Light mode</span>' : '<span>🌙 Dark mode</span>';
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// --- Favorites: which repos you personally care about most, kept in this
// browser only (not shared with anyone else hitting the same instance). ---

function toggleFavorite(repo) {
  if (favorites.has(repo)) favorites.delete(repo);
  else favorites.add(repo);
  localStorage.setItem('convoy-favorites', JSON.stringify([...favorites]));
  render();
}

function onToggleFavoritesOnly() {
  favoritesOnly = !favoritesOnly;
  render();
}

function starHtml(repo) {
  const fav = favorites.has(repo);
  return `<button class="star-btn ${fav ? 'active' : ''}" onclick="event.stopPropagation(); toggleFavorite('${repo}')" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${fav ? '★' : '☆'}</button>`;
}

// --- Fetch ---

async function fetchState() {
  try {
    const params = new URLSearchParams({ view: currentTab });
    if (searchQuery) params.set('q', searchQuery);
    if (hideInactive) params.set('maxAgeHours', String(STALE_AFTER_HOURS));
    const [stateRes, reposRes] = await Promise.all([fetch(`/api/state?${params}`), fetch('/api/repos')]);
    if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
    const data = await stateRes.json();
    lastRuns = data.runs;
    if (reposRes.ok) installedRepos = (await reposRes.json()).repos;
    lastError = null;
    lastFetchedAt = Date.now();
  } catch (err) {
    lastError = err.message || 'fetch failed';
  }
  render();
}

function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  prevBuckets.clear();
  prevRepoOverall.clear();
  fetchState();
}

function setFilter(f) {
  currentFilter = f;
  // Picking a filter always means "show me the board", so drop out of a
  // single-repo detail page if one was open.
  if (selectedRepo) {
    selectedRepo = null;
    history.pushState('', document.title, window.location.pathname + window.location.search);
  }
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

function onToggleShowAllDeploys() {
  showAllDeploys = !showAllDeploys;
  render();
}

// --- Grouping: repo-centric, ArgoCD-style — one card per repo, its
// pipelines summarized inside, instead of a flat list of individual runs. ---

function scopeToCurrentRelease(runs) {
  if (!runs.length) return runs;
  const newest = Math.max(...runs.map((r) => new Date(r.createdAt).getTime()));
  return runs.filter((r) => newest - new Date(r.createdAt).getTime() <= RELEASE_WINDOW_MS);
}

function currentRuns() {
  if (currentTab === 'deploys' && !showAllDeploys) return scopeToCurrentRelease(lastRuns);
  return lastRuns;
}

// Starts from every repo the App is installed on, not just repos that
// happen to have a run in the current tab/filter -- a repo that's never
// deployed (or never had a plain CI run) still belongs on the board, same
// as a repo that's gone quiet. Only exception: an active search narrows
// this down to matching repo names, so searching still searches.
function groupByRepo(runs, repos) {
  const q = searchQuery.toLowerCase().trim();
  const baseRepos = q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos;

  const byRepo = new Map();
  for (const repo of baseRepos) byRepo.set(repo.fullName, []);
  for (const run of runs) {
    if (!byRepo.has(run.repo)) byRepo.set(run.repo, []);
    byRepo.get(run.repo).push(run);
  }
  const groups = [...byRepo.entries()].map(([repo, pipelines]) => {
    pipelines.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const buckets = pipelines.map((p) => styleBucket(stateOf(p)));
    const overall = pipelines.length === 0 ? 'idle' : BUCKET_PRIORITY.find((b) => buckets.includes(b)) || 'arrived';
    const stale = pipelines.length > 0 && pipelines.every(isStale);
    return { repo, pipelines, overall, stale, latestUpdatedAt: pipelines[0]?.updatedAt ?? '' };
  });
  // Favorites float to the top regardless of activity -- that's the point
  // of marking them, so they don't get buried under noisier repos.
  groups.sort((a, b) => {
    const favDiff = Number(favorites.has(b.repo)) - Number(favorites.has(a.repo));
    return favDiff !== 0 ? favDiff : b.latestUpdatedAt.localeCompare(a.latestUpdatedAt);
  });
  return groups;
}

// On the Deploys tab these entries are releases, not "pipelines" — the
// Pipelines tab is the only place that word actually describes them.
function unitLabel() {
  return currentTab === 'deploys' ? 'deploy' : 'pipeline';
}

// --- Rendering ---

function countRepoBuckets(groups) {
  const c = { arrived: 0, down: 0, rolling: 0, staged: 0, total: groups.length };
  for (const g of groups) {
    if (g.overall === 'idle') continue; // no runs yet isn't a status to tally
    c[foldForCount(g.overall)]++;
  }
  return c;
}

function render() {
  const rawGroups = groupByRepo(currentRuns(), installedRepos);
  // "Hide inactive" means exactly that -- a repo with nothing current to
  // show (whether it never ran, or everything it has is older than the
  // cutoff) drops off the board entirely instead of sitting there as an
  // empty card. Detail pages still resolve normally via rawGroups, so a
  // direct link to a hidden repo doesn't break.
  const boardGroups = hideInactive ? rawGroups.filter((g) => g.pipelines.length > 0) : rawGroups;
  renderSummary(boardGroups);
  renderProgress(boardGroups);
  renderSidebarFilters(boardGroups);
  if (selectedRepo) {
    renderDetail(rawGroups.find((g) => g.repo === selectedRepo));
  } else {
    let visibleGroups =
      currentFilter === 'all' ? boardGroups : boardGroups.filter((g) => foldForCount(g.overall) === currentFilter);
    if (favoritesOnly) visibleGroups = visibleGroups.filter((g) => favorites.has(g.repo));
    renderGrid(visibleGroups);
  }
}

function renderSidebarFilters(groups) {
  const c = countRepoBuckets(groups);
  const el = document.getElementById('sidebarFilters');
  if (el) {
    el.innerHTML = [
      ['all', 'All', c.total],
      ['down', 'Down', c.down],
      ['rolling', 'Rolling', c.rolling],
      ['staged', 'Staged', c.staged],
    ]
      .map(
        ([f, label, count]) =>
          `<button class="sidebar-filter ${currentFilter === f ? 'active' : ''}" onclick="setFilter('${f}')">
            <span>${label}</span><span class="count">${count}</span>
          </button>`,
      )
      .join('');
  }
  const favBtn = document.getElementById('favToggle');
  if (favBtn) favBtn.classList.toggle('active', favoritesOnly);
}

function renderSummary(groups) {
  const c = countRepoBuckets(groups);
  const el = document.getElementById('summary');

  // renderSummary rebuilds the whole control bar's innerHTML on every poll,
  // which replaces the search <input> node outright — losing focus and
  // cursor position mid-keystroke if we don't save and restore them here.
  const searchEl = el.querySelector('.search');
  const hadFocus = document.activeElement === searchEl;
  const selStart = hadFocus ? searchEl.selectionStart : null;
  const selEnd = hadFocus ? searchEl.selectionEnd : null;
  const liveState = lastError ? 'error' : 'live';
  const liveLabel = lastError ? 'ERROR' : 'LIVE';
  const updatedText = lastFetchedAt
    ? `· updated ${Math.max(0, Math.round((Date.now() - lastFetchedAt) / 1000))}s ago`
    : '';
  const headline =
    currentTab === 'deploys'
      ? `${c.total} repos · ${showAllDeploys ? 'all deploys' : 'current release'}`
      : `${c.total} repos`;

  const deployToggle =
    currentTab === 'deploys'
      ? `<button class="ghost" onclick="onToggleShowAllDeploys()">${showAllDeploys ? 'Show current release only' : 'Show all deploys'}</button>`
      : '';

  el.innerHTML = `
    <div class="ctrl-row">
      <span class="live-tag"><span class="live-dot ${liveState}"></span>${liveLabel}</span>
      <span class="headline">${headline}</span>
      <span class="pill green">${c.arrived} arrived</span>
      <span class="pill red">${c.down} down</span>
      <span class="pill yellow">${c.rolling} rolling</span>
      <span class="pill gray">${c.staged} staged</span>
      <span class="muted" id="updatedText">${updatedText}</span>
      ${lastError ? `<span class="muted">(${lastError})</span>` : ''}
      <div class="ctrl-actions">
        ${deployToggle}
        <label class="toggle"><input type="checkbox" ${hideInactive ? 'checked' : ''}
          onchange="onToggleHideInactive(this.checked)"> Hide inactive (48h+)</label>
        <input class="search" type="search" placeholder="Search repo or tag…" value="${escapeAttr(searchQuery)}"
          oninput="onSearchInput(this.value)">
      </div>
    </div>
  `;

  if (hadFocus) {
    const newSearchEl = el.querySelector('.search');
    newSearchEl.focus();
    newSearchEl.setSelectionRange(selStart, selEnd);
  }
}

function renderProgress(groups) {
  const c = countRepoBuckets(groups);
  const track = document.getElementById('progressTrack');
  if (!c.total) {
    track.innerHTML = '';
    return;
  }
  const seg = (n, cls) => (n ? `<div class="progress-seg ${cls}" style="width:${(n / c.total) * 100}%"></div>` : '');
  track.innerHTML = seg(c.arrived, 'arrived') + seg(c.down, 'down') + seg(c.rolling, 'rolling') + seg(c.staged, 'staged');
}

function pipelineHtml(run) {
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
  const actorLine = run.actor ? `<span class="run-actor">by ${run.actor}</span>` : '';

  // Branch/tag is the heading, not the workflow name — plenty of real setups
  // trigger the exact same workflow ("Containerize and Deploy") from every
  // branch, so the name alone is often the least useful label in the row.
  // What actually differs, and what you're scanning for, is the ref.
  return `
    <div class="pipeline ${bucket} ${staleClass} ${flashClass}">
      <div class="pipeline-head">
        <div>
          <div class="pipeline-name">${run.headBranch ?? run.event}</div>
          <div class="run-ref">${run.workflowName} · <span class="dur" ${runStartedAttr}>${runDur}</span> ${actorLine}</div>
        </div>
        <div class="run-actions">
          <span class="badge ${bucket}">${BADGE_LABEL[label]}</span>
          <a href="${run.htmlUrl}" target="_blank" onclick="event.stopPropagation()" title="open run on GitHub">↗</a>
        </div>
      </div>
      <div class="jobs">${jobs || '<span class="msg">no job detail yet</span>'}</div>
      ${jobsTotal ? `<div class="job-progress">${jobsDone}/${jobsTotal} jobs</div>` : ''}
      <div class="run-updated">updated ${fmtAgo(run.updatedAt)}</div>
    </div>`;
}

// A compact row inside a repo card — just enough to recognize which
// pipeline it is and its current state at a glance. Full detail (jobs,
// duration, actor, link) lives on the repo's own detail page.
function cardPipelineRowHtml(run) {
  const b = styleBucket(stateOf(run));
  const ref = run.headBranch ?? run.event;
  return `
    <div class="card-pipeline-row ${b}">
      <div class="card-pipeline-text">
        <div class="card-pipeline-ref">${ref}</div>
        <div class="card-pipeline-workflow muted">${run.workflowName}</div>
      </div>
      <span class="badge ${b} small">${BADGE_LABEL[stateOf(run)]}</span>
    </div>`;
}

function repoCardHtml(group) {
  const { repo, pipelines, overall, stale } = group;
  const label = unitLabel();

  const prevOverall = prevRepoOverall.get(repo);
  const flashClass = prevOverall && prevOverall !== overall ? `flash-${overall}` : '';
  prevRepoOverall.set(repo, overall);

  if (pipelines.length === 0) {
    return `
      <div class="repo-card ${overall} ${flashClass}" onclick="openRepo('${repo}')">
        <div class="repo-card-head">
          <span class="repo-dot idle"></span>
          <span class="repo-name">${repo}</span>
          ${starHtml(repo)}
          <a href="https://github.com/${repo}" target="_blank" onclick="event.stopPropagation()" title="open repo on GitHub">↗</a>
        </div>
        <div class="repo-card-footer muted">No ${label}s have run yet.</div>
      </div>`;
  }

  const preview = pipelines.slice(0, CARD_PREVIEW_LIMIT);
  const hiddenCount = pipelines.length - preview.length;
  const more = hiddenCount > 0 ? `<div class="card-more">+${hiddenCount} more ${label}${hiddenCount === 1 ? '' : 's'}</div>` : '';

  return `
    <div class="repo-card ${overall} ${stale ? 'stale' : ''} ${flashClass}" onclick="openRepo('${repo}')">
      <div class="repo-card-head">
        <span class="repo-dot ${overall}"></span>
        <span class="repo-name">${repo}</span>
        ${starHtml(repo)}
        <a href="https://github.com/${repo}" target="_blank" onclick="event.stopPropagation()" title="open repo on GitHub">↗</a>
      </div>
      <div class="card-pipelines">${preview.map(cardPipelineRowHtml).join('')}</div>
      ${more}
      <div class="repo-card-footer muted">${pipelines.length} ${label}${pipelines.length === 1 ? '' : 's'} · updated ${fmtAgo(group.latestUpdatedAt)}</div>
    </div>`;
}

function renderGrid(groups) {
  const grid = document.getElementById('grid');
  grid.className = 'repo-grid';
  grid.innerHTML =
    groups.map(repoCardHtml).join('') ||
    `<div class="empty-msg">${lastRuns.length ? 'Nothing matches this filter.' : 'No runs seen yet — waiting on webhooks / first reconciliation pass.'}</div>`;

  setTimeout(() => {
    grid.querySelectorAll('[class*="flash-"]').forEach((el) => {
      el.className = el.className.replace(/\bflash-[a-z]+\b/g, '').trim();
    });
  }, 1500);
}

// The dedicated single-repo page — always shows every pipeline in full
// (jobs, duration, actor, link), no preview cap. This is the "click in to
// see everything running or failed for just this repo" view.
function renderDetail(group) {
  const grid = document.getElementById('grid');
  grid.className = '';

  const header = `
    <div class="detail-header">
      <button class="ghost" onclick="closeRepo()">← All repos</button>
      ${group ? `<span class="repo-name">${group.repo}</span>${starHtml(group.repo)}<a href="https://github.com/${group.repo}" target="_blank" title="open repo on GitHub">↗</a>` : ''}
    </div>`;

  if (!group) {
    grid.innerHTML = `${header}<div class="empty-msg">This repo has no ${unitLabel()}s in the current view.</div>`;
    return;
  }

  if (group.pipelines.length === 0) {
    grid.innerHTML = `${header}<div class="empty-msg">No ${unitLabel()}s have run yet.</div>`;
    return;
  }

  grid.innerHTML = `${header}<div class="repo-detail">${group.pipelines.map(pipelineHtml).join('')}</div>`;

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

applyTheme(currentTheme());
fetchState();
setInterval(fetchState, POLL_MS);
setInterval(tick, 1000);
