'use strict';

const SUPPORTED_TASKS = [
  "WATCH_VIDEO", "WATCH_VIDEO_ON_MOBILE",
  "PLAY_ON_DESKTOP", "PLAY_ON_DESKTOP_V2",
  "PLAY_ON_XBOX", "PLAY_ON_PLAYSTATION",
  "STREAM_ON_DESKTOP",
  "PLAY_ACTIVITY",
  "ACHIEVEMENT_IN_ACTIVITY"
];

// Run once after CDP connects — stores all needed Discord internals on window.__pp__
const SETUP = `
(function() {
  try {
    delete window.$;
    let wpRequire;
    try {
      wpRequire = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
      webpackChunkdiscord_app.pop();
    } catch(e) {
      return JSON.stringify({ ok: false, error: 'webpackChunkdiscord_app not found: ' + e.message });
    }

    const mods = Object.values(wpRequire.c);

    const ApplicationStreamingStore =
      mods.find(x => x?.exports?.A?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.A ||
      mods.find(x => x?.exports?.default?.__proto__?.getStreamerActiveStreamMetadata)?.exports?.default;

    const RunningGameStore =
      mods.find(x => x?.exports?.Ay?.getRunningGames)?.exports?.Ay ||
      mods.find(x => x?.exports?.Z?.getRunningGames)?.exports?.Z ||
      mods.find(x => x?.exports?.default?.getRunningGames)?.exports?.default;

    const QuestsStore =
      mods.find(x => x?.exports?.A?.__proto__?.getQuest)?.exports?.A ||
      mods.find(x => x?.exports?.Z?.__proto__?.getQuest)?.exports?.Z ||
      mods.find(x => x?.exports?.default?.__proto__?.getQuest)?.exports?.default;

    const ChannelStore =
      mods.find(x => x?.exports?.A?.__proto__?.getAllThreadsForParent)?.exports?.A ||
      mods.find(x => x?.exports?.Z?.__proto__?.getAllThreadsForParent)?.exports?.Z ||
      mods.find(x => x?.exports?.default?.__proto__?.getAllThreadsForParent)?.exports?.default;

    const GuildChannelStore =
      mods.find(x => x?.exports?.Ay?.getSFWDefaultChannel)?.exports?.Ay ||
      mods.find(x => x?.exports?.Z?.getSFWDefaultChannel)?.exports?.Z ||
      mods.find(x => x?.exports?.default?.getSFWDefaultChannel)?.exports?.default;

    const FluxDispatcher =
      mods.find(x => x?.exports?.h?.__proto__?.flushWaitQueue)?.exports?.h ||
      mods.find(x => x?.exports?.Z?.__proto__?.flushWaitQueue)?.exports?.Z ||
      mods.find(x => x?.exports?.default?.__proto__?.flushWaitQueue)?.exports?.default;

    const api =
      mods.find(x => x?.exports?.Bo?.get)?.exports?.Bo ||
      mods.find(x => x?.exports?.default?.get && x?.exports?.default?.post)?.exports?.default;

    // Discord's internal quest enrollment action (dispatches QUESTS_ENROLL_BEGIN).
    // Match questify's exact pattern: findByCodeLazy('type:"QUESTS_ENROLL_BEGIN",')
    // The comma is key — it matches the action creator's object literal, not a reducer's case clause.
    let enrollQuest = null;
    outer: for (const mod of mods) {
      if (!mod?.exports) continue;
      for (const key of Object.keys(mod.exports)) {
        try {
          const val = mod.exports[key];
          if (typeof val === 'function' && val.toString().includes('type:"QUESTS_ENROLL_BEGIN",')) {
            enrollQuest = val;
            break outer;
          }
        } catch {}
      }
    }

    // QuestCTA constants module — has START_QUEST and ACCEPT_QUEST string values.
    // Questify uses findLazy(m => !!m?.START_QUEST && !!m?.ACCEPT_QUEST).
    let QuestCTA = null;
    outerCTA: for (const mod of mods) {
      if (!mod?.exports) continue;
      for (const key of Object.keys(mod.exports)) {
        try {
          const val = mod.exports[key];
          if (val && typeof val === 'object' && typeof val.START_QUEST === 'string' && typeof val.ACCEPT_QUEST === 'string') {
            QuestCTA = val;
            break outerCTA;
          }
        } catch {}
      }
    }

    const found = {
      ApplicationStreamingStore: !!ApplicationStreamingStore,
      RunningGameStore: !!RunningGameStore,
      QuestsStore: !!QuestsStore,
      ChannelStore: !!ChannelStore,
      GuildChannelStore: !!GuildChannelStore,
      FluxDispatcher: !!FluxDispatcher,
      api: !!api,
      enrollQuest: !!enrollQuest,
      QuestCTA: !!QuestCTA
    };

    if (!QuestsStore || !api) {
      return JSON.stringify({ ok: false, error: 'Critical modules not found', found });
    }

    window.__pp__ = { ApplicationStreamingStore, RunningGameStore, QuestsStore, ChannelStore, GuildChannelStore, FluxDispatcher, api, enrollQuest, QuestCTA };
    window.__ppState__ = null;
    window.__ppCleanup__ = null;

    return JSON.stringify({ ok: true, found });
  } catch(e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
})()
`;

