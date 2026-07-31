import select from 'xpath.js';
import { DOMParser as dom } from 'xmldom';
import { errors } from '@appium/base-driver';
import { spawnSync } from 'child_process';

// Short-lived cache for pgrep-by-basename results.  Spawning pgrep on every
// getWindowHandles / getWindow call adds ~500 ms per call.  Caching the result
// for 3 seconds avoids redundant process spawns during rapid polling.
let _pgrepCache = {pids: null, appName: null, ts: 0};
const PGREP_CACHE_TTL_MS = 3000;

function pgrepByBasename (appName) {
  const now = Date.now();
  if (_pgrepCache.appName === appName && _pgrepCache.pids && (now - _pgrepCache.ts) < PGREP_CACHE_TTL_MS) {
    return _pgrepCache.pids;
  }
  let pids = null;
  try {
    const baseName = (appName || '').split('/').pop();
    if (baseName) {
      const res = spawnSync('pgrep', ['-f', baseName], {encoding: 'utf8', timeout: 3000});
      if (res.status === 0 && res.stdout) {
        pids = res.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      }
    }
  } catch { /* ignore */ }
  if (pids && pids.length > 0) {
    _pgrepCache = {pids, appName, ts: now};
  }
  return pids;
}

const commands = {};
function getApis (ctx) {
  if (!ctx?._backendApis) {
    throw new errors.UnknownError('Linux backend is not initialized');
  }
  return ctx._backendApis;
}

function shouldVerifyWindowInA11y (ctx) {
  return ctx?.linuxBackend !== 'wayland';
}

function parseRect (rect) {
  const match = /^\[(?<x>-?\d+),(?<y>-?\d+),(?<width>\d+),(?<height>\d+)\]$/.exec(`${rect ?? ''}`);
  if (!match) {
    return null;
  }
  const {x, y, width, height} = match.groups;
  return {
    x: Number.parseInt(x, 10),
    y: Number.parseInt(y, 10),
    width: Number.parseInt(width, 10),
    height: Number.parseInt(height, 10),
  };
}

function windowPriority (node = {}) {
  const states = `${node.states ?? ''}`.toUpperCase();
  const tag = `${node.tag ?? ''}`.toLowerCase();
  const windowType = `${node.windowType ?? ''}`.toLowerCase();
  const rect = node.rect;
  let score = 0;
  if (rect && rect.width > 0 && rect.height > 0) {
    score += rect.width * rect.height;
  }
  if (tag.includes('alert') || windowType.includes('alert')) {
    score += 100000000;
  } else if (tag.includes('dialog') || windowType.includes('dialog') || windowType.includes('modal')) {
    score += 80000000;
  } else if (
    tag.includes('notification')
    || tag.includes('popover')
    || windowType.includes('notification')
    || windowType.includes('popover')
    || windowType.includes('popup')
  ) {
    score += 60000000;
  }
  if (states.includes('ACTIVE')) {
    score += 50000000;
  }
  if (states.includes('SHOWING') || states.includes('VISIBLE')) {
    score += 25000000;
  }
  if (states.includes('ENABLED') || states.includes('SENSITIVE')) {
    score += 5000000;
  }
  return score;
}

commands.getWindowHandle = function getWindowHandle () {
  // Short-lived cache: the active window doesn't change between rapid polls
  if (this._win) {
    const now = Date.now();
    if (this._winHandleValidatedAt && (now - this._winHandleValidatedAt) < 5000) {
      return this._win.wid;
    }
    try {
      this._win = this._getWinAndPid_FromWinId(this._win.wid);
      this._winHandleValidatedAt = Date.now();
      return this._win?.wid;
    } catch {
      this._winHandleValidatedAt = 0;
      return this._resolveBestAvailableWindow()?.wid;
    }
  }
  return this._resolveBestAvailableWindow()?.wid;
};

commands._resolveBestAvailableWindow = function _resolveBestAvailableWindow () {
  // Internal recovery path — reuse the window list that was JUST rebuilt
  // by the caller's getWindowHandles().  Do NOT invalidate desktop cache
  // again to avoid cascading 2-4s desktop rebuilds.
  const handles = this._getWindowHandlesCore();
  for (const handle of handles) {
    try {
      const win = this._getWinAndPid_FromWinId(handle);
      this._win = win;
      return win;
    } catch {
      continue;
    }
  }
  this._win = null;
  return null;
};

