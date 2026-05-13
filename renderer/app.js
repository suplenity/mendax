'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const QUEUE_MAX    = 5;
const CIRCUMFERENCE = 2 * Math.PI * 85;

const THEMES = ['blue','black-white','black-red','black-pink','white-red','white-pink','orbs'];

const QUOTES = [
  "i jst be lying",
  "it means lying btw",
  "prob will get warned...",
  "insallah this app will work.",
  "hacked ur acc... jk",
  "lying to discord abt quests...",
  "i love u",
  "we love liars here",
  "liar liar, plants for hire.",
];

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  view:              'prep',
  selectedQuest:     null,
  allQuests:         [],   // raw from Discord
  quests:            [],   // filtered + sorted (what's rendered)
  queue:             [],
  questing:          false,
  progressStart:     null,
  elapsedInterval:   null,
  queuePanelOpen:    false,
  isAchievementQuest: false,
  hideCompleted:     localStorage.getItem('mendax-hide-completed') !== 'false', // default true
  sortBy:            localStorage.getItem('mendax-sort') || 'expiry',
  filterReward:      localStorage.getItem('mendax-filter-reward') || null, // null | 'orbs' | 'item'
};

// ─── Theme ────────────────────────────────────────────────────────────────────

const htmlEl       = document.documentElement;
const themePanelEl = document.getElementById('theme-panel');
const btnTheme     = document.getElementById('btn-theme');

function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'blue';
  htmlEl.setAttribute('data-theme', theme);
  localStorage.setItem('mendax-theme', theme);
  document.querySelectorAll('.theme-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === theme);
  });
  window.mendax.setTheme(theme);
}

applyTheme(localStorage.getItem('mendax-theme') || 'blue');

btnTheme.addEventListener('click', e => {
  e.stopPropagation();
  themePanelEl.classList.toggle('open');
});
document.addEventListener('click', () => themePanelEl.classList.remove('open'));
themePanelEl.addEventListener('click', e => e.stopPropagation());

document.querySelectorAll('.theme-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => {
    applyTheme(swatch.dataset.theme);
    setTimeout(() => themePanelEl.classList.remove('open'), 180);
  });
});

// ─── View Management ──────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const v = document.getElementById('view-' + id);
  if (v) v.classList.add('active');
  state.view = id;
  if (id !== 'progress') closeQueuePanel();
}

// ─── Prep Steps ───────────────────────────────────────────────────────────────

const prepStepsContainer = document.getElementById('prep-steps');
const renderedSteps      = new Map();

function ensurePrepStep(id, label) {
  if (renderedSteps.has(id)) return;
  const el = document.createElement('div');
  el.className = 'prep-step';
  el.style.animationDelay = (renderedSteps.size * 55) + 'ms';
  el.innerHTML = `<span class="step-dot"></span><span class="step-label">${esc(label)}</span>`;
  prepStepsContainer.appendChild(el);
  renderedSteps.set(id, el);
}

function setPrepStep(id, label, status) {
  ensurePrepStep(id, label);
  const el = renderedSteps.get(id);
  el.className = 'prep-step ' + status;
  el.querySelector('.step-label').textContent = label;
}

function markAllPrepDone() {
  renderedSteps.forEach(el => {
    if (!el.classList.contains('error')) el.className = 'prep-step done';
  });
}

function resetPrepUI() {
  renderedSteps.clear();
  prepStepsContainer.innerHTML = '';
  prepNotice.innerHTML = '';
}

// ─── Notices ──────────────────────────────────────────────────────────────────

const prepNotice = document.getElementById('prep-notice');

function showOfflineNotice() {
  prepNotice.innerHTML = `
    <div class="notice-banner offline">discord is not running.<br>launch discord first, then retry.</div>
    <button class="btn btn-primary retry-btn" id="btn-retry">&#8635; retry</button>`;
  document.getElementById('btn-retry')?.addEventListener('click', doRetry);
}

function showPrepError(msg) {
  prepNotice.innerHTML = `
    <div class="notice-banner warn">${esc(msg)}</div>
    <button class="btn btn-primary retry-btn" id="btn-retry">&#8635; retry</button>`;
  document.getElementById('btn-retry')?.addEventListener('click', doRetry);
}

