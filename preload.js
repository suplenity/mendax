'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mendax', {
  // Core discord actions
  connect:        ()         => ipcRenderer.invoke('discord:connect'),
  refreshQuests:  ()         => ipcRenderer.invoke('discord:refresh-quests'),
  startQuest:     (quest)    => ipcRenderer.invoke('discord:start-quest', quest),
  stopQuest:      ()         => ipcRenderer.invoke('discord:stop-quest'),
  enrollQuest:    (questId)  => ipcRenderer.invoke('discord:enroll-quest', questId),
  checkRunning:   ()         => ipcRenderer.invoke('discord:check-running'),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  tray:     () => ipcRenderer.send('window:tray'),
  close:    () => ipcRenderer.send('window:close'),

  // Tell main process what theme is active (used for notification theming)
  setTheme: (theme) => ipcRenderer.send('app:set-theme', theme),

  // Subscribe to main-process events
  on: (channel, fn) => {
    const allowed = [
      'prep:step', 'prep:warn', 'prep:error',
      'discord:offline', 'discord:disconnected',
      'discord:reconnecting', 'discord:reconnected',
      'quests:list',
      'quest:complete', 'quest:stopped', 'quest:error',
      'progress:update',
      'play-sound'
    ];
    if (allowed.includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => fn(data));
    }
  },

  off: (channel) => ipcRenderer.removeAllListeners(channel)
});