// Returns all available quests (enrolled + unenrolled, excludes fully claimed).
// Includes reward info, enrollment status, and completion status.
const GET_QUESTS = `
(function() {
  try {
    const { QuestsStore } = window.__pp__;
    const supportedTasks = ${JSON.stringify(SUPPORTED_TASKS)};

    const quests = [...QuestsStore.quests.values()].filter(x =>
      new Date(x.config.expiresAt).getTime() > Date.now() &&
      (!x.userStatus?.claimedAt || !!x.userStatus?.completedAt)
    ).filter(x => {
      const tc = x.config.taskConfig ?? x.config.taskConfigV2;
      return tc && supportedTasks.find(y => Object.keys(tc.tasks).includes(y));
    });

    const result = quests.flatMap(q => {
      try {
        const tc = q.config.taskConfig ?? q.config.taskConfigV2;
        const taskName = supportedTasks.find(x => tc.tasks[x] != null);
        const secondsNeeded = tc.tasks[taskName]?.target ?? 0;
        const secondsDone = q.userStatus?.progress?.[taskName]?.value ?? 0;
        const reward = q.config.rewardsConfig?.rewards?.[0] ?? null;
        const rewardOrbs = reward?.orbQuantity ?? 0;
        const rewardName = reward?.messages?.nameWithArticle ?? null;
        return [{
          id: q.id,
          questName: q.config.messages?.questName ?? q.id,
          applicationName: q.config.application?.name ?? 'Unknown',
          applicationId: q.config.application?.id ?? null,
          activityAppId: tc.tasks['ACHIEVEMENT_IN_ACTIVITY']?.applications?.[0]?.id ?? null,
          expiresAt: q.config.expiresAt,
          taskName,
          secondsNeeded,
          secondsDone,
          percent: secondsNeeded > 0 ? Math.floor((secondsDone / secondsNeeded) * 100) : 0,
          configVersion: q.config.configVersion,
          enrolled: !!q.userStatus?.enrolledAt,
          completed: !!(q.userStatus?.completedAt || q.userStatus?.claimedAt),
          rewardOrbs,
          rewardName,
          rewardType: rewardOrbs > 0 ? 'orbs' : (rewardName ? 'item' : 'unknown')
        }];
      } catch(e) {
        return []; // skip malformed quest rather than failing the whole fetch
      }
    });

    return JSON.stringify({ ok: true, quests: result });
  } catch(e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
})()
`;

// Video quest — randomized 6–8 s intervals to look more natural
function buildVideoScript(quest) {
  return `
(async function() {
  try {
    const { api } = window.__pp__;
    const questId = ${JSON.stringify(quest.id)};
    const taskName = ${JSON.stringify(quest.taskName)};
    const secondsNeeded = ${quest.secondsNeeded};
    let secondsDone = ${quest.secondsDone};

    window.__ppState__ = {
      running: true, taskName, secondsDone, secondsNeeded,
      completed: false, error: null,
      appName: ${JSON.stringify(quest.applicationName)}
    };
    window.__ppCleanup__ = function() {
      if (window.__ppState__) window.__ppState__.running = false;
    };

    while (true) {
      if (!window.__ppState__.running) break;
      const speed = 6 + Math.random() * 2; // 6–8 s randomized
      const remaining = Math.min(speed, secondsNeeded - secondsDone);
      await new Promise(r => setTimeout(r, remaining * 1000));
      if (!window.__ppState__.running) break;

      const timestamp = Math.min(secondsNeeded, secondsDone + speed + Math.random() * 0.5);
      try {
        const res = await api.post({ url: '/quests/' + questId + '/video-progress', body: { timestamp } });
        secondsDone = Math.min(secondsNeeded, secondsDone + speed);
        window.__ppState__.secondsDone = secondsDone;
        if (res.body?.completed_at) {
          window.__ppState__.completed = true;
          window.__ppState__.running = false;
          break;
        }
      } catch(e) {
        window.__ppState__.error = e.message;
      }

      if (secondsDone >= secondsNeeded) break;
    }

    if (!window.__ppState__.completed) {
      try {
        await api.post({ url: '/quests/' + questId + '/video-progress', body: { timestamp: secondsNeeded } });
        window.__ppState__.completed = true;
      } catch(e) {}
    }
    window.__ppState__.running = false;
  } catch(e) {
    if (window.__ppState__) { window.__ppState__.error = e.message; window.__ppState__.running = false; }
  }
})()
`;
}