async function doRetry() {
  resetPrepUI();
  const ok = await window.mendax.connect();
  if (ok) await window.mendax.refreshQuests();
}

// ─── Sort & Filter ────────────────────────────────────────────────────────────

function sortQuests(quests) {
  const sorted = [...quests];
  switch (state.sortBy) {
    case 'expiry':
      sorted.sort((a, b) => new Date(a.expiresAt) - new Date(b.expiresAt));
      break;
    case 'progress-desc':
      sorted.sort((a, b) => b.percent - a.percent);
      break;
    case 'progress-asc':
      sorted.sort((a, b) => a.percent - b.percent);
      break;
    case 'name':
      sorted.sort((a, b) => a.questName.localeCompare(b.questName));
      break;
  }
  return sorted;
}

function filterQuests(quests) {
  let out = quests;
  if (state.hideCompleted)           out = out.filter(q => !q.completed);
  if (state.filterReward === 'orbs') out = out.filter(q => q.rewardOrbs > 0);
  if (state.filterReward === 'item') out = out.filter(q => q.rewardOrbs === 0 && !!q.rewardName);
  return out;
}

function applyAndRender() {
  state.quests = filterQuests(sortQuests(state.allQuests));
  renderQuestCards(state.quests);
}

function syncFilterUI() {
  const btnHide  = document.getElementById('btn-hide-completed');
  const btnOrbs  = document.getElementById('btn-filter-orbs');
  const btnItems = document.getElementById('btn-filter-items');
  if (btnHide) {
    btnHide.textContent = state.hideCompleted ? 'show done' : 'hide done';
    btnHide.classList.toggle('active-filter', !state.hideCompleted);
  }
  if (btnOrbs)  btnOrbs.classList.toggle('active-filter',  state.filterReward === 'orbs');
  if (btnItems) btnItems.classList.toggle('active-filter', state.filterReward === 'item');
}

function syncSortUI() {
  const sel = document.getElementById('sort-select');
  if (sel) sel.value = state.sortBy;
}

// ─── Quest List ───────────────────────────────────────────────────────────────

const questListBody = document.getElementById('quest-list-body');
const questListSub  = document.getElementById('quest-list-sub');
const btnStartQuest = document.getElementById('btn-start-quest');
const btnAddQueue   = document.getElementById('btn-add-queue');
const btnRefresh    = document.getElementById('btn-refresh');
const btnStartAll   = document.getElementById('btn-start-all');

function renderQuestList(quests) {
  state.allQuests    = quests;
  state.selectedQuest = null;
  btnStartQuest.disabled = true;
  btnStartQuest.textContent = 'start';
  btnAddQueue.disabled   = true;

  applyAndRender();
  syncFilterUI();
  syncSortUI();
}

