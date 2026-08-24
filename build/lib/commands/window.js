"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
require("source-map-support/register");
var _xpath = _interopRequireDefault(require("xpath.js"));
var _xmldom = require("@xmldom/xmldom");
var _driver = require("appium/driver");
var _child_process = require("child_process");
let _pgrepCache = {
  pids: null,
  appName: null,
  ts: 0
};
const PGREP_CACHE_TTL_MS = 3000;
function pgrepByBasename(appName) {
  const now = Date.now();
  if (_pgrepCache.appName === appName && _pgrepCache.pids && now - _pgrepCache.ts < PGREP_CACHE_TTL_MS) {
    return _pgrepCache.pids;
  }
  let pids = null;
  try {
    const baseName = (appName || '').split('/').pop();
    if (baseName) {
      const res = (0, _child_process.spawnSync)('pgrep', ['-f', baseName], {
        encoding: 'utf8',
        timeout: 3000
      });
      if (res.status === 0 && res.stdout) {
        pids = res.stdout.trim().split(/\s+/).map(Number).filter(Number.isFinite);
      }
    }
  } catch {}
  if (pids && pids.length > 0) {
    _pgrepCache = {
      pids,
      appName,
      ts: now
    };
  }
  return pids;
}
const commands = {};
function getApis(ctx) {
  if (!(ctx !== null && ctx !== void 0 && ctx._backendApis)) {
    throw new _driver.errors.UnknownError('Linux backend is not initialized');
  }
  return ctx._backendApis;
}
function shouldVerifyWindowInA11y(ctx) {
  return (ctx === null || ctx === void 0 ? void 0 : ctx.linuxBackend) !== 'wayland';
}
function parseRect(rect) {
  const match = /^\[(?<x>-?\d+),(?<y>-?\d+),(?<width>\d+),(?<height>\d+)\]$/.exec(`${rect !== null && rect !== void 0 ? rect : ''}`);
  if (!match) {
    return null;
  }
  const {
    x,
    y,
    width,
    height
  } = match.groups;
  return {
    x: Number.parseInt(x, 10),
    y: Number.parseInt(y, 10),
    width: Number.parseInt(width, 10),
    height: Number.parseInt(height, 10)
  };
}
function windowPriority(node = {}) {
  var _node$states, _node$tag, _node$windowType;
  const states = `${(_node$states = node.states) !== null && _node$states !== void 0 ? _node$states : ''}`.toUpperCase();
  const tag = `${(_node$tag = node.tag) !== null && _node$tag !== void 0 ? _node$tag : ''}`.toLowerCase();
  const windowType = `${(_node$windowType = node.windowType) !== null && _node$windowType !== void 0 ? _node$windowType : ''}`.toLowerCase();
  const rect = node.rect;
  let score = 0;
  if (rect && rect.width > 0 && rect.height > 0) {
    score += rect.width * rect.height;
  }
  if (tag.includes('alert') || windowType.includes('alert')) {
    score += 100000000;
  } else if (tag.includes('dialog') || windowType.includes('dialog') || windowType.includes('modal')) {
    score += 80000000;
  } else if (tag.includes('notification') || tag.includes('popover') || windowType.includes('notification') || windowType.includes('popover') || windowType.includes('popup')) {
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
commands.getWindowHandle = function getWindowHandle() {
  var _this$_resolveBestAva2;
  if (this._win) {
    const now = Date.now();
    if (this._winHandleValidatedAt && now - this._winHandleValidatedAt < 5000) {
      return this._win.wid;
    }
    try {
      var _this$_win;
      this._win = this._getWinAndPid_FromWinId(this._win.wid);
      this._winHandleValidatedAt = Date.now();
      return (_this$_win = this._win) === null || _this$_win === void 0 ? void 0 : _this$_win.wid;
    } catch {
      var _this$_resolveBestAva;
      this._winHandleValidatedAt = 0;
      return (_this$_resolveBestAva = this._resolveBestAvailableWindow()) === null || _this$_resolveBestAva === void 0 ? void 0 : _this$_resolveBestAva.wid;
    }
  }
  return (_this$_resolveBestAva2 = this._resolveBestAvailableWindow()) === null || _this$_resolveBestAva2 === void 0 ? void 0 : _this$_resolveBestAva2.wid;
};
commands._resolveBestAvailableWindow = function _resolveBestAvailableWindow() {
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
commands.getWindowHandles = function getWindowHandles() {
  const now = Date.now();
  if (this._lastWindowHandlesResult && this._lastWindowHandlesAt && now - this._lastWindowHandlesAt < 3000 && (!this._lastUiActionAt || this._lastWindowHandlesAt > this._lastUiActionAt)) {
    return this._lastWindowHandlesResult;
  }
  const apis = getApis(this);
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
commands._getWindowHandlesCore = function _getWindowHandlesCore() {
  var _this$appArguments;
  const apis = getApis(this);
  const appName = this.appName;
  let pids = apis.app_running(appName);
  if (((_this$appArguments = this.appArguments) === null || _this$appArguments === void 0 ? void 0 : _this$appArguments.length) > 0 || this.attachToRunningApp) {
    const basenamePids = appName ? pgrepByBasename(appName) || [] : [];
    pids = [...new Set([...(pids || []), ...basenamePids])];
  } else if ((!pids || pids.length === 0) && appName) {
    pids = pgrepByBasename(appName);
  }
  if (!pids || pids.length === 0) {
    throw new _driver.errors.NoSuchWindowError(`application ${appName} is not running`);
  }
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new _xmldom.DOMParser().parseFromString(winHierachy);
  let xpath = pids.map(pid => `@pid="${pid}"`).join(' or ');
  xpath = `//*[${xpath} and @InputOutput="true"]`;
  const nodes = (0, _xpath.default)(doc, xpath);
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
  _nodes = _nodes.filter(p => p.pid && p.wid);
  if (_nodes.length === 0) {
    return [];
  }
  _nodes = _nodes.map(p => {
    let _node = {
      pid: p.pid,
      wid: p.wid,
      names: [],
      rect: p.rect || null,
      states: p.states || '',
      tag: p.tag || '',
      windowType: p.windowType || ''
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
    return [...new Set(_nodes.map(node => node.wid))];
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
  var _this$appArguments2;
  const apis = getApis(this);
  let pids = apis.app_running(this.appName);
  if (((_this$appArguments2 = this.appArguments) === null || _this$appArguments2 === void 0 ? void 0 : _this$appArguments2.length) > 0 || this.attachToRunningApp) {
    const basenamePids = this.appName ? pgrepByBasename(this.appName) || [] : [];
    pids = [...new Set([...(pids || []), ...basenamePids])];
  }
  if (!pids || pids.length === 0) {
    throw new _driver.errors.NoSuchWindowError(`application ${this.appName} is not running`);
  }
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new _xmldom.DOMParser().parseFromString(winHierachy);
  let xpath = pids.map(pid => `@pid="${pid}"`).join(' or ');
  xpath = `//*[(${xpath}) and @InputOutput="true" and (@name="${windowName}" or contains(concat(" ", @class, " "), "${' ' + windowName + ' '}"))]`;
  const nodes = (0, _xpath.default)(doc, xpath);
  if (!nodes || nodes.length === 0) {
    throw new _driver.errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
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
  _nodes = _nodes.filter(p => (p.name || p.class) && p.pid && p.wid);
  if (_nodes.length === 0) {
    throw new _driver.errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
  }
  _nodes = _nodes.map(p => ({
    ...p,
    pid: Number.parseInt(p.pid, 10),
    wid: Number.parseInt(p.wid, 10),
    rect: parseRect(p.rect),
    states: p.states || '',
    tag: p.tag || '',
    windowType: p['window-type'] || p.windowType || ''
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
      windowType: candidate.windowType || ''
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
        windowType: _node.windowType || ''
      };
    }
  }
  throw new _driver.errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
};
commands._getWinAndPid_FromWinId = function (wid) {
  const apis = getApis(this);
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new _xmldom.DOMParser().parseFromString(winHierachy);
  const xpath = `//*[@wid="${wid}" and @InputOutput="true"]`;
  const nodes = (0, _xpath.default)(doc, xpath);
  if (!nodes || nodes.length === 0) {
    throw new _driver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
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
  _nodes = _nodes.map(p => ({
    ...p,
    pid: Number.parseInt(p.pid, 10),
    wid: Number.parseInt(p.wid, 10),
    rect: parseRect(p.rect),
    states: p.states || '',
    tag: p.tag || '',
    windowType: p['window-type'] || p.windowType || ''
  })).filter(p => p.pid && p.wid);
  if (_nodes.length === 0) {
    throw new _driver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  _nodes.sort((a, b) => windowPriority(b) - windowPriority(a));
  const node = _nodes[0];
  if (!node.pid || !node.wid) {
    throw new _driver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  if (!shouldVerifyWindowInA11y(this)) {
    return {
      pid: node.pid,
      wid: node.wid,
      name: node.name,
      rect: node.rect || null,
      states: node.states || '',
      tag: node.tag || '',
      windowType: node.windowType || ''
    };
  }
  if (node.name && !apis.a11y_checkWindowExists(node.name, node.pid)) {
    throw new _driver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  return {
    pid: node.pid,
    wid: node.wid,
    name: node.name,
    rect: node.rect || null,
    states: node.states || '',
    tag: node.tag || '',
    windowType: node.windowType || ''
  };
};
function validateName(name) {
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
function validateHandle(handle) {
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
commands.setWindow = function setWindow(name, handle) {
  handle = validateHandle(handle);
  name = validateName(name);
  if (name) {
    const win = this._getWinAndPid_FromWinName(name);
    this._win = win;
  } else if (handle) {
    const win = this._getWinAndPid_FromWinId(handle);
    this._win = win;
  } else {
    throw new _driver.errors.UnknownError("setWindow both name and handle don't have a value");
  }
  this._lastCacheClearAt = 0;
  this._winValidatedAt = 0;
  this._winHandleValidatedAt = 0;
  this._lastWindowHandlesAt = 0;
};
commands.getWindowRect = function getWindowRect() {
  const apis = getApis(this);
  const win = this._win;
  if (!win) {
    throw new _driver.errors.NoSuchWindowError(`window is not specified`);
  }
  const {
    wid
  } = win;
  return apis.app_getWinRect(wid);
};
var _default = exports.default = commands;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2NvbW1hbmRzL3dpbmRvdy5qcyIsIm5hbWVzIjpbIl94cGF0aCIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3htbGRvbSIsIl9kcml2ZXIiLCJfY2hpbGRfcHJvY2VzcyIsIl9wZ3JlcENhY2hlIiwicGlkcyIsImFwcE5hbWUiLCJ0cyIsIlBHUkVQX0NBQ0hFX1RUTF9NUyIsInBncmVwQnlCYXNlbmFtZSIsIm5vdyIsIkRhdGUiLCJiYXNlTmFtZSIsInNwbGl0IiwicG9wIiwicmVzIiwic3Bhd25TeW5jIiwiZW5jb2RpbmciLCJ0aW1lb3V0Iiwic3RhdHVzIiwic3Rkb3V0IiwidHJpbSIsIm1hcCIsIk51bWJlciIsImZpbHRlciIsImlzRmluaXRlIiwibGVuZ3RoIiwiY29tbWFuZHMiLCJnZXRBcGlzIiwiY3R4IiwiX2JhY2tlbmRBcGlzIiwiZXJyb3JzIiwiVW5rbm93bkVycm9yIiwic2hvdWxkVmVyaWZ5V2luZG93SW5BMTF5IiwibGludXhCYWNrZW5kIiwicGFyc2VSZWN0IiwicmVjdCIsIm1hdGNoIiwiZXhlYyIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJncm91cHMiLCJwYXJzZUludCIsIndpbmRvd1ByaW9yaXR5Iiwibm9kZSIsIl9ub2RlJHN0YXRlcyIsIl9ub2RlJHRhZyIsIl9ub2RlJHdpbmRvd1R5cGUiLCJzdGF0ZXMiLCJ0b1VwcGVyQ2FzZSIsInRhZyIsInRvTG93ZXJDYXNlIiwid2luZG93VHlwZSIsInNjb3JlIiwiaW5jbHVkZXMiLCJnZXRXaW5kb3dIYW5kbGUiLCJfdGhpcyRfcmVzb2x2ZUJlc3RBdmEyIiwiX3dpbiIsIl93aW5IYW5kbGVWYWxpZGF0ZWRBdCIsIndpZCIsIl90aGlzJF93aW4iLCJfZ2V0V2luQW5kUGlkX0Zyb21XaW5JZCIsIl90aGlzJF9yZXNvbHZlQmVzdEF2YSIsIl9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdyIsImhhbmRsZXMiLCJfZ2V0V2luZG93SGFuZGxlc0NvcmUiLCJoYW5kbGUiLCJ3aW4iLCJnZXRXaW5kb3dIYW5kbGVzIiwiX2xhc3RXaW5kb3dIYW5kbGVzUmVzdWx0IiwiX2xhc3RXaW5kb3dIYW5kbGVzQXQiLCJfbGFzdFVpQWN0aW9uQXQiLCJhcGlzIiwiX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUiLCJfaW52YWxpZGF0ZVdpbmRvd0hpZXJhcmNoeVhtbENhY2hlIiwicmVzdWx0IiwiX3RoaXMkYXBwQXJndW1lbnRzIiwiYXBwX3J1bm5pbmciLCJhcHBBcmd1bWVudHMiLCJhdHRhY2hUb1J1bm5pbmdBcHAiLCJiYXNlbmFtZVBpZHMiLCJTZXQiLCJOb1N1Y2hXaW5kb3dFcnJvciIsIndpbkhpZXJhY2h5IiwiYXBwX2dldFdpbmRvd0hpZXJhY2h5IiwiZG9jIiwiZG9tIiwicGFyc2VGcm9tU3RyaW5nIiwieHBhdGgiLCJwaWQiLCJqb2luIiwibm9kZXMiLCJzZWxlY3QiLCJfbm9kZXMiLCJhdHRyaWJ1dGVzIiwiX25vZGUiLCJhdHRycyIsIkFycmF5IiwiZnJvbSIsImF0dHIiLCJuYW1lIiwiY2xhc3MiLCJ2YWx1ZSIsInB1c2giLCJwIiwibmFtZXMiLCJzb3J0IiwiYSIsImIiLCJ3aWRzIiwib2siLCJhMTF5X2NoZWNrV2luZG93RXhpc3RzIiwiX2dldFdpbkFuZFBpZF9Gcm9tV2luTmFtZSIsIndpbmRvd05hbWUiLCJfdGhpcyRhcHBBcmd1bWVudHMyIiwiYXYiLCJidiIsImNhbmRpZGF0ZSIsIl9waWQiLCJjdXJyZW50Tm9kZSIsInZhbGlkYXRlTmFtZSIsImkiLCJ2YWxpZGF0ZUhhbmRsZSIsInNldFdpbmRvdyIsIl9sYXN0Q2FjaGVDbGVhckF0IiwiX3dpblZhbGlkYXRlZEF0IiwiZ2V0V2luZG93UmVjdCIsImFwcF9nZXRXaW5SZWN0IiwiX2RlZmF1bHQiLCJleHBvcnRzIiwiZGVmYXVsdCJdLCJzb3VyY2VSb290IjoiLi4vLi4vLi4iLCJzb3VyY2VzIjpbImxpYi9jb21tYW5kcy93aW5kb3cuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHNlbGVjdCBmcm9tICd4cGF0aC5qcyc7XG5pbXBvcnQgeyBET01QYXJzZXIgYXMgZG9tIH0gZnJvbSAnQHhtbGRvbS94bWxkb20nO1xuaW1wb3J0IHsgZXJyb3JzIH0gZnJvbSAnYXBwaXVtL2RyaXZlcic7XG5pbXBvcnQgeyBzcGF3blN5bmMgfSBmcm9tICdjaGlsZF9wcm9jZXNzJztcblxuLy8gU2hvcnQtbGl2ZWQgY2FjaGUgZm9yIHBncmVwLWJ5LWJhc2VuYW1lIHJlc3VsdHMuICBTcGF3bmluZyBwZ3JlcCBvbiBldmVyeVxuLy8gZ2V0V2luZG93SGFuZGxlcyAvIGdldFdpbmRvdyBjYWxsIGFkZHMgfjUwMCBtcyBwZXIgY2FsbC4gIENhY2hpbmcgdGhlIHJlc3VsdFxuLy8gZm9yIDMgc2Vjb25kcyBhdm9pZHMgcmVkdW5kYW50IHByb2Nlc3Mgc3Bhd25zIGR1cmluZyByYXBpZCBwb2xsaW5nLlxubGV0IF9wZ3JlcENhY2hlID0ge3BpZHM6IG51bGwsIGFwcE5hbWU6IG51bGwsIHRzOiAwfTtcbmNvbnN0IFBHUkVQX0NBQ0hFX1RUTF9NUyA9IDMwMDA7XG5cbmZ1bmN0aW9uIHBncmVwQnlCYXNlbmFtZSAoYXBwTmFtZSkge1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBpZiAoX3BncmVwQ2FjaGUuYXBwTmFtZSA9PT0gYXBwTmFtZSAmJiBfcGdyZXBDYWNoZS5waWRzICYmIChub3cgLSBfcGdyZXBDYWNoZS50cykgPCBQR1JFUF9DQUNIRV9UVExfTVMpIHtcbiAgICByZXR1cm4gX3BncmVwQ2FjaGUucGlkcztcbiAgfVxuICBsZXQgcGlkcyA9IG51bGw7XG4gIHRyeSB7XG4gICAgY29uc3QgYmFzZU5hbWUgPSAoYXBwTmFtZSB8fCAnJykuc3BsaXQoJy8nKS5wb3AoKTtcbiAgICBpZiAoYmFzZU5hbWUpIHtcbiAgICAgIGNvbnN0IHJlcyA9IHNwYXduU3luYygncGdyZXAnLCBbJy1mJywgYmFzZU5hbWVdLCB7ZW5jb2Rpbmc6ICd1dGY4JywgdGltZW91dDogMzAwMH0pO1xuICAgICAgaWYgKHJlcy5zdGF0dXMgPT09IDAgJiYgcmVzLnN0ZG91dCkge1xuICAgICAgICBwaWRzID0gcmVzLnN0ZG91dC50cmltKCkuc3BsaXQoL1xccysvKS5tYXAoTnVtYmVyKS5maWx0ZXIoTnVtYmVyLmlzRmluaXRlKTtcbiAgICAgIH1cbiAgICB9XG4gIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuICBpZiAocGlkcyAmJiBwaWRzLmxlbmd0aCA+IDApIHtcbiAgICBfcGdyZXBDYWNoZSA9IHtwaWRzLCBhcHBOYW1lLCB0czogbm93fTtcbiAgfVxuICByZXR1cm4gcGlkcztcbn1cblxuY29uc3QgY29tbWFuZHMgPSB7fTtcbmZ1bmN0aW9uIGdldEFwaXMgKGN0eCkge1xuICBpZiAoIWN0eD8uX2JhY2tlbmRBcGlzKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoJ0xpbnV4IGJhY2tlbmQgaXMgbm90IGluaXRpYWxpemVkJyk7XG4gIH1cbiAgcmV0dXJuIGN0eC5fYmFja2VuZEFwaXM7XG59XG5cbmZ1bmN0aW9uIHNob3VsZFZlcmlmeVdpbmRvd0luQTExeSAoY3R4KSB7XG4gIHJldHVybiBjdHg/LmxpbnV4QmFja2VuZCAhPT0gJ3dheWxhbmQnO1xufVxuXG5mdW5jdGlvbiBwYXJzZVJlY3QgKHJlY3QpIHtcbiAgY29uc3QgbWF0Y2ggPSAvXlxcWyg/PHg+LT9cXGQrKSwoPzx5Pi0/XFxkKyksKD88d2lkdGg+XFxkKyksKD88aGVpZ2h0PlxcZCspXFxdJC8uZXhlYyhgJHtyZWN0ID8/ICcnfWApO1xuICBpZiAoIW1hdGNoKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3Qge3gsIHksIHdpZHRoLCBoZWlnaHR9ID0gbWF0Y2guZ3JvdXBzO1xuICByZXR1cm4ge1xuICAgIHg6IE51bWJlci5wYXJzZUludCh4LCAxMCksXG4gICAgeTogTnVtYmVyLnBhcnNlSW50KHksIDEwKSxcbiAgICB3aWR0aDogTnVtYmVyLnBhcnNlSW50KHdpZHRoLCAxMCksXG4gICAgaGVpZ2h0OiBOdW1iZXIucGFyc2VJbnQoaGVpZ2h0LCAxMCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIHdpbmRvd1ByaW9yaXR5IChub2RlID0ge30pIHtcbiAgY29uc3Qgc3RhdGVzID0gYCR7bm9kZS5zdGF0ZXMgPz8gJyd9YC50b1VwcGVyQ2FzZSgpO1xuICBjb25zdCB0YWcgPSBgJHtub2RlLnRhZyA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHdpbmRvd1R5cGUgPSBgJHtub2RlLndpbmRvd1R5cGUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCByZWN0ID0gbm9kZS5yZWN0O1xuICBsZXQgc2NvcmUgPSAwO1xuICBpZiAocmVjdCAmJiByZWN0LndpZHRoID4gMCAmJiByZWN0LmhlaWdodCA+IDApIHtcbiAgICBzY29yZSArPSByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XG4gIH1cbiAgaWYgKHRhZy5pbmNsdWRlcygnYWxlcnQnKSB8fCB3aW5kb3dUeXBlLmluY2x1ZGVzKCdhbGVydCcpKSB7XG4gICAgc2NvcmUgKz0gMTAwMDAwMDAwO1xuICB9IGVsc2UgaWYgKHRhZy5pbmNsdWRlcygnZGlhbG9nJykgfHwgd2luZG93VHlwZS5pbmNsdWRlcygnZGlhbG9nJykgfHwgd2luZG93VHlwZS5pbmNsdWRlcygnbW9kYWwnKSkge1xuICAgIHNjb3JlICs9IDgwMDAwMDAwO1xuICB9IGVsc2UgaWYgKFxuICAgIHRhZy5pbmNsdWRlcygnbm90aWZpY2F0aW9uJylcbiAgICB8fCB0YWcuaW5jbHVkZXMoJ3BvcG92ZXInKVxuICAgIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXMoJ25vdGlmaWNhdGlvbicpXG4gICAgfHwgd2luZG93VHlwZS5pbmNsdWRlcygncG9wb3ZlcicpXG4gICAgfHwgd2luZG93VHlwZS5pbmNsdWRlcygncG9wdXAnKVxuICApIHtcbiAgICBzY29yZSArPSA2MDAwMDAwMDtcbiAgfVxuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdBQ1RJVkUnKSkge1xuICAgIHNjb3JlICs9IDUwMDAwMDAwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ1NIT1dJTkcnKSB8fCBzdGF0ZXMuaW5jbHVkZXMoJ1ZJU0lCTEUnKSkge1xuICAgIHNjb3JlICs9IDI1MDAwMDAwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ0VOQUJMRUQnKSB8fCBzdGF0ZXMuaW5jbHVkZXMoJ1NFTlNJVElWRScpKSB7XG4gICAgc2NvcmUgKz0gNTAwMDAwMDtcbiAgfVxuICByZXR1cm4gc2NvcmU7XG59XG5cbmNvbW1hbmRzLmdldFdpbmRvd0hhbmRsZSA9IGZ1bmN0aW9uIGdldFdpbmRvd0hhbmRsZSAoKSB7XG4gIC8vIFNob3J0LWxpdmVkIGNhY2hlOiB0aGUgYWN0aXZlIHdpbmRvdyBkb2Vzbid0IGNoYW5nZSBiZXR3ZWVuIHJhcGlkIHBvbGxzXG4gIGlmICh0aGlzLl93aW4pIHtcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICAgIGlmICh0aGlzLl93aW5IYW5kbGVWYWxpZGF0ZWRBdCAmJiAobm93IC0gdGhpcy5fd2luSGFuZGxlVmFsaWRhdGVkQXQpIDwgNTAwMCkge1xuICAgICAgcmV0dXJuIHRoaXMuX3dpbi53aWQ7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICB0aGlzLl93aW4gPSB0aGlzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbklkKHRoaXMuX3dpbi53aWQpO1xuICAgICAgdGhpcy5fd2luSGFuZGxlVmFsaWRhdGVkQXQgPSBEYXRlLm5vdygpO1xuICAgICAgcmV0dXJuIHRoaXMuX3dpbj8ud2lkO1xuICAgIH0gY2F0Y2gge1xuICAgICAgdGhpcy5fd2luSGFuZGxlVmFsaWRhdGVkQXQgPSAwO1xuICAgICAgcmV0dXJuIHRoaXMuX3Jlc29sdmVCZXN0QXZhaWxhYmxlV2luZG93KCk/LndpZDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHRoaXMuX3Jlc29sdmVCZXN0QXZhaWxhYmxlV2luZG93KCk/LndpZDtcbn07XG5cbmNvbW1hbmRzLl9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdyA9IGZ1bmN0aW9uIF9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdyAoKSB7XG4gIC8vIEludGVybmFsIHJlY292ZXJ5IHBhdGgg4oCUIHJldXNlIHRoZSB3aW5kb3cgbGlzdCB0aGF0IHdhcyBKVVNUIHJlYnVpbHRcbiAgLy8gYnkgdGhlIGNhbGxlcidzIGdldFdpbmRvd0hhbmRsZXMoKS4gIERvIE5PVCBpbnZhbGlkYXRlIGRlc2t0b3AgY2FjaGVcbiAgLy8gYWdhaW4gdG8gYXZvaWQgY2FzY2FkaW5nIDItNHMgZGVza3RvcCByZWJ1aWxkcy5cbiAgY29uc3QgaGFuZGxlcyA9IHRoaXMuX2dldFdpbmRvd0hhbmRsZXNDb3JlKCk7XG4gIGZvciAoY29uc3QgaGFuZGxlIG9mIGhhbmRsZXMpIHtcbiAgICB0cnkge1xuICAgICAgY29uc3Qgd2luID0gdGhpcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5JZChoYW5kbGUpO1xuICAgICAgdGhpcy5fd2luID0gd2luO1xuICAgICAgcmV0dXJuIHdpbjtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgfVxuICB0aGlzLl93aW4gPSBudWxsO1xuICByZXR1cm4gbnVsbDtcbn07XG5cbmNvbW1hbmRzLmdldFdpbmRvd0hhbmRsZXMgPSBmdW5jdGlvbiBnZXRXaW5kb3dIYW5kbGVzICgpIHtcbiAgLy8gU2hvcnQtY2lyY3VpdDogcmV0dXJuIGNhY2hlZCBoYW5kbGVzIHdoZW4gbm8gVUkgYWN0aW9uIGhhcyBoYXBwZW5lZFxuICAvLyBzaW5jZSB0aGUgbGFzdCBzY2FuLiAgVGhpcyBhdm9pZHMgcmVkdW5kYW50IH4yLTI4cyBuYXRpdmUgQVQtU1BJXG4gIC8vIGRlc2t0b3AgcmUtc2NhbnMgZHVyaW5nIHJhcGlkIHBvbGxpbmcgKGUuZy4gc3dpdGNoX3RvX25ld193aW5kb3cpLlxuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBpZiAodGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNSZXN1bHRcbiAgICAgICYmIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzQXQgJiYgKG5vdyAtIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzQXQpIDwgMzAwMFxuICAgICAgJiYgKCF0aGlzLl9sYXN0VWlBY3Rpb25BdCB8fCB0aGlzLl9sYXN0V2luZG93SGFuZGxlc0F0ID4gdGhpcy5fbGFzdFVpQWN0aW9uQXQpKSB7XG4gICAgcmV0dXJuIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzUmVzdWx0O1xuICB9XG4gIGNvbnN0IGFwaXMgPSBnZXRBcGlzKHRoaXMpO1xuICAvLyBJbnZhbGlkYXRlIGRlc2t0b3AgKyB3aW5kb3cgWE1MIGNhY2hlcyBzbyB3ZSBhbHdheXMgZGlzY292ZXJcbiAgLy8gbmV3bHktYXBwZWFyZWQgb3IgcmVjZW50bHktY2xvc2VkIHdpbmRvd3MgKGUuZy4gXCJDb25uZWN0IEluc2VjdXJlbHlcIikuXG4gIC8vIFRoaXMgY29zdHMgfjItM3MgZm9yIGEgZnJlc2ggbmF0aXZlIEFULVNQSSBkZXNrdG9wIHNjYW4uXG4gIGlmICh0eXBlb2YgYXBpcy5faW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGFwaXMuX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUoKTtcbiAgfVxuICBpZiAodHlwZW9mIGFwaXMuX2ludmFsaWRhdGVXaW5kb3dIaWVyYXJjaHlYbWxDYWNoZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgIGFwaXMuX2ludmFsaWRhdGVXaW5kb3dIaWVyYXJjaHlYbWxDYWNoZSgpO1xuICB9XG4gIGNvbnN0IHJlc3VsdCA9IHRoaXMuX2dldFdpbmRvd0hhbmRsZXNDb3JlKCk7XG4gIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzQXQgPSBEYXRlLm5vdygpO1xuICB0aGlzLl9sYXN0V2luZG93SGFuZGxlc1Jlc3VsdCA9IHJlc3VsdDtcbiAgcmV0dXJuIHJlc3VsdDtcbn07XG5cbi8vIENvcmUgbG9naWMgc2hhcmVkIGJ5IGdldFdpbmRvd0hhbmRsZXMgKGZyZXNoKSBhbmQgX3Jlc29sdmVCZXN0QXZhaWxhYmxlV2luZG93IChjYWNoZWQpLlxuY29tbWFuZHMuX2dldFdpbmRvd0hhbmRsZXNDb3JlID0gZnVuY3Rpb24gX2dldFdpbmRvd0hhbmRsZXNDb3JlICgpIHtcbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIGNvbnN0IGFwcE5hbWUgPSB0aGlzLmFwcE5hbWU7XG4gIGxldCBwaWRzID0gYXBpcy5hcHBfcnVubmluZyhhcHBOYW1lKTtcbiAgLy8gUHJlc2VydmUgdGhlIGVzdGFibGlzaGVkIGxvb2t1cCBmb3Igb3JkaW5hcnkgc2Vzc2lvbnMuIERpcmVjdCBhcmd1bWVudFxuICAvLyBsYXVuY2hlcyBtYXkgcmV0YWluIGEgd3JhcHBlciBwcm9jZXNzIGFsb25nc2lkZSB0aGUgVUkgY2hpbGQsIHNvIG9ubHlcbiAgLy8gdGhhdCBvcHQtaW4gcGF0aCBtZXJnZXMgYmFzZW5hbWUgbWF0Y2hlcy5cbiAgaWYgKHRoaXMuYXBwQXJndW1lbnRzPy5sZW5ndGggPiAwIHx8IHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwKSB7XG4gICAgY29uc3QgYmFzZW5hbWVQaWRzID0gYXBwTmFtZSA/IChwZ3JlcEJ5QmFzZW5hbWUoYXBwTmFtZSkgfHwgW10pIDogW107XG4gICAgcGlkcyA9IFsuLi5uZXcgU2V0KFsuLi4ocGlkcyB8fCBbXSksIC4uLmJhc2VuYW1lUGlkc10pXTtcbiAgfSBlbHNlIGlmICgoIXBpZHMgfHwgcGlkcy5sZW5ndGggPT09IDApICYmIGFwcE5hbWUpIHtcbiAgICBwaWRzID0gcGdyZXBCeUJhc2VuYW1lKGFwcE5hbWUpO1xuICB9XG4gIGlmICghcGlkcyB8fCBwaWRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYGFwcGxpY2F0aW9uICR7YXBwTmFtZX0gaXMgbm90IHJ1bm5pbmdgKTtcbiAgfVxuICBjb25zdCB3aW5IaWVyYWNoeSA9IGFwaXMuYXBwX2dldFdpbmRvd0hpZXJhY2h5KCk7XG4gIGNvbnN0IGRvYyA9IG5ldyBkb20oKS5wYXJzZUZyb21TdHJpbmcod2luSGllcmFjaHkpO1xuICBsZXQgeHBhdGggPSBwaWRzLm1hcCgocGlkKSA9PiBgQHBpZD1cIiR7cGlkfVwiYCkuam9pbignIG9yICcpO1xuICB4cGF0aCA9IGAvLypbJHt4cGF0aH0gYW5kIEBJbnB1dE91dHB1dD1cInRydWVcIl1gO1xuICBjb25zdCBub2RlcyA9IHNlbGVjdChkb2MsIHhwYXRoKTtcbiAgaWYgKCFub2RlcyB8fCBub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgbGV0IF9ub2RlcyA9IFtdO1xuICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICBpZiAoIW5vZGUuYXR0cmlidXRlcykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IF9ub2RlID0ge307XG4gICAgY29uc3QgYXR0cnMgPSBBcnJheS5mcm9tKG5vZGUuYXR0cmlidXRlcyk7XG4gICAgZm9yIChjb25zdCBhdHRyIG9mIGF0dHJzKSB7XG4gICAgICBpZiAoYXR0ci5uYW1lID09PSAnY2xhc3MnKSB7XG4gICAgICAgIF9ub2RlLmNsYXNzID0gYXR0ci52YWx1ZS5zcGxpdCgnICcpO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICduYW1lJykge1xuICAgICAgICBfbm9kZS5uYW1lID0gYXR0ci52YWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAncGlkJykge1xuICAgICAgICBfbm9kZS5waWQgPSBOdW1iZXIucGFyc2VJbnQoYXR0ci52YWx1ZSwgMTApO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICd3aWQnKSB7XG4gICAgICAgIF9ub2RlLndpZCA9IE51bWJlci5wYXJzZUludChhdHRyLnZhbHVlLCAxMCk7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ3JlY3QnKSB7XG4gICAgICAgIF9ub2RlLnJlY3QgPSBwYXJzZVJlY3QoYXR0ci52YWx1ZSk7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ3N0YXRlcycpIHtcbiAgICAgICAgX25vZGUuc3RhdGVzID0gYXR0ci52YWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAndGFnJykge1xuICAgICAgICBfbm9kZS50YWcgPSBhdHRyLnZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICd3aW5kb3ctdHlwZScpIHtcbiAgICAgICAgX25vZGUud2luZG93VHlwZSA9IGF0dHIudmFsdWU7XG4gICAgICB9XG4gICAgfVxuICAgIF9ub2Rlcy5wdXNoKF9ub2RlKTtcbiAgfVxuICBfbm9kZXMgPSBfbm9kZXMuZmlsdGVyKChwKSA9PiBwLnBpZCAmJiBwLndpZCk7XG4gIGlmIChfbm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIF9ub2RlcyA9IF9ub2Rlcy5tYXAoKHApID0+IHtcbiAgICBsZXQgX25vZGUgPSB7XG4gICAgICBwaWQ6IHAucGlkLFxuICAgICAgd2lkOiBwLndpZCxcbiAgICAgIG5hbWVzOiBbXSxcbiAgICAgIHJlY3Q6IHAucmVjdCB8fCBudWxsLFxuICAgICAgc3RhdGVzOiBwLnN0YXRlcyB8fCAnJyxcbiAgICAgIHRhZzogcC50YWcgfHwgJycsXG4gICAgICB3aW5kb3dUeXBlOiBwLndpbmRvd1R5cGUgfHwgJycsXG4gICAgfTtcbiAgICBpZiAocC5uYW1lKSB7XG4gICAgICBfbm9kZS5uYW1lcy5wdXNoKHAubmFtZSk7XG4gICAgfVxuICAgIGlmIChwLmNsYXNzKSB7XG4gICAgICBfbm9kZS5uYW1lcy5wdXNoKC4uLnAuY2xhc3MpO1xuICAgIH1cbiAgICByZXR1cm4gX25vZGU7XG4gIH0pO1xuICBfbm9kZXMuc29ydCgoYSwgYikgPT4gd2luZG93UHJpb3JpdHkoYikgLSB3aW5kb3dQcmlvcml0eShhKSk7XG4gIGlmICghc2hvdWxkVmVyaWZ5V2luZG93SW5BMTF5KHRoaXMpKSB7XG4gICAgLy8gV2F5bGFuZCB1c2VzIHN5bnRoZXRpYyB3aW5kb3cgaGFuZGxlcyBkZXJpdmVkIGZyb20gdGhlIGN1cnJlbnQgQVQtU1BJIHRyZWUuXG4gICAgLy8gQXZvaWQgYmxvY2tpbmcgbmF0aXZlIGExMXkgbG9va3VwcyB3aGlsZSB3aW5kb3dzIGFyZSBzdGlsbCBzZXR0bGluZy5cbiAgICByZXR1cm4gWy4uLm5ldyBTZXQoX25vZGVzLm1hcCgobm9kZSkgPT4gbm9kZS53aWQpKV07XG4gIH1cbiAgY29uc3Qgd2lkcyA9IFtdO1xuICBmb3IgKGNvbnN0IF9ub2RlIG9mIF9ub2Rlcykge1xuICAgIGxldCBvayA9IGZhbHNlO1xuICAgIGZvciAoY29uc3QgbmFtZSBvZiBfbm9kZS5uYW1lcykge1xuICAgICAgaWYgKGFwaXMuYTExeV9jaGVja1dpbmRvd0V4aXN0cyhuYW1lLCBfbm9kZS5waWQpKSB7XG4gICAgICAgIG9rID0gdHJ1ZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIGlmIChvaykge1xuICAgICAgd2lkcy5wdXNoKF9ub2RlLndpZCk7XG4gICAgfVxuICB9XG4gIHJldHVybiB3aWRzO1xufTtcblxuY29tbWFuZHMuX2dldFdpbkFuZFBpZF9Gcm9tV2luTmFtZSA9IGZ1bmN0aW9uICh3aW5kb3dOYW1lKSB7XG4gIGNvbnN0IGFwaXMgPSBnZXRBcGlzKHRoaXMpO1xuICBsZXQgcGlkcyA9IGFwaXMuYXBwX3J1bm5pbmcodGhpcy5hcHBOYW1lKTtcbiAgaWYgKHRoaXMuYXBwQXJndW1lbnRzPy5sZW5ndGggPiAwIHx8IHRoaXMuYXR0YWNoVG9SdW5uaW5nQXBwKSB7XG4gICAgY29uc3QgYmFzZW5hbWVQaWRzID0gdGhpcy5hcHBOYW1lID8gKHBncmVwQnlCYXNlbmFtZSh0aGlzLmFwcE5hbWUpIHx8IFtdKSA6IFtdO1xuICAgIHBpZHMgPSBbLi4ubmV3IFNldChbLi4uKHBpZHMgfHwgW10pLCAuLi5iYXNlbmFtZVBpZHNdKV07XG4gIH1cbiAgaWYgKCFwaWRzIHx8IHBpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgYXBwbGljYXRpb24gJHt0aGlzLmFwcE5hbWV9IGlzIG5vdCBydW5uaW5nYCk7XG4gIH1cbiAgY29uc3Qgd2luSGllcmFjaHkgPSBhcGlzLmFwcF9nZXRXaW5kb3dIaWVyYWNoeSgpO1xuICBjb25zdCBkb2MgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKHdpbkhpZXJhY2h5KTtcbiAgbGV0IHhwYXRoID0gcGlkcy5tYXAoKHBpZCkgPT4gYEBwaWQ9XCIke3BpZH1cImApLmpvaW4oJyBvciAnKTtcbiAgeHBhdGggPSBgLy8qWygke3hwYXRofSkgYW5kIEBJbnB1dE91dHB1dD1cInRydWVcIiBhbmQgKEBuYW1lPVwiJHt3aW5kb3dOYW1lfVwiIG9yIGNvbnRhaW5zKGNvbmNhdChcIiBcIiwgQGNsYXNzLCBcIiBcIiksIFwiJHsnICcgKyB3aW5kb3dOYW1lICsgJyAnfVwiKSldYDtcbiAgY29uc3Qgbm9kZXMgPSBzZWxlY3QoZG9jLCB4cGF0aCk7XG4gIGlmICghbm9kZXMgfHwgbm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHdpbmRvdyAke3dpbmRvd05hbWV9IGRvZXNuJ3QgcHJlc2VudGApO1xuICB9XG4gIGxldCBfbm9kZXMgPSBbXTtcbiAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgaWYgKCFub2RlLmF0dHJpYnV0ZXMpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBhdHRycyA9IEFycmF5LmZyb20obm9kZS5hdHRyaWJ1dGVzKTtcbiAgICBjb25zdCBfbm9kZSA9IHt9O1xuICAgIGZvciAoY29uc3QgYXR0ciBvZiBhdHRycykge1xuICAgICAgX25vZGVbYXR0ci5uYW1lXSA9IGF0dHIudmFsdWU7XG4gICAgfVxuICAgIF9ub2Rlcy5wdXNoKF9ub2RlKTtcbiAgfVxuICBfbm9kZXMgPSBfbm9kZXMuZmlsdGVyKChwKSA9PiAocC5uYW1lIHx8IHAuY2xhc3MpICYmIHAucGlkICYmIHAud2lkKTtcbiAgaWYgKF9ub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93ICR7d2luZG93TmFtZX0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgX25vZGVzID0gX25vZGVzLm1hcCgocCkgPT4gKHtcbiAgICAuLi5wLFxuICAgIHBpZDogTnVtYmVyLnBhcnNlSW50KHAucGlkLCAxMCksXG4gICAgd2lkOiBOdW1iZXIucGFyc2VJbnQocC53aWQsIDEwKSxcbiAgICByZWN0OiBwYXJzZVJlY3QocC5yZWN0KSxcbiAgICBzdGF0ZXM6IHAuc3RhdGVzIHx8ICcnLFxuICAgIHRhZzogcC50YWcgfHwgJycsXG4gICAgd2luZG93VHlwZTogcFsnd2luZG93LXR5cGUnXSB8fCBwLndpbmRvd1R5cGUgfHwgJycsXG4gIH0pKTtcbiAgX25vZGVzLnNvcnQoKGEsIGIpID0+IHtcbiAgICBjb25zdCBhdiA9IGEubmFtZSA9PT0gd2luZG93TmFtZSA/IC0xIDogMTtcbiAgICBjb25zdCBidiA9IGIubmFtZSA9PT0gd2luZG93TmFtZSA/IC0xIDogMTtcbiAgICByZXR1cm4gYXYgLSBidiB8fCB3aW5kb3dQcmlvcml0eShiKSAtIHdpbmRvd1ByaW9yaXR5KGEpO1xuICB9KTtcbiAgaWYgKCFzaG91bGRWZXJpZnlXaW5kb3dJbkExMXkodGhpcykpIHtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSBfbm9kZXNbMF07XG4gICAgcmV0dXJuIHtcbiAgICAgIHBpZDogY2FuZGlkYXRlLnBpZCxcbiAgICAgIHdpZDogY2FuZGlkYXRlLndpZCxcbiAgICAgIG5hbWU6IGNhbmRpZGF0ZS5uYW1lIHx8IHdpbmRvd05hbWUsXG4gICAgICByZWN0OiBjYW5kaWRhdGUucmVjdCB8fCBudWxsLFxuICAgICAgc3RhdGVzOiBjYW5kaWRhdGUuc3RhdGVzIHx8ICcnLFxuICAgICAgdGFnOiBjYW5kaWRhdGUudGFnIHx8ICcnLFxuICAgICAgd2luZG93VHlwZTogY2FuZGlkYXRlLndpbmRvd1R5cGUgfHwgJycsXG4gICAgfTtcbiAgfVxuICBmb3IgKGNvbnN0IF9ub2RlIG9mIF9ub2Rlcykge1xuICAgIGNvbnN0IF9waWQgPSBfbm9kZS5waWQ7XG4gICAgaWYgKGFwaXMuYTExeV9jaGVja1dpbmRvd0V4aXN0cyh3aW5kb3dOYW1lLCBfcGlkKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGlkOiBfcGlkLFxuICAgICAgICB3aWQ6IF9ub2RlLndpZCxcbiAgICAgICAgbmFtZTogd2luZG93TmFtZSxcbiAgICAgICAgcmVjdDogX25vZGUucmVjdCB8fCBudWxsLFxuICAgICAgICBzdGF0ZXM6IF9ub2RlLnN0YXRlcyB8fCAnJyxcbiAgICAgICAgdGFnOiBfbm9kZS50YWcgfHwgJycsXG4gICAgICAgIHdpbmRvd1R5cGU6IF9ub2RlLndpbmRvd1R5cGUgfHwgJycsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93ICR7d2luZG93TmFtZX0gZG9lc24ndCBwcmVzZW50YCk7XG59O1xuXG5jb21tYW5kcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5JZCA9IGZ1bmN0aW9uICh3aWQpIHtcbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIGNvbnN0IHdpbkhpZXJhY2h5ID0gYXBpcy5hcHBfZ2V0V2luZG93SGllcmFjaHkoKTtcbiAgY29uc3QgZG9jID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyh3aW5IaWVyYWNoeSk7XG4gIGNvbnN0IHhwYXRoID0gYC8vKltAd2lkPVwiJHt3aWR9XCIgYW5kIEBJbnB1dE91dHB1dD1cInRydWVcIl1gO1xuICBjb25zdCBub2RlcyA9IHNlbGVjdChkb2MsIHhwYXRoKTtcbiAgaWYgKCFub2RlcyB8fCBub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93IHdpZD0ke3dpZH0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgbGV0IF9ub2RlcyA9IFtdO1xuICBmb3IgKGNvbnN0IGN1cnJlbnROb2RlIG9mIG5vZGVzKSB7XG4gICAgY29uc3QgYXR0cnMgPSBBcnJheS5mcm9tKGN1cnJlbnROb2RlLmF0dHJpYnV0ZXMpO1xuICAgIGNvbnN0IF9ub2RlID0ge307XG4gICAgZm9yIChjb25zdCBhdHRyIG9mIGF0dHJzKSB7XG4gICAgICBfbm9kZVthdHRyLm5hbWVdID0gYXR0ci52YWx1ZTtcbiAgICB9XG4gICAgX25vZGVzLnB1c2goX25vZGUpO1xuICB9XG4gIF9ub2RlcyA9IF9ub2Rlcy5tYXAoKHApID0+ICh7XG4gICAgLi4ucCxcbiAgICBwaWQ6IE51bWJlci5wYXJzZUludChwLnBpZCwgMTApLFxuICAgIHdpZDogTnVtYmVyLnBhcnNlSW50KHAud2lkLCAxMCksXG4gICAgcmVjdDogcGFyc2VSZWN0KHAucmVjdCksXG4gICAgc3RhdGVzOiBwLnN0YXRlcyB8fCAnJyxcbiAgICB0YWc6IHAudGFnIHx8ICcnLFxuICAgIHdpbmRvd1R5cGU6IHBbJ3dpbmRvdy10eXBlJ10gfHwgcC53aW5kb3dUeXBlIHx8ICcnLFxuICB9KSkuZmlsdGVyKChwKSA9PiBwLnBpZCAmJiBwLndpZCk7XG4gIGlmIChfbm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHdpbmRvdyB3aWQ9JHt3aWR9IGRvZXNuJ3QgcHJlc2VudGApO1xuICB9XG4gIF9ub2Rlcy5zb3J0KChhLCBiKSA9PiB3aW5kb3dQcmlvcml0eShiKSAtIHdpbmRvd1ByaW9yaXR5KGEpKTtcbiAgY29uc3Qgbm9kZSA9IF9ub2Rlc1swXTtcbiAgaWYgKCFub2RlLnBpZCB8fCAhbm9kZS53aWQpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93IHdpZD0ke3dpZH0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgaWYgKCFzaG91bGRWZXJpZnlXaW5kb3dJbkExMXkodGhpcykpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcGlkOiBub2RlLnBpZCxcbiAgICAgIHdpZDogbm9kZS53aWQsXG4gICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICByZWN0OiBub2RlLnJlY3QgfHwgbnVsbCxcbiAgICAgIHN0YXRlczogbm9kZS5zdGF0ZXMgfHwgJycsXG4gICAgICB0YWc6IG5vZGUudGFnIHx8ICcnLFxuICAgICAgd2luZG93VHlwZTogbm9kZS53aW5kb3dUeXBlIHx8ICcnLFxuICAgIH07XG4gIH1cbiAgaWYgKG5vZGUubmFtZSAmJiAhYXBpcy5hMTF5X2NoZWNrV2luZG93RXhpc3RzKG5vZGUubmFtZSwgbm9kZS5waWQpKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHdpbmRvdyB3aWQ9JHt3aWR9IGRvZXNuJ3QgcHJlc2VudGApO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGlkOiBub2RlLnBpZCxcbiAgICB3aWQ6IG5vZGUud2lkLFxuICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICByZWN0OiBub2RlLnJlY3QgfHwgbnVsbCxcbiAgICBzdGF0ZXM6IG5vZGUuc3RhdGVzIHx8ICcnLFxuICAgIHRhZzogbm9kZS50YWcgfHwgJycsXG4gICAgd2luZG93VHlwZTogbm9kZS53aW5kb3dUeXBlIHx8ICcnLFxuICB9O1xufTtcblxuZnVuY3Rpb24gdmFsaWRhdGVOYW1lIChuYW1lKSB7XG4gIGlmICghbmFtZSkge1xuICAgIHJldHVybiBuYW1lO1xuICB9XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbmFtZS5sZW5ndGg7ICsraSkge1xuICAgIGlmIChuYW1lW2ldIDwgJzAnIHx8IG5hbWVbaV0gPiAnOScpIHtcbiAgICAgIHJldHVybiBuYW1lO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVIYW5kbGUgKGhhbmRsZSkge1xuICBpZiAoIWhhbmRsZSkge1xuICAgIHJldHVybiBoYW5kbGU7XG4gIH1cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBoYW5kbGUubGVuZ3RoOyArK2kpIHtcbiAgICBpZiAoaGFuZGxlW2ldIDwgJzAnIHx8IGhhbmRsZVtpXSA+ICc5Jykge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG4gIHJldHVybiBoYW5kbGU7XG59XG5cbmNvbW1hbmRzLnNldFdpbmRvdyA9IGZ1bmN0aW9uIHNldFdpbmRvdyAobmFtZSwgaGFuZGxlKSB7XG4gIGhhbmRsZSA9IHZhbGlkYXRlSGFuZGxlKGhhbmRsZSk7XG4gIG5hbWUgPSB2YWxpZGF0ZU5hbWUobmFtZSk7XG4gIGlmIChuYW1lKSB7XG4gICAgY29uc3Qgd2luID0gdGhpcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5OYW1lKG5hbWUpO1xuICAgIHRoaXMuX3dpbiA9IHdpbjtcbiAgfSBlbHNlIGlmIChoYW5kbGUpIHtcbiAgICBjb25zdCB3aW4gPSB0aGlzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbklkKGhhbmRsZSk7XG4gICAgdGhpcy5fd2luID0gd2luO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKFwic2V0V2luZG93IGJvdGggbmFtZSBhbmQgaGFuZGxlIGRvbid0IGhhdmUgYSB2YWx1ZVwiKTtcbiAgfVxuICB0aGlzLl9sYXN0Q2FjaGVDbGVhckF0ID0gMDtcbiAgdGhpcy5fd2luVmFsaWRhdGVkQXQgPSAwO1xuICB0aGlzLl93aW5IYW5kbGVWYWxpZGF0ZWRBdCA9IDA7XG4gIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzQXQgPSAwO1xufTtcblxuY29tbWFuZHMuZ2V0V2luZG93UmVjdCA9IGZ1bmN0aW9uIGdldFdpbmRvd1JlY3QgKCkge1xuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgY29uc3Qgd2luID0gdGhpcy5fd2luO1xuICBpZiAoIXdpbikge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHdpbmRvdyBpcyBub3Qgc3BlY2lmaWVkYCk7XG4gIH1cbiAgY29uc3Qge3dpZH0gPSB3aW47XG4gIHJldHVybiBhcGlzLmFwcF9nZXRXaW5SZWN0KHdpZCk7XG59O1xuXG5leHBvcnQgZGVmYXVsdCBjb21tYW5kcztcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUFBQSxJQUFBQSxNQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyxjQUFBLEdBQUFILE9BQUE7QUFLQSxJQUFJSSxXQUFXLEdBQUc7RUFBQ0MsSUFBSSxFQUFFLElBQUk7RUFBRUMsT0FBTyxFQUFFLElBQUk7RUFBRUMsRUFBRSxFQUFFO0FBQUMsQ0FBQztBQUNwRCxNQUFNQyxrQkFBa0IsR0FBRyxJQUFJO0FBRS9CLFNBQVNDLGVBQWVBLENBQUVILE9BQU8sRUFBRTtFQUNqQyxNQUFNSSxHQUFHLEdBQUdDLElBQUksQ0FBQ0QsR0FBRyxDQUFDLENBQUM7RUFDdEIsSUFBSU4sV0FBVyxDQUFDRSxPQUFPLEtBQUtBLE9BQU8sSUFBSUYsV0FBVyxDQUFDQyxJQUFJLElBQUtLLEdBQUcsR0FBR04sV0FBVyxDQUFDRyxFQUFFLEdBQUlDLGtCQUFrQixFQUFFO0lBQ3RHLE9BQU9KLFdBQVcsQ0FBQ0MsSUFBSTtFQUN6QjtFQUNBLElBQUlBLElBQUksR0FBRyxJQUFJO0VBQ2YsSUFBSTtJQUNGLE1BQU1PLFFBQVEsR0FBRyxDQUFDTixPQUFPLElBQUksRUFBRSxFQUFFTyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUNDLEdBQUcsQ0FBQyxDQUFDO0lBQ2pELElBQUlGLFFBQVEsRUFBRTtNQUNaLE1BQU1HLEdBQUcsR0FBRyxJQUFBQyx3QkFBUyxFQUFDLE9BQU8sRUFBRSxDQUFDLElBQUksRUFBRUosUUFBUSxDQUFDLEVBQUU7UUFB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