// Desktop game quest (PLAY_ON_DESKTOP / PLAY_ON_DESKTOP_V2) — fakes a running game
// so Discord's own heartbeat system drives progress naturally.
function buildGameScript(quest) {
  return `
(async function() {
  try {
    const { RunningGameStore, FluxDispatcher, api } = window.__pp__;
    const questId = ${JSON.stringify(quest.id)};
    const applicationId = ${JSON.stringify(quest.applicationId)};
    const applicationName = ${JSON.stringify(quest.applicationName)};
    const taskName = ${JSON.stringify(quest.taskName)};
    const secondsNeeded = ${quest.secondsNeeded};
    const configVersion = ${quest.configVersion};
    const pid = Math.floor(Math.random() * 30000) + 1000;

    window.__ppState__ = {
      running: true, taskName,
      secondsDone: ${quest.secondsDone}, secondsNeeded,
      completed: false, error: null, appName: applicationName
    };

    let res;
    try {
      res = await api.get({ url: '/applications/public?application_ids=' + applicationId });
    } catch(e) {
      window.__ppState__.error = 'Failed to fetch app data: ' + e.message;
      window.__ppState__.running = false;
      return;
    }

    const appData = res.body[0];
    const rawExe = appData.executables?.find(x => x.os === 'win32')?.name;
    const exeName = rawExe ? rawExe.replace('>','') : appData.name.replace(/[\\/\\\\:*?"<>|]/g, '');

    const fakeGame = {
      cmdLine: 'C:\\\\Program Files\\\\' + appData.name + '\\\\' + exeName,
      exeName,
      exePath: 'c:/program files/' + appData.name.toLowerCase() + '/' + exeName,
      hidden: false,
      isLauncher: false,
      id: applicationId,
      name: appData.name,
      pid,
      pidPath: [pid],
      processName: appData.name,
      start: Date.now()
    };

    const realGetRunningGames = RunningGameStore.getRunningGames;
    const realGetGameForPID = RunningGameStore.getGameForPID;
    const realGames = RunningGameStore.getRunningGames();

    RunningGameStore.getRunningGames = () => [fakeGame];
    RunningGameStore.getGameForPID = (p) => p === pid ? fakeGame : null;
    FluxDispatcher.dispatch({ type: 'RUNNING_GAMES_CHANGE', removed: realGames, added: [fakeGame], games: [fakeGame] });

    function cleanup() {
      try {
        RunningGameStore.getRunningGames = realGetRunningGames;
        RunningGameStore.getGameForPID = realGetGameForPID;
        FluxDispatcher.dispatch({ type: 'RUNNING_GAMES_CHANGE', removed: [fakeGame], added: [], games: [] });
        FluxDispatcher.unsubscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', heartbeatFn);
      } catch(e) {}
    }

    window.__ppCleanup__ = function() {
      if (window.__ppState__) window.__ppState__.running = false;
      cleanup();
    };

    function heartbeatFn(data) {
      try {
        // taskName is dynamic so PLAY_ON_DESKTOP_V2 resolves its own key correctly
        const progress = configVersion === 1
          ? data.userStatus.streamProgressSeconds
          : Math.floor(data.userStatus.progress[taskName]?.value ?? 0);
        window.__ppState__.secondsDone = progress;

        if (!window.__ppState__.running || progress >= secondsNeeded) {
          if (progress >= secondsNeeded) window.__ppState__.completed = true;
          window.__ppState__.running = false;
          cleanup();
        }
      } catch(e) {
        window.__ppState__.error = e.message;
      }
    }

    FluxDispatcher.subscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', heartbeatFn);
  } catch(e) {
    if (window.__ppState__) { window.__ppState__.error = e.message; window.__ppState__.running = false; }
  }
})()
`;
}