function renderQuestCards(quests) {
  questListBody.innerHTML = '';
  state.selectedQuest = null;
  btnStartQuest.disabled = true;
  btnStartQuest.textContent = 'start';
  btnAddQueue.disabled   = true;

  const enrolledActive = state.allQuests.filter(q => q.enrolled && !q.completed);
  btnStartAll.disabled = enrolledActive.length < 1 || state.questing;

  if (!quests || quests.length === 0) {
    const allCount = state.allQuests.length;
    const hiddenCount = allCount - (quests ? quests.length : 0);
    let hint = 'accept a quest then refresh...';
    if (hiddenCount > 0) {
      const tips = [];
      if (state.hideCompleted) tips.push('"show done" to see completed quests');
      if (state.filterReward)  tips.push(`clear the ${state.filterReward === 'orbs' ? 'orbs' : 'items'} filter`);
      hint = `${hiddenCount} quest${hiddenCount !== 1 ? 's' : ''} hidden by filter${tips.length ? ' — ' + tips.join(', or ') : ''}.`;
    }
    questListBody.innerHTML = `
      <div class="empty-state">
        <span class="headline">no quests to show.</span>
        ${hint}
      </div>`;
    questListSub.textContent = 'no quests found';
    return;
  }

  const total    = state.allQuests.length;
  const showing  = quests.length;
  questListSub.textContent = showing === total
    ? `${total} quest${total !== 1 ? 's' : ''} available`
    : `showing ${showing} of ${total} quests`;

  quests.forEach(quest => {
    const card = document.createElement('div');
    card.className = 'quest-card'
      + (quest.completed   ? ' quest-completed'   : '')
      + (!quest.enrolled   ? ' quest-unenrolled'  : '');
    card.dataset.id = quest.id;

    const daysLeft = Math.max(0, Math.floor((new Date(quest.expiresAt) - Date.now()) / 86400000));
    const pct      = quest.completed ? 100 : quest.percent;
    const typeCls  = taskBadgeClass(quest.taskName);
    const typeLbl  = taskTypeLabel(quest.taskName);

    const typeIconFile = taskIconFile(quest.taskName);
    const typeIconHtml = typeIconFile
      ? `<img src="icons/${typeIconFile}" class="qc-type-icon" alt="">`
      : '';

    let rewardHtml = '';
    if (quest.rewardOrbs > 0) {
      rewardHtml = `<span class="qc-dot">·</span><span class="qc-reward orbs"><img src="icons/orbs.gif" class="orb-icon" alt="">${quest.rewardOrbs.toLocaleString()} orbs</span>`;
    } else if (quest.rewardName) {
      rewardHtml = `<span class="qc-dot">·</span><span class="qc-reward item">${esc(quest.rewardName)}</span>`;
    }

    let statusHtml = '';
    if (quest.completed) {
      statusHtml = `<span class="qc-status done">complete</span>`;
    } else if (!quest.enrolled) {
      statusHtml = `<span class="qc-status unenrolled">not enrolled</span>`;
    }

    // Progress display — achievement quests show count, others show time
    const isAchievement = quest.taskName === 'ACHIEVEMENT_IN_ACTIVITY';
    const progressText  = isAchievement
      ? `${Math.floor(quest.secondsDone)} / ${Math.floor(quest.secondsNeeded)}`
      : `${fmtSec(quest.secondsDone)} / ${fmtSec(quest.secondsNeeded)}`;

    // Only show bar + time if there is actual progress or the quest is completed
    const showBar = pct > 0 || quest.completed;
    const barHtml = showBar ? `
      <div class="qc-bar">
        <div class="mini-bar"><div class="mini-bar-fill" style="width:${pct}%"></div></div>
        <span class="qc-pct">${progressText}</span>
      </div>` : '';

    card.innerHTML = `
      <div class="qc-header">
        <div class="qc-name">${esc(quest.questName)}</div>
        <div class="qc-days">${daysLeft}d</div>
      </div>
      <div class="qc-meta">
        <span class="qc-type ${typeCls}">${typeIconHtml}${typeLbl}</span>
        <span class="qc-dot">·</span>
        <span class="qc-app">${esc(quest.applicationName)}</span>
        ${rewardHtml}
        ${statusHtml}
      </div>
      ${barHtml}`;

    card.addEventListener('click', () => selectQuest(quest, card));
    questListBody.appendChild(card);
  });
}