commands.getWindowHandles = function getWindowHandles () {
  // Short-circuit: return cached handles when no UI action has happened
  // since the last scan.  This avoids redundant ~2-28s native AT-SPI
  // desktop re-scans during rapid polling (e.g. switch_to_new_window).
  const now = Date.now();
  if (this._lastWindowHandlesResult
      && this._lastWindowHandlesAt && (now - this._lastWindowHandlesAt) < 3000
      && (!this._lastUiActionAt || this._lastWindowHandlesAt > this._lastUiActionAt)) {
    return this._lastWindowHandlesResult;
  }
  const apis = getApis(this);
  // Invalidate desktop + window XML caches so we always discover
  // newly-appeared or recently-closed windows (e.g. "Connect Insecurely").
  // This costs ~2-3s for a fresh native AT-SPI desktop scan.
  if (typeof apis._invalidateDesktopHierarchyCache === 'function') {
    apis._invalidateDesktopHierarchyCache();
  }
  if (typeof apis._invalidateWindowHierarchyXmlCache === 'function') {
    apis._invalidateWindowHierarchyXmlCache();
  }
  const result = this._getWindowHandlesCore();
  this._lastWindowHandlesAt = Date.now();
  this._lastWindowHandlesResult = result;
  return result;
};

// Core logic shared by getWindowHandles (fresh) and _resolveBestAvailableWindow (cached).
commands._getWindowHandlesCore = function _getWindowHandlesCore () {
  const apis = getApis(this);
  const appName = this.appName;
  let pids = apis.app_running(appName);
  // Preserve the established lookup for ordinary sessions. Direct argument
  // launches may retain a wrapper process alongside the UI child, so only
  // that opt-in path merges basename matches.
  if (this.appArguments?.length > 0 || this.attachToRunningApp) {
    const basenamePids = appName ? (pgrepByBasename(appName) || []) : [];
    pids = [...new Set([...(pids || []), ...basenamePids])];
  } else if ((!pids || pids.length === 0) && appName) {
    pids = pgrepByBasename(appName);
  }
  if (!pids || pids.length === 0) {
    throw new errors.NoSuchWindowError(`application ${appName} is not running`);
  }
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new dom().parseFromString(winHierachy);
  let xpath = pids.map((pid) => `@pid="${pid}"`).join(' or ');
  xpath = `//*[${xpath} and @InputOutput="true"]`;
  const nodes = select(doc, xpath);
  if (!nodes || nodes.length === 0) {
    return [];
  }
  let _nodes = [];
  for (const node of nodes) {
    if (!node.attributes) {
      continue;
    }
    const _node = {};
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      if (attr.name === 'class') {
        _node.class = attr.value.split(' ');
      } else if (attr.name === 'name') {
        _node.name = attr.value;
      } else if (attr.name === 'pid') {
        _node.pid = Number.parseInt(attr.value, 10);
      } else if (attr.name === 'wid') {
        _node.wid = Number.parseInt(attr.value, 10);
      } else if (attr.name === 'rect') {
        _node.rect = parseRect(attr.value);
      } else if (attr.name === 'states') {
        _node.states = attr.value;
      } else if (attr.name === 'tag') {
        _node.tag = attr.value;
      } else if (attr.name === 'window-type') {
        _node.windowType = attr.value;
      }
    }
    _nodes.push(_node);
  }
  _nodes = _nodes.filter((p) => p.pid && p.wid);
  if (_nodes.length === 0) {
    return [];
  }
  _nodes = _nodes.map((p) => {
    let _node = {
      pid: p.pid,
      wid: p.wid,
      names: [],
      rect: p.rect || null,
      states: p.states || '',
      tag: p.tag || '',
      windowType: p.windowType || '',
    };
    if (p.name) {
      _node.names.push(p.name);
    }
    if (p.class) {
      _node.names.push(...p.class);
    }
    return _node;
  });
  _nodes.sort((a, b) => windowPriority(b) - windowPriority(a));
  if (!shouldVerifyWindowInA11y(this)) {
    // Wayland uses synthetic window handles derived from the current AT-SPI tree.
    // Avoid blocking native a11y lookups while windows are still settling.
    return [...new Set(_nodes.map((node) => node.wid))];
  }
  const wids = [];
  for (const _node of _nodes) {
    let ok = false;
    for (const name of _node.names) {
      if (apis.a11y_checkWindowExists(name, _node.pid)) {
        ok = true;
        break;
      }
    }
    if (ok) {
      wids.push(_node.wid);
    }
  }
  return wids;
};