// Console quest (PLAY_ON_XBOX / PLAY_ON_PLAYSTATION) — sends heartbeats directly
// since there is no desktop game process to fake.
function buildConsoleScript(quest) {
  return `
(async function() {
  try {
    const { api } = window.__pp__;
    const questId = ${JSON.stringify(quest.id)};
    const applicationId = ${JSON.stringify(quest.applicationId)};
    const taskName = ${JSON.stringify(quest.taskName)};
    const secondsNeeded = ${quest.secondsNeeded};

    window.__ppState__ = {
      running: true, taskName,
      secondsDone: ${quest.secondsDone}, secondsNeeded,
      completed: false, error: null, appName: ${JSON.stringify(quest.applicationName)}
    };

    window.__ppCleanup__ = function() {
      if (window.__ppState__) window.__ppState__.running = false;
    };

    while (true) {
      if (!window.__ppState__.running) break;
      try {
        const res = await api.post({
          url: '/quests/' + questId + '/heartbeat',
          body: { application_id: applicationId, terminal: false }
        });
        const progress = res.body?.progress?.[taskName]?.value ?? window.__ppState__.secondsDone;
        window.__ppState__.secondsDone = progress;
        if (progress >= secondsNeeded) {
          await api.post({
            url: '/quests/' + questId + '/heartbeat',
            body: { application_id: applicationId, terminal: true }
          });
          window.__ppState__.completed = true;
          window.__ppState__.running = false;
          break;
        }
      } catch(e) {
        window.__ppState__.error = e.message;
      }
      await new Promise(r => setTimeout(r, 60 * 1000));
    }
  } catch(e) {
    if (window.__ppState__) { window.__ppState__.error = e.message; window.__ppState__.running = false; }
  }
})()
`;
}

// Stream quest — patches ApplicationStreamingStore so Discord thinks a stream is active.
// Discord's own heartbeat system then drives progress. No voice channel required.
function buildStreamScript(quest) {
  return `
(function() {
  try {
    const { ApplicationStreamingStore, FluxDispatcher } = window.__pp__;
    const applicationId = ${JSON.stringify(quest.applicationId)};
    const applicationName = ${JSON.stringify(quest.applicationName)};
    const secondsNeeded = ${quest.secondsNeeded};
    const configVersion = ${quest.configVersion};
    const pid = Math.floor(Math.random() * 30000) + 1000;

    window.__ppState__ = {
      running: true, taskName: 'STREAM_ON_DESKTOP',
      secondsDone: ${quest.secondsDone}, secondsNeeded,
      completed: false, error: null, appName: applicationName
    };

    const realFunc = ApplicationStreamingStore.getStreamerActiveStreamMetadata;
    ApplicationStreamingStore.getStreamerActiveStreamMetadata = () => ({
      id: applicationId, pid, sourceName: null
    });

    function cleanup() {
      try {
        ApplicationStreamingStore.getStreamerActiveStreamMetadata = realFunc;
        FluxDispatcher.unsubscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', heartbeatFn);
      } catch(e) {}
    }

    window.__ppCleanup__ = function() {
      if (window.__ppState__) window.__ppState__.running = false;
      cleanup();
    };

    function heartbeatFn(data) {
      try {
        const progress = configVersion === 1
          ? data.userStatus.streamProgressSeconds
          : Math.floor(data.userStatus.progress.STREAM_ON_DESKTOP.value);
        window.__ppState__.secondsDone = progress;

        if (!window.__ppState__.running || progress >= secondsNeeded) {
          if (progress >= secondsNeeded) window.__ppState__.completed = true;
          window.__ppState__.running = false;
          cleanup();
        }
      } catch(e) {
        window.__ppState__.error = e.message;
      }
    }

    FluxDispatcher.subscribe('QUESTS_SEND_HEARTBEAT_SUCCESS', heartbeatFn);
    return 'ok';
  } catch(e) {
    if (window.__ppState__) { window.__ppState__.error = e.message; window.__ppState__.running = false; }
    return 'error: ' + e.message;
  }
})()
`;
}

