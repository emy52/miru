'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('miru', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    onState: on('win:state'),
    onVideoFullscreen: on('win:video-fullscreen'),
  },
  yt: {
    go: (t) => ipcRenderer.send('yt:go', t),
    search: (q) => ipcRenderer.send('yt:search', q),
    onNavState: on('yt:nav-state'),
    onStats: on('yt:stats'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChanged: on('settings:changed'),
  },
  llm: { probe: () => ipcRenderer.invoke('llm:probe') },
  account: {
    login: () => ipcRenderer.invoke('login:start'),
    onStatus: on('login:status'),
  },
});