commands._getWinAndPid_FromWinName = function (windowName) {
  const apis = getApis(this);
  let pids = apis.app_running(this.appName);
  if (this.appArguments?.length > 0 || this.attachToRunningApp) {
    const basenamePids = this.appName ? (pgrepByBasename(this.appName) || []) : [];
    pids = [...new Set([...(pids || []), ...basenamePids])];
  }
  if (!pids || pids.length === 0) {
    throw new errors.NoSuchWindowError(`application ${this.appName} is not running`);
  }
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new dom().parseFromString(winHierachy);
  let xpath = pids.map((pid) => `@pid="${pid}"`).join(' or ');
  xpath = `//*[(${xpath}) and @InputOutput="true" and (@name="${windowName}" or contains(concat(" ", @class, " "), "${' ' + windowName + ' '}"))]`;
  const nodes = select(doc, xpath);
  if (!nodes || nodes.length === 0) {
    throw new errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
  }
  let _nodes = [];
  for (const node of nodes) {
    if (!node.attributes) {
      continue;
    }
    const attrs = Array.from(node.attributes);
    const _node = {};
    for (const attr of attrs) {
      _node[attr.name] = attr.value;
    }
    _nodes.push(_node);
  }
  _nodes = _nodes.filter((p) => (p.name || p.class) && p.pid && p.wid);
  if (_nodes.length === 0) {
    throw new errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
  }
  _nodes = _nodes.map((p) => ({
    ...p,
    pid: Number.parseInt(p.pid, 10),
    wid: Number.parseInt(p.wid, 10),
    rect: parseRect(p.rect),
    states: p.states || '',
    tag: p.tag || '',
    windowType: p['window-type'] || p.windowType || '',
  }));
  _nodes.sort((a, b) => {
    const av = a.name === windowName ? -1 : 1;
    const bv = b.name === windowName ? -1 : 1;
    return av - bv || windowPriority(b) - windowPriority(a);
  });
  if (!shouldVerifyWindowInA11y(this)) {
    const candidate = _nodes[0];
    return {
      pid: candidate.pid,
      wid: candidate.wid,
      name: candidate.name || windowName,
      rect: candidate.rect || null,
      states: candidate.states || '',
      tag: candidate.tag || '',
      windowType: candidate.windowType || '',
    };
  }
  for (const _node of _nodes) {
    const _pid = _node.pid;
    if (apis.a11y_checkWindowExists(windowName, _pid)) {
      return {
        pid: _pid,
        wid: _node.wid,
        name: windowName,
        rect: _node.rect || null,
        states: _node.states || '',
        tag: _node.tag || '',
        windowType: _node.windowType || '',
      };
    }
  }
  throw new errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
};

commands._getWinAndPid_FromWinId = function (wid) {
  const apis = getApis(this);
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new dom().parseFromString(winHierachy);
  const xpath = `//*[@wid="${wid}" and @InputOutput="true"]`;
  const nodes = select(doc, xpath);
  if (!nodes || nodes.length === 0) {
    throw new errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  let _nodes = [];
  for (const currentNode of nodes) {
    const attrs = Array.from(currentNode.attributes);
    const _node = {};
    for (const attr of attrs) {
      _node[attr.name] = attr.value;
    }
    _nodes.push(_node);
  }
  _nodes = _nodes.map((p) => ({
    ...p,
    pid: Number.parseInt(p.pid, 10),
    wid: Number.parseInt(p.wid, 10),
    rect: parseRect(p.rect),
    states: p.states || '',
    tag: p.tag || '',
    windowType: p['window-type'] || p.windowType || '',
  })).filter((p) => p.pid && p.wid);
  if (_nodes.length === 0) {
    throw new errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  _nodes.sort((a, b) => windowPriority(b) - windowPriority(a));
  const node = _nodes[0];
  if (!node.pid || !node.wid) {
    throw new errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  if (!shouldVerifyWindowInA11y(this)) {
    return {
      pid: node.pid,
      wid: node.wid,
      name: node.name,
      rect: node.rect || null,
      states: node.states || '',
      tag: node.tag || '',
      windowType: node.windowType || '',
    };
  }
  if (node.name && !apis.a11y_checkWindowExists(node.name, node.pid)) {
    throw new errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  return {
    pid: node.pid,
    wid: node.wid,
    name: node.name,
    rect: node.rect || null,
    states: node.states || '',
    tag: node.tag || '',
    windowType: node.windowType || '',
  };
};

function validateName (name) {
  if (!name) {
    return name;
  }
  for (let i = 0; i < name.length; ++i) {
    if (name[i] < '0' || name[i] > '9') {
      return name;
    }
  }
  return null;
}

function validateHandle (handle) {
  if (!handle) {
    return handle;
  }
  for (let i = 0; i < handle.length; ++i) {
    if (handle[i] < '0' || handle[i] > '9') {
      return null;
    }
  }
  return handle;
}

commands.setWindow = function setWindow (name, handle) {
  handle = validateHandle(handle);
  name = validateName(name);
  if (name) {
    const win = this._getWinAndPid_FromWinName(name);
    this._win = win;
  } else if (handle) {
    const win = this._getWinAndPid_FromWinId(handle);
    this._win = win;
  } else {
    throw new errors.UnknownError("setWindow both name and handle don't have a value");
  }
  this._lastCacheClearAt = 0;
  this._winValidatedAt = 0;
  this._winHandleValidatedAt = 0;
  this._lastWindowHandlesAt = 0;
};

commands.getWindowRect = function getWindowRect () {
  const apis = getApis(this);
  const win = this._win;
  if (!win) {
    throw new errors.NoSuchWindowError(`window is not specified`);
  }
  const {wid} = win;
  return apis.app_getWinRect(wid);
};

export default commands;