// Activity quest (PLAY_ACTIVITY)
function buildActivityScript(quest) {
  return `
(async function() {
  try {
    const { ChannelStore, GuildChannelStore, api } = window.__pp__;
    const questId = ${JSON.stringify(quest.id)};
    const secondsNeeded = ${quest.secondsNeeded};

    const channelId = ChannelStore.getSortedPrivateChannels()[0]?.id ??
      Object.values(GuildChannelStore.getAllGuilds()).find(x => x != null && x.VOCAL?.length > 0)?.VOCAL[0]?.channel?.id;

    if (!channelId) {
      window.__ppState__ = { running: false, error: 'No voice channel found. Join a voice channel first.', taskName: 'PLAY_ACTIVITY', secondsDone: ${quest.secondsDone}, secondsNeeded, completed: false, appName: ${JSON.stringify(quest.applicationName)} };
      return;
    }

    const streamKey = 'call:' + channelId + ':1';

    window.__ppState__ = {
      running: true, taskName: 'PLAY_ACTIVITY',
      secondsDone: ${quest.secondsDone}, secondsNeeded,
      completed: false, error: null, appName: ${JSON.stringify(quest.applicationName)}
    };

    window.__ppCleanup__ = function() {
      if (window.__ppState__) window.__ppState__.running = false;
    };

    while (true) {
      if (!window.__ppState__.running) break;
      try {
        const res = await api.post({ url: '/quests/' + questId + '/heartbeat', body: { stream_key: streamKey, terminal: false } });
        const progress = res.body.progress.PLAY_ACTIVITY.value;
        window.__ppState__.secondsDone = progress;
        if (progress >= secondsNeeded) {
          await api.post({ url: '/quests/' + questId + '/heartbeat', body: { stream_key: streamKey, terminal: true } });
          window.__ppState__.completed = true;
          window.__ppState__.running = false;
          break;
        }
      } catch(e) {
        window.__ppState__.error = e.message;
      }
      await new Promise(r => setTimeout(r, 20 * 1000));
    }
  } catch(e) {
    if (window.__ppState__) { window.__ppState__.error = e.message; window.__ppState__.running = false; }
  }
})()
`;
}

// Activity achievement quest — mirrors questify's native.ts approach exactly:
//   1. Renderer: POST /oauth2/authorize to get an OAuth2 auth code for the activity app
//   2. Main.js: POST /.proxy/acf/authorize with the auth code → JWT token in response body
//   3. Main.js: POST /.proxy/acf/quest/progress with x-auth-token + full target at once
// No proxy tickets, no cookies, no ticket exchange needed.
function buildActivityAchievementScript(quest) {
  return `
(async function() {
  try {
    const { api } = window.__pp__;
    const activityAppId = ${JSON.stringify(quest.activityAppId)};
    const target = ${quest.secondsNeeded};

    window.__ppState__ = {
      running: true, taskName: 'ACHIEVEMENT_IN_ACTIVITY',
      secondsDone: ${quest.secondsDone}, secondsNeeded: target,
      completed: false, error: null, appName: ${JSON.stringify(quest.applicationName)},
      authCode: null, activityAppId: activityAppId
    };

    window.__ppCleanup__ = function() {
      if (window.__ppState__) window.__ppState__.running = false;
    };

    // POST /oauth2/authorize — Discord returns a redirect URL with ?code= in it
    try {
      const res = await api.post({
        url: '/oauth2/authorize?client_id=' + activityAppId + '&response_type=code&scope=identify%20applications.entitlements&state=',
        body: { authorize: true }
      });
      const location = res.body?.location;
      const code = location ? new URL(location).searchParams.get('code') : null;
      if (!code) throw new Error('no code in location: ' + JSON.stringify(res.body).slice(0, 200));
      window.__ppState__.authCode = code;
    } catch(e) {
      window.__ppState__.error = 'oauth2: ' + e.message;
      window.__ppState__.running = false;
    }
  } catch(e) {
    if (window.__ppState__) { window.__ppState__.error = e.message; window.__ppState__.running = false; }
  }
})()
`;
}