function selectQuest(quest, cardEl) {
  document.querySelectorAll('.quest-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  state.selectedQuest = quest;

  if (quest.completed) {
    // Completed quests can't be started — only show in list for awareness
    btnStartQuest.disabled = true;
    btnStartQuest.textContent = 'u finished dis';
    btnAddQueue.disabled = true;
  } else {
    btnStartQuest.disabled = false;
    btnStartQuest.textContent = quest.enrolled ? 'start' : 'enroll & start';
    btnAddQueue.disabled = !quest.enrolled || state.queue.length >= QUEUE_MAX;
  }
}

function taskTypeLabel(t) {
  switch (t) {
    case 'WATCH_VIDEO':             return 'watch video';
    case 'WATCH_VIDEO_ON_MOBILE':   return 'watch video (mobile)';
    case 'PLAY_ON_DESKTOP':         return 'play game';
    case 'PLAY_ON_DESKTOP_V2':      return 'play game (v2)';
    case 'PLAY_ON_XBOX':            return 'play on xbox';
    case 'PLAY_ON_PLAYSTATION':     return 'play on playstation';
    case 'STREAM_ON_DESKTOP':       return 'stream game';
    case 'PLAY_ACTIVITY':           return 'play activity';
    case 'ACHIEVEMENT_IN_ACTIVITY': return 'activity achievement';
    default: return t.toLowerCase().replace(/_/g,' ');
  }
}

function taskBadgeClass(t) {
  if (t.includes('VIDEO'))              return 'type-video';
  if (t === 'PLAY_ON_DESKTOP')          return 'type-game';
  if (t === 'PLAY_ON_DESKTOP_V2')       return 'type-game';
  if (t === 'PLAY_ON_XBOX')             return 'type-console';
  if (t === 'PLAY_ON_PLAYSTATION')      return 'type-console';
  if (t === 'PLAY_ACTIVITY')            return 'type-game';
  if (t === 'ACHIEVEMENT_IN_ACTIVITY')  return 'type-activity';
  if (t === 'STREAM_ON_DESKTOP')        return 'type-stream';
  return 'type-activity';
}

function taskIconFile(t) {
  if (t.includes('VIDEO'))              return 'video.png';
  if (t === 'PLAY_ON_XBOX')             return 'xbox.png';
  if (t === 'PLAY_ON_PLAYSTATION')      return 'ps.png';
  if (t === 'STREAM_ON_DESKTOP')        return 'stream.png';
  if (t === 'PLAY_ACTIVITY' || t === 'ACHIEVEMENT_IN_ACTIVITY') return 'activity.png';
  if (t.includes('PLAY'))               return 'gamepad.png';
  return null;
}

// ─── Queue ────────────────────────────────────────────────────────────────────

const queueCountPill = document.getElementById('queue-count-pill');

function addToQueue(quest) {
  if (state.queue.length >= QUEUE_MAX) return false;
  if (state.queue.find(q => q.id === quest.id)) return false;
  state.queue.push(quest);
  syncQueueUI();
  return true;
}

function removeFromQueue(index) {
  state.queue.splice(index, 1);
  syncQueueUI();
}

function syncQueueUI() {
  const n = state.queue.length;
  queueCountPill.textContent = n;
  queueCountPill.classList.toggle('empty', n === 0);
  if (state.selectedQuest && state.selectedQuest.enrolled && !state.selectedQuest.completed) {
    btnAddQueue.disabled = n >= QUEUE_MAX;
  }
  renderQueuePanel();
}

// ─── Queue Side Panel ─────────────────────────────────────────────────────────

const queuePanel   = document.getElementById('queue-panel');
const queueOverlay = document.getElementById('queue-overlay');
const qpCount      = document.getElementById('qp-count');

function openQueuePanel() {
  state.queuePanelOpen = true;
  queuePanel.classList.add('open');
  queueOverlay.classList.add('open');
  renderQueuePanel();
}

function closeQueuePanel() {
  state.queuePanelOpen = false;
  queuePanel.classList.remove('open');
  queueOverlay.classList.remove('open');
}

function renderQueuePanel() {
  if (!state.queuePanelOpen) return;

  const body = document.getElementById('queue-panel-body');
  body.innerHTML = '';
  qpCount.textContent = `${state.queue.length} / ${QUEUE_MAX}`;

  const queuedLabel = document.createElement('div');
  queuedLabel.className = 'queue-section-label';
  queuedLabel.textContent = 'queued';
  body.appendChild(queuedLabel);

  if (state.queue.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue-panel-empty';
    empty.textContent = 'nothing queued yet.';
    body.appendChild(empty);
  } else {
    state.queue.forEach((quest, i) => {
      const item = document.createElement('div');
      item.className = 'queue-active-item';
      item.innerHTML = `
        <span class="qa-pos">${i + 1}</span>
        <span class="qa-name">${esc(quest.questName)}</span>
        <button class="qa-remove" title="Remove">&#215;</button>`;
      item.querySelector('.qa-remove').addEventListener('click', () => removeFromQueue(i));
      body.appendChild(item);
    });
  }

  const availLabel = document.createElement('div');
  availLabel.className = 'queue-section-label';
  availLabel.textContent = 'add more';
  body.appendChild(availLabel);

  if (state.queue.length >= QUEUE_MAX) {
    const fullMsg = document.createElement('div');
    fullMsg.className = 'queue-full-msg';
    fullMsg.textContent = `queue is full (${QUEUE_MAX} / ${QUEUE_MAX})`;
    body.appendChild(fullMsg);
    return;
  }

  // Only show enrolled, non-completed quests as addable
  const available = state.quests.filter(q =>
    q.enrolled && !q.completed &&
    (!state.selectedQuest || q.id !== state.selectedQuest.id)
  );

  if (available.length === 0) {
    const noMore = document.createElement('div');
    noMore.className = 'queue-panel-empty';
    noMore.innerHTML = `no other enrolled quests available. <button class="queue-refresh-link" id="qp-refresh">refresh?</button>`;
    body.appendChild(noMore);
    document.getElementById('qp-refresh')?.addEventListener('click', async () => {
      await window.mendax.refreshQuests();
    });
  } else {
    available.forEach(quest => {
      const alreadyQueued = !!state.queue.find(q => q.id === quest.id);
      const item = document.createElement('div');
      item.className = 'queue-avail-item' + (alreadyQueued ? ' already-queued' : '');
      item.innerHTML = `
        <span class="qa-add-icon">${alreadyQueued ? '✓' : '+'}</span>
        <div class="qa-info">
          <div class="qa-info-name">${esc(quest.questName)}</div>
          <div class="qa-info-sub">${esc(quest.applicationName)} · ${taskTypeLabel(quest.taskName)}</div>
        </div>`;
      if (!alreadyQueued) {
        item.addEventListener('click', () => {
          if (addToQueue(quest)) renderQueuePanel();
        });
      }
      body.appendChild(item);
    });
  }
}

document.getElementById('btn-queue-toggle').addEventListener('click', () => {
  state.queuePanelOpen ? closeQueuePanel() : openQueuePanel();
});
document.getElementById('queue-panel-close').addEventListener('click', closeQueuePanel);
queueOverlay.addEventListener('click', closeQueuePanel);

// ─── Circular Progress ────────────────────────────────────────────────────────

const circleFill  = document.getElementById('circle-fill');
const circleWrap  = document.getElementById('circle-wrap');
const progPctEl   = document.getElementById('prog-pct');
const progStatus  = document.getElementById('prog-status');

function setCircleProgress(pct, statusText, variant) {
  const safe   = Math.min(100, Math.max(0, pct));
  const offset = CIRCUMFERENCE - (safe / 100) * CIRCUMFERENCE;

  circleFill.style.strokeDashoffset = offset;
  progPctEl.textContent = safe + '%';

  if (statusText !== undefined) progStatus.textContent = statusText;

  circleFill.classList.toggle('success', variant === 'success');
  progPctEl.classList.toggle('success', variant === 'success');
}

// ─── Progress View ────────────────────────────────────────────────────────────

const progAppName   = document.getElementById('prog-app-name');
const progQuestName = document.getElementById('prog-quest-name');
const progHeaderSub = document.getElementById('prog-header-sub');
const progElapsed   = document.getElementById('prog-elapsed');
const progRemaining = document.getElementById('prog-remaining');
const progTimeRow   = document.getElementById('prog-time-row');
const progDiscNote  = document.getElementById('prog-discord-note');
const btnAbort      = document.getElementById('btn-abort');
const viewProgress  = document.getElementById('view-progress');

function initProgressView(quest) {
  progAppName.textContent   = quest.applicationName || '';
  progQuestName.textContent = quest.questName;
  progHeaderSub.textContent = taskTypeLabel(quest.taskName);
  btnAbort.disabled         = false;

  state.isAchievementQuest = quest.taskName === 'ACHIEVEMENT_IN_ACTIVITY';

  if (state.isAchievementQuest) {
    // Achievement quests complete instantly — spinning arc, no time display
    viewProgress.classList.add('achievement-mode');
    progTimeRow.style.display  = 'none';
    progDiscNote.textContent   = 'achievement quest.';
    // Show count in centre instead of percentage
    progPctEl.textContent      = `0 / ${quest.secondsNeeded}`;
    progStatus.textContent     = 'completing...';
    circleFill.classList.remove('success');
    progPctEl.classList.remove('success');
  } else {
    viewProgress.classList.remove('achievement-mode');
    progTimeRow.style.display  = '';
    progDiscNote.textContent   = "discord might say otherwise, but don't worry, it's working... i think...";
    setCircleProgress(quest.percent || 0, 'running...');
    state.progressStart = Date.now() - (quest.secondsDone * 1000);
    startElapsedTimer(quest.secondsNeeded);
  }

  state.questing = true;
  showView('progress');
  syncQueueUI();
}

function startElapsedTimer(secondsNeeded) {
  stopElapsedTimer();
  state.elapsedInterval = setInterval(() => {
    const elapsed   = Math.floor((Date.now() - state.progressStart) / 1000);
    const remaining = Math.max(0, secondsNeeded - elapsed);
    progElapsed.textContent   = fmtSec(elapsed);
    progRemaining.textContent = remaining > 0 ? fmtSec(remaining) : '0:00';
  }, 500);
}

function stopElapsedTimer() {
  if (state.elapsedInterval) {
    clearInterval(state.elapsedInterval);
    state.elapsedInterval = null;
  }
}

function handleProgressUpdate(data) {
  if (state.isAchievementQuest) {
    // Achievement quests are one-shot — keep spinning arc, just update count if available
    if (data.error) {
      viewProgress.classList.remove('achievement-mode');
      progStatus.textContent = 'error';
    }
    return;
  }
  setCircleProgress(
    data.percent,
    data.error ? 'error' : 'running...',
    data.error ? 'error' : null
  );
}

async function handleQuestComplete(questName) {
  stopElapsedTimer();
  // Exit achievement-mode so the filled circle renders normally
  viewProgress.classList.remove('achievement-mode');
  progTimeRow.style.display = '';
  setCircleProgress(100, 'complete!', 'success');
  progRemaining.textContent = '0:00';
  btnAbort.disabled = true;

  circleWrap.classList.remove('complete');
  void circleWrap.offsetWidth;
  circleWrap.classList.add('complete');

  if (state.queue.length > 0) {
    const next = state.queue.shift();
    syncQueueUI();
    await showSettlingOverlay(questName, next.questName, 4500);
    initProgressView(next);
    await window.mendax.startQuest(next);
  } else {
    state.questing = false;
    setTimeout(async () => {
      circleWrap.classList.remove('complete');
      showView('quests');
      await window.mendax.refreshQuests();
    }, 3000);
  }
}

// ─── Settling Overlay ─────────────────────────────────────────────────────────

const settlingOverlay = document.getElementById('settling-overlay');
const settlingTitle   = document.getElementById('settling-title');
const settlingNext    = document.getElementById('settling-next');

function showSettlingOverlay(doneName, nextName, ms) {
  settlingTitle.textContent = `"${doneName}" complete.`;
  settlingNext.textContent  = `up next — ${nextName}`;
  settlingOverlay.classList.add('open');
  return new Promise(r => setTimeout(() => {
    settlingOverlay.classList.remove('open');
    r();
  }, ms));
}

// ─── Stream Modal ─────────────────────────────────────────────────────────────

const modalOverlay = document.getElementById('modal-overlay');
const modalConfirm = document.getElementById('modal-confirm');
const modalCancel  = document.getElementById('modal-cancel');
let streamResolve  = null;

function showStreamModal() {
  return new Promise(resolve => {
    streamResolve = resolve;
    modalOverlay.classList.add('open');
  });
}

modalConfirm.addEventListener('click', () => {
  modalOverlay.classList.remove('open');
  if (streamResolve) { streamResolve(true); streamResolve = null; }
});
modalCancel.addEventListener('click', () => {
  modalOverlay.classList.remove('open');
  if (streamResolve) { streamResolve(false); streamResolve = null; }
});

// ─── Disconnect Overlay ───────────────────────────────────────────────────────

function showDisconnectOverlay() {
  stopElapsedTimer();
  document.getElementById('disconnect-overlay').classList.add('open');
  setTimeout(() => window.mendax.close(), 2800);
}

// ─── Enrollment helper ────────────────────────────────────────────────────────

async function enrollAndStart(quest) {
  btnStartQuest.disabled = true;
  btnStartQuest.textContent = 'enrolling...';

  const result = await window.mendax.enrollQuest(quest.id);

  if (!result.ok) {
    btnStartQuest.disabled = false;
    btnStartQuest.textContent = 'enroll & start';
    showPrepError('Enrollment failed: ' + (result.error || 'unknown error'));
    showView('prep');
    return;
  }

  // Mark as enrolled locally so downstream logic is correct
  quest.enrolled = true;
  const inAll = state.allQuests.find(q => q.id === quest.id);
  if (inAll) inAll.enrolled = true;

  // Start immediately without waiting for a full refresh
  initProgressView(quest);
  await window.mendax.startQuest(quest);
}

// ─── Button Wiring ────────────────────────────────────────────────────────────

document.getElementById('btn-minimize').addEventListener('click', () => window.mendax.minimize());
document.getElementById('btn-tray').addEventListener('click',    () => window.mendax.tray());
document.getElementById('btn-close').addEventListener('click',   () => window.mendax.close());

btnRefresh.addEventListener('click', async () => {
  btnRefresh.disabled = true;
  await window.mendax.refreshQuests();
  btnRefresh.disabled = false;
});

btnAddQueue.addEventListener('click', () => {
  if (!state.selectedQuest) return;
  addToQueue(state.selectedQuest);
});

btnStartQuest.addEventListener('click', async () => {
  const quest = state.selectedQuest;
  if (!quest || quest.completed) return;

  if (!quest.enrolled) {
    await enrollAndStart(quest);
    return;
  }

  if (quest.taskName === 'STREAM_ON_DESKTOP') {
    const confirmed = await showStreamModal();
    if (!confirmed) return;
  }

  initProgressView(quest);
  await window.mendax.startQuest(quest);
});

// Queue All / Start All — enrolls nothing, only uses already-enrolled quests
btnStartAll.addEventListener('click', async () => {
  const eligible = state.allQuests.filter(q => q.enrolled && !q.completed);
  if (eligible.length === 0) return;

  const [first, ...rest] = eligible;

  // Queue the rest (respecting QUEUE_MAX)
  state.queue = [];
  rest.slice(0, QUEUE_MAX - 1).forEach(q => addToQueue(q));

  // Select and start the first
  const firstCard = questListBody.querySelector(`.quest-card[data-id="${first.id}"]`);
  if (firstCard) selectQuest(first, firstCard);

  if (first.taskName === 'STREAM_ON_DESKTOP') {
    const confirmed = await showStreamModal();
    if (!confirmed) return;
  }

  initProgressView(first);
  await window.mendax.startQuest(first);
});

btnAbort.addEventListener('click', async () => {
  btnAbort.disabled = true;
  stopElapsedTimer();
  state.questing = false;
  state.queue    = [];
  syncQueueUI();
  closeQueuePanel();

  viewProgress.classList.remove('achievement-mode');
  progTimeRow.style.display = '';
  setCircleProgress(
    state.isAchievementQuest ? 0 : (parseInt(progPctEl.textContent) || 0),
    'aborted.'
  );

  await window.mendax.stopQuest();

  setTimeout(async () => {
    circleWrap.classList.remove('complete');
    showView('quests');
    await window.mendax.refreshQuests();
  }, 1200);
});

// ─── Toolbar: Sort & Filter ───────────────────────────────────────────────────

document.getElementById('sort-select').addEventListener('change', e => {
  state.sortBy = e.target.value;
  localStorage.setItem('mendax-sort', state.sortBy);
  applyAndRender();
});

document.getElementById('btn-hide-completed').addEventListener('click', () => {
  state.hideCompleted = !state.hideCompleted;
  localStorage.setItem('mendax-hide-completed', state.hideCompleted);
  syncFilterUI();
  applyAndRender();
});

document.getElementById('btn-filter-orbs').addEventListener('click', () => {
  state.filterReward = state.filterReward === 'orbs' ? null : 'orbs';
  localStorage.setItem('mendax-filter-reward', state.filterReward || '');
  syncFilterUI();
  applyAndRender();
});

document.getElementById('btn-filter-items').addEventListener('click', () => {
  state.filterReward = state.filterReward === 'item' ? null : 'item';
  localStorage.setItem('mendax-filter-reward', state.filterReward || '');
  syncFilterUI();
  applyAndRender();
});

// ─── IPC Listeners ────────────────────────────────────────────────────────────

window.mendax.on('prep:step', ({ step, label }) => {
  renderedSteps.forEach((el, id) => {
    if (id !== step && el.classList.contains('active')) el.className = 'prep-step done';
  });
  setPrepStep(step, label, 'active');
});

window.mendax.on('prep:warn', ({ step, label }) => {
  renderedSteps.forEach((el, id) => {
    if (id !== step && el.classList.contains('active')) el.className = 'prep-step done';
  });
  setPrepStep(step, label, 'warn');
});

window.mendax.on('prep:error', ({ msg }) => {
  renderedSteps.forEach(el => {
    if (el.classList.contains('active')) el.className = 'prep-step error';
  });
  showPrepError(msg);
});

// ─── Sound playback ───────────────────────────────────────────────────────────

window.mendax.on('play-sound', ({ type }) => {
  try {
    const src = type === 'complete' ? './sounds/completed.mp3' : './sounds/error.mp3';
    const audio = new Audio(src);
    audio.volume = 0.7;
    audio.play().catch(() => {});
  } catch {}
});

// ─── Reconnect banner ─────────────────────────────────────────────────────────

const reconnectBanner  = document.getElementById('reconnect-banner');
const reconnectText    = document.getElementById('rb-text');
let reconnectHideTimer = null;

window.mendax.on('discord:reconnecting', ({ attempt, max }) => {
  if (reconnectHideTimer) { clearTimeout(reconnectHideTimer); reconnectHideTimer = null; }
  reconnectBanner.className = 'reconnect-banner open';
  reconnectText.textContent = `reconnecting to discord... (${attempt}/${max})`;
});

window.mendax.on('discord:reconnected', () => {
  reconnectBanner.className = 'reconnect-banner open success';
  reconnectText.textContent = 'reconnected.';
  reconnectHideTimer = setTimeout(() => {
    reconnectBanner.className = 'reconnect-banner';
  }, 2500);
  if (!state.questing) showView('quests');
});

window.mendax.on('discord:offline',      () => showOfflineNotice());
window.mendax.on('discord:disconnected', () => {
  if (reconnectHideTimer) clearTimeout(reconnectHideTimer);
  reconnectBanner.className = 'reconnect-banner';
  showDisconnectOverlay();
});

window.mendax.on('quests:list', ({ quests }) => {
  markAllPrepDone();
  renderQuestList(quests);
  if (!state.questing) showView('quests');
});

window.mendax.on('progress:update', data => handleProgressUpdate(data));

window.mendax.on('quest:complete', ({ questName }) => handleQuestComplete(questName));

window.mendax.on('quest:stopped', () => {
  stopElapsedTimer();
  state.questing = false;
  setCircleProgress(parseInt(progPctEl.textContent) || 0, 'stopped.');
  setTimeout(async () => {
    circleWrap.classList.remove('complete');
    showView('quests');
    await window.mendax.refreshQuests();
  }, 1200);
});

window.mendax.on('quest:error', ({ msg }) => {
  stopElapsedTimer();
  setCircleProgress(parseInt(progPctEl.textContent) || 0, 'error');
  btnAbort.disabled = false;
});

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtSec(s) {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.getElementById('brand-sub').textContent =
  QUOTES[Math.floor(Math.random() * QUOTES.length)];

(async function boot() {
  await new Promise(r => setTimeout(r, 500));
  const ok = await window.mendax.connect();
  if (ok) await window.mendax.refreshQuests();
})();