// Enroll in a quest using Discord's own internal enrollment action.
// Questify uses findByCodeLazy('type:"QUESTS_ENROLL_BEGIN",') — we do the same
// webpack search at injection time rather than calling the REST endpoint directly,
// because the REST endpoint requires auth headers that only Discord's internal
// action middleware provides.
function buildEnrollScript(questId) {
  return `(async function() {
  function errStr(e) {
    if (!e) return 'unknown';
    const parts = [
      e.status  ? 'HTTP ' + e.status  : null,
      e.body?.message ?? e.body?.code ?? null,
      e.message ?? null,
      (typeof e === 'string') ? e : null
    ].filter(Boolean);
    return parts.length ? parts.join(': ') : JSON.stringify(e).slice(0, 200);
  }
  try {
    const qid = ${JSON.stringify(questId)};
    const { enrollQuest, QuestsStore, api } = window.__pp__;

    if (!enrollQuest) {
      return JSON.stringify({ ok: false, error: 'enrollment function not found — restart Mendax and try again' });
    }

    const quest = (QuestsStore.getQuest ? QuestsStore.getQuest(qid) : null)
               ?? QuestsStore.quests?.get(qid) ?? null;

    // Discord's enrollment API requires "location" as an integer enum value.
    // Search webpack for an object whose keys contain "QUEST" with integer values —
    // this finds Discord's own analytics location constants.
    let locationInt = null;
    try {
      const wpReq = webpackChunkdiscord_app.push([[Symbol()], {}, r => r]);
      webpackChunkdiscord_app.pop();
      outer: for (const mod of Object.values(wpReq.c)) {
        if (!mod?.exports) continue;
        for (const expKey of Object.keys(mod.exports)) {
          try {
            const exp = mod.exports[expKey];
            if (!exp || typeof exp !== 'object' || Array.isArray(exp)) continue;
            for (const [k, v] of Object.entries(exp)) {
              if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 500
                  && k.toUpperCase().includes('QUEST')) {
                locationInt = v;
                break outer;
              }
            }
          } catch {}
        }
      }
    } catch {}

    // Try direct REST with the found integer (and traffic_metadata_sealed from the quest).
    if (locationInt !== null) {
      const body = { location: locationInt };
      if (quest?.trafficMetadataSealed) body.traffic_metadata_sealed = quest.trafficMetadataSealed;
      try {
        await api.post({ url: '/quests/' + qid + '/enroll', body });
        return JSON.stringify({ ok: true });
      } catch {}

      // Also try via internal function with the integer as questContent.
      try {
        const r = await enrollQuest(qid, { questContent: locationInt });
        if (r?.type === 'success' || r?.type === 'previous_in_flight_request') {
          return JSON.stringify({ ok: true });
        }
      } catch {}
    }

    // Brute-force fallback: scan 0–50 for a valid location enum value.
    for (let n = 0; n <= 50; n++) {
      if (n === locationInt) continue;
      try {
        const body = { location: n };
        if (quest?.trafficMetadataSealed) body.traffic_metadata_sealed = quest.trafficMetadataSealed;
        await api.post({ url: '/quests/' + qid + '/enroll', body });
        return JSON.stringify({ ok: true });
      } catch(e) {
        // ENUM_TYPE_COERCE = invalid enum value, keep scanning.
        // Any other error = valid enum value but enrollment blocked for another reason.
        if (e?.body?.errors?.location?._errors?.[0]?.code !== 'ENUM_TYPE_COERCE') {
          return JSON.stringify({ ok: false, error: errStr(e) });
        }
      }
    }

    return JSON.stringify({ ok: false, error: 'could not find valid enrollment location' });
  } catch(e) {
    return JSON.stringify({ ok: false, error: errStr(e) });
  }
})()`;
}

const GET_STATE = `
(function() {
  return window.__ppState__ ? JSON.stringify(window.__ppState__) : 'null';
})()
`;

const STOP_QUEST = `
(function() {
  if (window.__ppCleanup__) { try { window.__ppCleanup__(); } catch(e) {} }
  else if (window.__ppState__) { window.__ppState__.running = false; }
  return 'stopped';
})()
`;

function buildQuestScript(quest) {
  switch (quest.taskName) {
    case 'WATCH_VIDEO':
    case 'WATCH_VIDEO_ON_MOBILE':   return buildVideoScript(quest);
    case 'PLAY_ON_DESKTOP':
    case 'PLAY_ON_DESKTOP_V2':      return buildGameScript(quest);
    case 'PLAY_ON_XBOX':
    case 'PLAY_ON_PLAYSTATION':     return buildConsoleScript(quest);
    case 'STREAM_ON_DESKTOP':       return buildStreamScript(quest);
    case 'PLAY_ACTIVITY':           return buildActivityScript(quest);
    case 'ACHIEVEMENT_IN_ACTIVITY': return buildActivityAchievementScript(quest);
    default: throw new Error('Unknown task type: ' + quest.taskName);
  }
}

module.exports = { SETUP, GET_QUESTS, GET_STATE, STOP_QUEST, buildQuestScript, buildEnrollScript };
