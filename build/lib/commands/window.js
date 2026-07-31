"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
require("source-map-support/register");
var _xpath = _interopRequireDefault(require("xpath.js"));
var _xmldom = require("xmldom");
var _baseDriver = require("@appium/base-driver");
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
    throw new _baseDriver.errors.UnknownError('Linux backend is not initialized');
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
    throw new _baseDriver.errors.NoSuchWindowError(`application ${appName} is not running`);
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
    throw new _baseDriver.errors.NoSuchWindowError(`application ${this.appName} is not running`);
  }
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new _xmldom.DOMParser().parseFromString(winHierachy);
  let xpath = pids.map(pid => `@pid="${pid}"`).join(' or ');
  xpath = `//*[(${xpath}) and @InputOutput="true" and (@name="${windowName}" or contains(concat(" ", @class, " "), "${' ' + windowName + ' '}"))]`;
  const nodes = (0, _xpath.default)(doc, xpath);
  if (!nodes || nodes.length === 0) {
    throw new _baseDriver.errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
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
    throw new _baseDriver.errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
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
  throw new _baseDriver.errors.NoSuchWindowError(`the window ${windowName} doesn't present`);
};
commands._getWinAndPid_FromWinId = function (wid) {
  const apis = getApis(this);
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new _xmldom.DOMParser().parseFromString(winHierachy);
  const xpath = `//*[@wid="${wid}" and @InputOutput="true"]`;
  const nodes = (0, _xpath.default)(doc, xpath);
  if (!nodes || nodes.length === 0) {
    throw new _baseDriver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
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
    throw new _baseDriver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
  }
  _nodes.sort((a, b) => windowPriority(b) - windowPriority(a));
  const node = _nodes[0];
  if (!node.pid || !node.wid) {
    throw new _baseDriver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
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
    throw new _baseDriver.errors.NoSuchWindowError(`the window wid=${wid} doesn't present`);
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
    throw new _baseDriver.errors.UnknownError("setWindow both name and handle don't have a value");
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
    throw new _baseDriver.errors.NoSuchWindowError(`window is not specified`);
  }
  const {
    wid
  } = win;
  return apis.app_getWinRect(wid);
};
var _default = exports.default = commands;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2NvbW1hbmRzL3dpbmRvdy5qcyIsIm5hbWVzIjpbIl94cGF0aCIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3htbGRvbSIsIl9iYXNlRHJpdmVyIiwiX2NoaWxkX3Byb2Nlc3MiLCJfcGdyZXBDYWNoZSIsInBpZHMiLCJhcHBOYW1lIiwidHMiLCJQR1JFUF9DQUNIRV9UVExfTVMiLCJwZ3JlcEJ5QmFzZW5hbWUiLCJub3ciLCJEYXRlIiwiYmFzZU5hbWUiLCJzcGxpdCIsInBvcCIsInJlcyIsInNwYXduU3luYyIsImVuY29kaW5nIiwidGltZW91dCIsInN0YXR1cyIsInN0ZG91dCIsInRyaW0iLCJtYXAiLCJOdW1iZXIiLCJmaWx0ZXIiLCJpc0Zpbml0ZSIsImxlbmd0aCIsImNvbW1hbmRzIiwiZ2V0QXBpcyIsImN0eCIsIl9iYWNrZW5kQXBpcyIsImVycm9ycyIsIlVua25vd25FcnJvciIsInNob3VsZFZlcmlmeVdpbmRvd0luQTExeSIsImxpbnV4QmFja2VuZCIsInBhcnNlUmVjdCIsInJlY3QiLCJtYXRjaCIsImV4ZWMiLCJ4IiwieSIsIndpZHRoIiwiaGVpZ2h0IiwiZ3JvdXBzIiwicGFyc2VJbnQiLCJ3aW5kb3dQcmlvcml0eSIsIm5vZGUiLCJfbm9kZSRzdGF0ZXMiLCJfbm9kZSR0YWciLCJfbm9kZSR3aW5kb3dUeXBlIiwic3RhdGVzIiwidG9VcHBlckNhc2UiLCJ0YWciLCJ0b0xvd2VyQ2FzZSIsIndpbmRvd1R5cGUiLCJzY29yZSIsImluY2x1ZGVzIiwiZ2V0V2luZG93SGFuZGxlIiwiX3RoaXMkX3Jlc29sdmVCZXN0QXZhMiIsIl93aW4iLCJfd2luSGFuZGxlVmFsaWRhdGVkQXQiLCJ3aWQiLCJfdGhpcyRfd2luIiwiX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQiLCJfdGhpcyRfcmVzb2x2ZUJlc3RBdmEiLCJfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3ciLCJoYW5kbGVzIiwiX2dldFdpbmRvd0hhbmRsZXNDb3JlIiwiaGFuZGxlIiwid2luIiwiZ2V0V2luZG93SGFuZGxlcyIsIl9sYXN0V2luZG93SGFuZGxlc1Jlc3VsdCIsIl9sYXN0V2luZG93SGFuZGxlc0F0IiwiX2xhc3RVaUFjdGlvbkF0IiwiYXBpcyIsIl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlIiwiX2ludmFsaWRhdGVXaW5kb3dIaWVyYXJjaHlYbWxDYWNoZSIsInJlc3VsdCIsIl90aGlzJGFwcEFyZ3VtZW50cyIsImFwcF9ydW5uaW5nIiwiYXBwQXJndW1lbnRzIiwiYXR0YWNoVG9SdW5uaW5nQXBwIiwiYmFzZW5hbWVQaWRzIiwiU2V0IiwiTm9TdWNoV2luZG93RXJyb3IiLCJ3aW5IaWVyYWNoeSIsImFwcF9nZXRXaW5kb3dIaWVyYWNoeSIsImRvYyIsImRvbSIsInBhcnNlRnJvbVN0cmluZyIsInhwYXRoIiwicGlkIiwiam9pbiIsIm5vZGVzIiwic2VsZWN0IiwiX25vZGVzIiwiYXR0cmlidXRlcyIsIl9ub2RlIiwiYXR0cnMiLCJBcnJheSIsImZyb20iLCJhdHRyIiwibmFtZSIsImNsYXNzIiwidmFsdWUiLCJwdXNoIiwicCIsIm5hbWVzIiwic29ydCIsImEiLCJiIiwid2lkcyIsIm9rIiwiYTExeV9jaGVja1dpbmRvd0V4aXN0cyIsIl9nZXRXaW5BbmRQaWRfRnJvbVdpbk5hbWUiLCJ3aW5kb3dOYW1lIiwiX3RoaXMkYXBwQXJndW1lbnRzMiIsImF2IiwiYnYiLCJjYW5kaWRhdGUiLCJfcGlkIiwiY3VycmVudE5vZGUiLCJ2YWxpZGF0ZU5hbWUiLCJpIiwidmFsaWRhdGVIYW5kbGUiLCJzZXRXaW5kb3ciLCJfbGFzdENhY2hlQ2xlYXJBdCIsIl93aW5WYWxpZGF0ZWRBdCIsImdldFdpbmRvd1JlY3QiLCJhcHBfZ2V0V2luUmVjdCIsIl9kZWZhdWx0IiwiZXhwb3J0cyIsImRlZmF1bHQiXSwic291cmNlUm9vdCI6Ii4uLy4uLy4uIiwic291cmNlcyI6WyJsaWIvY29tbWFuZHMvd2luZG93LmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCBzZWxlY3QgZnJvbSAneHBhdGguanMnO1xuaW1wb3J0IHsgRE9NUGFyc2VyIGFzIGRvbSB9IGZyb20gJ3htbGRvbSc7XG5pbXBvcnQgeyBlcnJvcnMgfSBmcm9tICdAYXBwaXVtL2Jhc2UtZHJpdmVyJztcbmltcG9ydCB7IHNwYXduU3luYyB9IGZyb20gJ2NoaWxkX3Byb2Nlc3MnO1xuXG4vLyBTaG9ydC1saXZlZCBjYWNoZSBmb3IgcGdyZXAtYnktYmFzZW5hbWUgcmVzdWx0cy4gIFNwYXduaW5nIHBncmVwIG9uIGV2ZXJ5XG4vLyBnZXRXaW5kb3dIYW5kbGVzIC8gZ2V0V2luZG93IGNhbGwgYWRkcyB+NTAwIG1zIHBlciBjYWxsLiAgQ2FjaGluZyB0aGUgcmVzdWx0XG4vLyBmb3IgMyBzZWNvbmRzIGF2b2lkcyByZWR1bmRhbnQgcHJvY2VzcyBzcGF3bnMgZHVyaW5nIHJhcGlkIHBvbGxpbmcuXG5sZXQgX3BncmVwQ2FjaGUgPSB7cGlkczogbnVsbCwgYXBwTmFtZTogbnVsbCwgdHM6IDB9O1xuY29uc3QgUEdSRVBfQ0FDSEVfVFRMX01TID0gMzAwMDtcblxuZnVuY3Rpb24gcGdyZXBCeUJhc2VuYW1lIChhcHBOYW1lKSB7XG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGlmIChfcGdyZXBDYWNoZS5hcHBOYW1lID09PSBhcHBOYW1lICYmIF9wZ3JlcENhY2hlLnBpZHMgJiYgKG5vdyAtIF9wZ3JlcENhY2hlLnRzKSA8IFBHUkVQX0NBQ0hFX1RUTF9NUykge1xuICAgIHJldHVybiBfcGdyZXBDYWNoZS5waWRzO1xuICB9XG4gIGxldCBwaWRzID0gbnVsbDtcbiAgdHJ5IHtcbiAgICBjb25zdCBiYXNlTmFtZSA9IChhcHBOYW1lIHx8ICcnKS5zcGxpdCgnLycpLnBvcCgpO1xuICAgIGlmIChiYXNlTmFtZSkge1xuICAgICAgY29uc3QgcmVzID0gc3Bhd25TeW5jKCdwZ3JlcCcsIFsnLWYnLCBiYXNlTmFtZV0sIHtlbmNvZGluZzogJ3V0ZjgnLCB0aW1lb3V0OiAzMDAwfSk7XG4gICAgICBpZiAocmVzLnN0YXR1cyA9PT0gMCAmJiByZXMuc3Rkb3V0KSB7XG4gICAgICAgIHBpZHMgPSByZXMuc3Rkb3V0LnRyaW0oKS5zcGxpdCgvXFxzKy8pLm1hcChOdW1iZXIpLmZpbHRlcihOdW1iZXIuaXNGaW5pdGUpO1xuICAgICAgfVxuICAgIH1cbiAgfSBjYXRjaCB7IC8qIGlnbm9yZSAqLyB9XG4gIGlmIChwaWRzICYmIHBpZHMubGVuZ3RoID4gMCkge1xuICAgIF9wZ3JlcENhY2hlID0ge3BpZHMsIGFwcE5hbWUsIHRzOiBub3d9O1xuICB9XG4gIHJldHVybiBwaWRzO1xufVxuXG5jb25zdCBjb21tYW5kcyA9IHt9O1xuZnVuY3Rpb24gZ2V0QXBpcyAoY3R4KSB7XG4gIGlmICghY3R4Py5fYmFja2VuZEFwaXMpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcignTGludXggYmFja2VuZCBpcyBub3QgaW5pdGlhbGl6ZWQnKTtcbiAgfVxuICByZXR1cm4gY3R4Ll9iYWNrZW5kQXBpcztcbn1cblxuZnVuY3Rpb24gc2hvdWxkVmVyaWZ5V2luZG93SW5BMTF5IChjdHgpIHtcbiAgcmV0dXJuIGN0eD8ubGludXhCYWNrZW5kICE9PSAnd2F5bGFuZCc7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUmVjdCAocmVjdCkge1xuICBjb25zdCBtYXRjaCA9IC9eXFxbKD88eD4tP1xcZCspLCg/PHk+LT9cXGQrKSwoPzx3aWR0aD5cXGQrKSwoPzxoZWlnaHQ+XFxkKylcXF0kLy5leGVjKGAke3JlY3QgPz8gJyd9YCk7XG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCB7eCwgeSwgd2lkdGgsIGhlaWdodH0gPSBtYXRjaC5ncm91cHM7XG4gIHJldHVybiB7XG4gICAgeDogTnVtYmVyLnBhcnNlSW50KHgsIDEwKSxcbiAgICB5OiBOdW1iZXIucGFyc2VJbnQoeSwgMTApLFxuICAgIHdpZHRoOiBOdW1iZXIucGFyc2VJbnQod2lkdGgsIDEwKSxcbiAgICBoZWlnaHQ6IE51bWJlci5wYXJzZUludChoZWlnaHQsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gd2luZG93UHJpb3JpdHkgKG5vZGUgPSB7fSkge1xuICBjb25zdCBzdGF0ZXMgPSBgJHtub2RlLnN0YXRlcyA/PyAnJ31gLnRvVXBwZXJDYXNlKCk7XG4gIGNvbnN0IHRhZyA9IGAke25vZGUudGFnID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3Qgd2luZG93VHlwZSA9IGAke25vZGUud2luZG93VHlwZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHJlY3QgPSBub2RlLnJlY3Q7XG4gIGxldCBzY29yZSA9IDA7XG4gIGlmIChyZWN0ICYmIHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMCkge1xuICAgIHNjb3JlICs9IHJlY3Qud2lkdGggKiByZWN0LmhlaWdodDtcbiAgfVxuICBpZiAodGFnLmluY2x1ZGVzKCdhbGVydCcpIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXMoJ2FsZXJ0JykpIHtcbiAgICBzY29yZSArPSAxMDAwMDAwMDA7XG4gIH0gZWxzZSBpZiAodGFnLmluY2x1ZGVzKCdkaWFsb2cnKSB8fCB3aW5kb3dUeXBlLmluY2x1ZGVzKCdkaWFsb2cnKSB8fCB3aW5kb3dUeXBlLmluY2x1ZGVzKCdtb2RhbCcpKSB7XG4gICAgc2NvcmUgKz0gODAwMDAwMDA7XG4gIH0gZWxzZSBpZiAoXG4gICAgdGFnLmluY2x1ZGVzKCdub3RpZmljYXRpb24nKVxuICAgIHx8IHRhZy5pbmNsdWRlcygncG9wb3ZlcicpXG4gICAgfHwgd2luZG93VHlwZS5pbmNsdWRlcygnbm90aWZpY2F0aW9uJylcbiAgICB8fCB3aW5kb3dUeXBlLmluY2x1ZGVzKCdwb3BvdmVyJylcbiAgICB8fCB3aW5kb3dUeXBlLmluY2x1ZGVzKCdwb3B1cCcpXG4gICkge1xuICAgIHNjb3JlICs9IDYwMDAwMDAwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ0FDVElWRScpKSB7XG4gICAgc2NvcmUgKz0gNTAwMDAwMDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnU0hPV0lORycpIHx8IHN0YXRlcy5pbmNsdWRlcygnVklTSUJMRScpKSB7XG4gICAgc2NvcmUgKz0gMjUwMDAwMDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnRU5BQkxFRCcpIHx8IHN0YXRlcy5pbmNsdWRlcygnU0VOU0lUSVZFJykpIHtcbiAgICBzY29yZSArPSA1MDAwMDAwO1xuICB9XG4gIHJldHVybiBzY29yZTtcbn1cblxuY29tbWFuZHMuZ2V0V2luZG93SGFuZGxlID0gZnVuY3Rpb24gZ2V0V2luZG93SGFuZGxlICgpIHtcbiAgLy8gU2hvcnQtbGl2ZWQgY2FjaGU6IHRoZSBhY3RpdmUgd2luZG93IGRvZXNuJ3QgY2hhbmdlIGJldHdlZW4gcmFwaWQgcG9sbHNcbiAgaWYgKHRoaXMuX3dpbikge1xuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgaWYgKHRoaXMuX3dpbkhhbmRsZVZhbGlkYXRlZEF0ICYmIChub3cgLSB0aGlzLl93aW5IYW5kbGVWYWxpZGF0ZWRBdCkgPCA1MDAwKSB7XG4gICAgICByZXR1cm4gdGhpcy5fd2luLndpZDtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHRoaXMuX3dpbiA9IHRoaXMuX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQodGhpcy5fd2luLndpZCk7XG4gICAgICB0aGlzLl93aW5IYW5kbGVWYWxpZGF0ZWRBdCA9IERhdGUubm93KCk7XG4gICAgICByZXR1cm4gdGhpcy5fd2luPy53aWQ7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aGlzLl93aW5IYW5kbGVWYWxpZGF0ZWRBdCA9IDA7XG4gICAgICByZXR1cm4gdGhpcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3coKT8ud2lkO1xuICAgIH1cbiAgfVxuICByZXR1cm4gdGhpcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3coKT8ud2lkO1xufTtcblxuY29tbWFuZHMuX3Jlc29sdmVCZXN0QXZhaWxhYmxlV2luZG93ID0gZnVuY3Rpb24gX3Jlc29sdmVCZXN0QXZhaWxhYmxlV2luZG93ICgpIHtcbiAgLy8gSW50ZXJuYWwgcmVjb3ZlcnkgcGF0aCDigJQgcmV1c2UgdGhlIHdpbmRvdyBsaXN0IHRoYXQgd2FzIEpVU1QgcmVidWlsdFxuICAvLyBieSB0aGUgY2FsbGVyJ3MgZ2V0V2luZG93SGFuZGxlcygpLiAgRG8gTk9UIGludmFsaWRhdGUgZGVza3RvcCBjYWNoZVxuICAvLyBhZ2FpbiB0byBhdm9pZCBjYXNjYWRpbmcgMi00cyBkZXNrdG9wIHJlYnVpbGRzLlxuICBjb25zdCBoYW5kbGVzID0gdGhpcy5fZ2V0V2luZG93SGFuZGxlc0NvcmUoKTtcbiAgZm9yIChjb25zdCBoYW5kbGUgb2YgaGFuZGxlcykge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB3aW4gPSB0aGlzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbklkKGhhbmRsZSk7XG4gICAgICB0aGlzLl93aW4gPSB3aW47XG4gICAgICByZXR1cm4gd2luO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICB9XG4gIHRoaXMuX3dpbiA9IG51bGw7XG4gIHJldHVybiBudWxsO1xufTtcblxuY29tbWFuZHMuZ2V0V2luZG93SGFuZGxlcyA9IGZ1bmN0aW9uIGdldFdpbmRvd0hhbmRsZXMgKCkge1xuICAvLyBTaG9ydC1jaXJjdWl0OiByZXR1cm4gY2FjaGVkIGhhbmRsZXMgd2hlbiBubyBVSSBhY3Rpb24gaGFzIGhhcHBlbmVkXG4gIC8vIHNpbmNlIHRoZSBsYXN0IHNjYW4uICBUaGlzIGF2b2lkcyByZWR1bmRhbnQgfjItMjhzIG5hdGl2ZSBBVC1TUElcbiAgLy8gZGVza3RvcCByZS1zY2FucyBkdXJpbmcgcmFwaWQgcG9sbGluZyAoZS5nLiBzd2l0Y2hfdG9fbmV3X3dpbmRvdykuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGlmICh0aGlzLl9sYXN0V2luZG93SGFuZGxlc1Jlc3VsdFxuICAgICAgJiYgdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNBdCAmJiAobm93IC0gdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNBdCkgPCAzMDAwXG4gICAgICAmJiAoIXRoaXMuX2xhc3RVaUFjdGlvbkF0IHx8IHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzQXQgPiB0aGlzLl9sYXN0VWlBY3Rpb25BdCkpIHtcbiAgICByZXR1cm4gdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNSZXN1bHQ7XG4gIH1cbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIC8vIEludmFsaWRhdGUgZGVza3RvcCArIHdpbmRvdyBYTUwgY2FjaGVzIHNvIHdlIGFsd2F5cyBkaXNjb3ZlclxuICAvLyBuZXdseS1hcHBlYXJlZCBvciByZWNlbnRseS1jbG9zZWQgd2luZG93cyAoZS5nLiBcIkNvbm5lY3QgSW5zZWN1cmVseVwiKS5cbiAgLy8gVGhpcyBjb3N0cyB+Mi0zcyBmb3IgYSBmcmVzaCBuYXRpdmUgQVQtU1BJIGRlc2t0b3Agc2Nhbi5cbiAgaWYgKHR5cGVvZiBhcGlzLl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgYXBpcy5faW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSgpO1xuICB9XG4gIGlmICh0eXBlb2YgYXBpcy5faW52YWxpZGF0ZVdpbmRvd0hpZXJhcmNoeVhtbENhY2hlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgYXBpcy5faW52YWxpZGF0ZVdpbmRvd0hpZXJhcmNoeVhtbENhY2hlKCk7XG4gIH1cbiAgY29uc3QgcmVzdWx0ID0gdGhpcy5fZ2V0V2luZG93SGFuZGxlc0NvcmUoKTtcbiAgdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNBdCA9IERhdGUubm93KCk7XG4gIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzUmVzdWx0ID0gcmVzdWx0O1xuICByZXR1cm4gcmVzdWx0O1xufTtcblxuLy8gQ29yZSBsb2dpYyBzaGFyZWQgYnkgZ2V0V2luZG93SGFuZGxlcyAoZnJlc2gpIGFuZCBfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cgKGNhY2hlZCkuXG5jb21tYW5kcy5fZ2V0V2luZG93SGFuZGxlc0NvcmUgPSBmdW5jdGlvbiBfZ2V0V2luZG93SGFuZGxlc0NvcmUgKCkge1xuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgY29uc3QgYXBwTmFtZSA9IHRoaXMuYXBwTmFtZTtcbiAgbGV0IHBpZHMgPSBhcGlzLmFwcF9ydW5uaW5nKGFwcE5hbWUpO1xuICAvLyBQcmVzZXJ2ZSB0aGUgZXN0YWJsaXNoZWQgbG9va3VwIGZvciBvcmRpbmFyeSBzZXNzaW9ucy4gRGlyZWN0IGFyZ3VtZW50XG4gIC8vIGxhdW5jaGVzIG1heSByZXRhaW4gYSB3cmFwcGVyIHByb2Nlc3MgYWxvbmdzaWRlIHRoZSBVSSBjaGlsZCwgc28gb25seVxuICAvLyB0aGF0IG9wdC1pbiBwYXRoIG1lcmdlcyBiYXNlbmFtZSBtYXRjaGVzLlxuICBpZiAodGhpcy5hcHBBcmd1bWVudHM/Lmxlbmd0aCA+IDAgfHwgdGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICBjb25zdCBiYXNlbmFtZVBpZHMgPSBhcHBOYW1lID8gKHBncmVwQnlCYXNlbmFtZShhcHBOYW1lKSB8fCBbXSkgOiBbXTtcbiAgICBwaWRzID0gWy4uLm5ldyBTZXQoWy4uLihwaWRzIHx8IFtdKSwgLi4uYmFzZW5hbWVQaWRzXSldO1xuICB9IGVsc2UgaWYgKCghcGlkcyB8fCBwaWRzLmxlbmd0aCA9PT0gMCkgJiYgYXBwTmFtZSkge1xuICAgIHBpZHMgPSBwZ3JlcEJ5QmFzZW5hbWUoYXBwTmFtZSk7XG4gIH1cbiAgaWYgKCFwaWRzIHx8IHBpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgYXBwbGljYXRpb24gJHthcHBOYW1lfSBpcyBub3QgcnVubmluZ2ApO1xuICB9XG4gIGNvbnN0IHdpbkhpZXJhY2h5ID0gYXBpcy5hcHBfZ2V0V2luZG93SGllcmFjaHkoKTtcbiAgY29uc3QgZG9jID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyh3aW5IaWVyYWNoeSk7XG4gIGxldCB4cGF0aCA9IHBpZHMubWFwKChwaWQpID0+IGBAcGlkPVwiJHtwaWR9XCJgKS5qb2luKCcgb3IgJyk7XG4gIHhwYXRoID0gYC8vKlske3hwYXRofSBhbmQgQElucHV0T3V0cHV0PVwidHJ1ZVwiXWA7XG4gIGNvbnN0IG5vZGVzID0gc2VsZWN0KGRvYywgeHBhdGgpO1xuICBpZiAoIW5vZGVzIHx8IG5vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBsZXQgX25vZGVzID0gW107XG4gIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgIGlmICghbm9kZS5hdHRyaWJ1dGVzKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgX25vZGUgPSB7fTtcbiAgICBjb25zdCBhdHRycyA9IEFycmF5LmZyb20obm9kZS5hdHRyaWJ1dGVzKTtcbiAgICBmb3IgKGNvbnN0IGF0dHIgb2YgYXR0cnMpIHtcbiAgICAgIGlmIChhdHRyLm5hbWUgPT09ICdjbGFzcycpIHtcbiAgICAgICAgX25vZGUuY2xhc3MgPSBhdHRyLnZhbHVlLnNwbGl0KCcgJyk7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ25hbWUnKSB7XG4gICAgICAgIF9ub2RlLm5hbWUgPSBhdHRyLnZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICdwaWQnKSB7XG4gICAgICAgIF9ub2RlLnBpZCA9IE51bWJlci5wYXJzZUludChhdHRyLnZhbHVlLCAxMCk7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ3dpZCcpIHtcbiAgICAgICAgX25vZGUud2lkID0gTnVtYmVyLnBhcnNlSW50KGF0dHIudmFsdWUsIDEwKTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAncmVjdCcpIHtcbiAgICAgICAgX25vZGUucmVjdCA9IHBhcnNlUmVjdChhdHRyLnZhbHVlKTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAnc3RhdGVzJykge1xuICAgICAgICBfbm9kZS5zdGF0ZXMgPSBhdHRyLnZhbHVlO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICd0YWcnKSB7XG4gICAgICAgIF9ub2RlLnRhZyA9IGF0dHIudmFsdWU7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ3dpbmRvdy10eXBlJykge1xuICAgICAgICBfbm9kZS53aW5kb3dUeXBlID0gYXR0ci52YWx1ZTtcbiAgICAgIH1cbiAgICB9XG4gICAgX25vZGVzLnB1c2goX25vZGUpO1xuICB9XG4gIF9ub2RlcyA9IF9ub2Rlcy5maWx0ZXIoKHApID0+IHAucGlkICYmIHAud2lkKTtcbiAgaWYgKF9ub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgX25vZGVzID0gX25vZGVzLm1hcCgocCkgPT4ge1xuICAgIGxldCBfbm9kZSA9IHtcbiAgICAgIHBpZDogcC5waWQsXG4gICAgICB3aWQ6IHAud2lkLFxuICAgICAgbmFtZXM6IFtdLFxuICAgICAgcmVjdDogcC5yZWN0IHx8IG51bGwsXG4gICAgICBzdGF0ZXM6IHAuc3RhdGVzIHx8ICcnLFxuICAgICAgdGFnOiBwLnRhZyB8fCAnJyxcbiAgICAgIHdpbmRvd1R5cGU6IHAud2luZG93VHlwZSB8fCAnJyxcbiAgICB9O1xuICAgIGlmIChwLm5hbWUpIHtcbiAgICAgIF9ub2RlLm5hbWVzLnB1c2gocC5uYW1lKTtcbiAgICB9XG4gICAgaWYgKHAuY2xhc3MpIHtcbiAgICAgIF9ub2RlLm5hbWVzLnB1c2goLi4ucC5jbGFzcyk7XG4gICAgfVxuICAgIHJldHVybiBfbm9kZTtcbiAgfSk7XG4gIF9ub2Rlcy5zb3J0KChhLCBiKSA9PiB3aW5kb3dQcmlvcml0eShiKSAtIHdpbmRvd1ByaW9yaXR5KGEpKTtcbiAgaWYgKCFzaG91bGRWZXJpZnlXaW5kb3dJbkExMXkodGhpcykpIHtcbiAgICAvLyBXYXlsYW5kIHVzZXMgc3ludGhldGljIHdpbmRvdyBoYW5kbGVzIGRlcml2ZWQgZnJvbSB0aGUgY3VycmVudCBBVC1TUEkgdHJlZS5cbiAgICAvLyBBdm9pZCBibG9ja2luZyBuYXRpdmUgYTExeSBsb29rdXBzIHdoaWxlIHdpbmRvd3MgYXJlIHN0aWxsIHNldHRsaW5nLlxuICAgIHJldHVybiBbLi4ubmV3IFNldChfbm9kZXMubWFwKChub2RlKSA9PiBub2RlLndpZCkpXTtcbiAgfVxuICBjb25zdCB3aWRzID0gW107XG4gIGZvciAoY29uc3QgX25vZGUgb2YgX25vZGVzKSB7XG4gICAgbGV0IG9rID0gZmFsc2U7XG4gICAgZm9yIChjb25zdCBuYW1lIG9mIF9ub2RlLm5hbWVzKSB7XG4gICAgICBpZiAoYXBpcy5hMTF5X2NoZWNrV2luZG93RXhpc3RzKG5hbWUsIF9ub2RlLnBpZCkpIHtcbiAgICAgICAgb2sgPSB0cnVlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gICAgaWYgKG9rKSB7XG4gICAgICB3aWRzLnB1c2goX25vZGUud2lkKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIHdpZHM7XG59O1xuXG5jb21tYW5kcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5OYW1lID0gZnVuY3Rpb24gKHdpbmRvd05hbWUpIHtcbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIGxldCBwaWRzID0gYXBpcy5hcHBfcnVubmluZyh0aGlzLmFwcE5hbWUpO1xuICBpZiAodGhpcy5hcHBBcmd1bWVudHM/Lmxlbmd0aCA+IDAgfHwgdGhpcy5hdHRhY2hUb1J1bm5pbmdBcHApIHtcbiAgICBjb25zdCBiYXNlbmFtZVBpZHMgPSB0aGlzLmFwcE5hbWUgPyAocGdyZXBCeUJhc2VuYW1lKHRoaXMuYXBwTmFtZSkgfHwgW10pIDogW107XG4gICAgcGlkcyA9IFsuLi5uZXcgU2V0KFsuLi4ocGlkcyB8fCBbXSksIC4uLmJhc2VuYW1lUGlkc10pXTtcbiAgfVxuICBpZiAoIXBpZHMgfHwgcGlkcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGBhcHBsaWNhdGlvbiAke3RoaXMuYXBwTmFtZX0gaXMgbm90IHJ1bm5pbmdgKTtcbiAgfVxuICBjb25zdCB3aW5IaWVyYWNoeSA9IGFwaXMuYXBwX2dldFdpbmRvd0hpZXJhY2h5KCk7XG4gIGNvbnN0IGRvYyA9IG5ldyBkb20oKS5wYXJzZUZyb21TdHJpbmcod2luSGllcmFjaHkpO1xuICBsZXQgeHBhdGggPSBwaWRzLm1hcCgocGlkKSA9PiBgQHBpZD1cIiR7cGlkfVwiYCkuam9pbignIG9yICcpO1xuICB4cGF0aCA9IGAvLypbKCR7eHBhdGh9KSBhbmQgQElucHV0T3V0cHV0PVwidHJ1ZVwiIGFuZCAoQG5hbWU9XCIke3dpbmRvd05hbWV9XCIgb3IgY29udGFpbnMoY29uY2F0KFwiIFwiLCBAY2xhc3MsIFwiIFwiKSwgXCIkeycgJyArIHdpbmRvd05hbWUgKyAnICd9XCIpKV1gO1xuICBjb25zdCBub2RlcyA9IHNlbGVjdChkb2MsIHhwYXRoKTtcbiAgaWYgKCFub2RlcyB8fCBub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93ICR7d2luZG93TmFtZX0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgbGV0IF9ub2RlcyA9IFtdO1xuICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICBpZiAoIW5vZGUuYXR0cmlidXRlcykge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGF0dHJzID0gQXJyYXkuZnJvbShub2RlLmF0dHJpYnV0ZXMpO1xuICAgIGNvbnN0IF9ub2RlID0ge307XG4gICAgZm9yIChjb25zdCBhdHRyIG9mIGF0dHJzKSB7XG4gICAgICBfbm9kZVthdHRyLm5hbWVdID0gYXR0ci52YWx1ZTtcbiAgICB9XG4gICAgX25vZGVzLnB1c2goX25vZGUpO1xuICB9XG4gIF9ub2RlcyA9IF9ub2Rlcy5maWx0ZXIoKHApID0+IChwLm5hbWUgfHwgcC5jbGFzcykgJiYgcC5waWQgJiYgcC53aWQpO1xuICBpZiAoX25vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHRoZSB3aW5kb3cgJHt3aW5kb3dOYW1lfSBkb2Vzbid0IHByZXNlbnRgKTtcbiAgfVxuICBfbm9kZXMgPSBfbm9kZXMubWFwKChwKSA9PiAoe1xuICAgIC4uLnAsXG4gICAgcGlkOiBOdW1iZXIucGFyc2VJbnQocC5waWQsIDEwKSxcbiAgICB3aWQ6IE51bWJlci5wYXJzZUludChwLndpZCwgMTApLFxuICAgIHJlY3Q6IHBhcnNlUmVjdChwLnJlY3QpLFxuICAgIHN0YXRlczogcC5zdGF0ZXMgfHwgJycsXG4gICAgdGFnOiBwLnRhZyB8fCAnJyxcbiAgICB3aW5kb3dUeXBlOiBwWyd3aW5kb3ctdHlwZSddIHx8IHAud2luZG93VHlwZSB8fCAnJyxcbiAgfSkpO1xuICBfbm9kZXMuc29ydCgoYSwgYikgPT4ge1xuICAgIGNvbnN0IGF2ID0gYS5uYW1lID09PSB3aW5kb3dOYW1lID8gLTEgOiAxO1xuICAgIGNvbnN0IGJ2ID0gYi5uYW1lID09PSB3aW5kb3dOYW1lID8gLTEgOiAxO1xuICAgIHJldHVybiBhdiAtIGJ2IHx8IHdpbmRvd1ByaW9yaXR5KGIpIC0gd2luZG93UHJpb3JpdHkoYSk7XG4gIH0pO1xuICBpZiAoIXNob3VsZFZlcmlmeVdpbmRvd0luQTExeSh0aGlzKSkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IF9ub2Rlc1swXTtcbiAgICByZXR1cm4ge1xuICAgICAgcGlkOiBjYW5kaWRhdGUucGlkLFxuICAgICAgd2lkOiBjYW5kaWRhdGUud2lkLFxuICAgICAgbmFtZTogY2FuZGlkYXRlLm5hbWUgfHwgd2luZG93TmFtZSxcbiAgICAgIHJlY3Q6IGNhbmRpZGF0ZS5yZWN0IHx8IG51bGwsXG4gICAgICBzdGF0ZXM6IGNhbmRpZGF0ZS5zdGF0ZXMgfHwgJycsXG4gICAgICB0YWc6IGNhbmRpZGF0ZS50YWcgfHwgJycsXG4gICAgICB3aW5kb3dUeXBlOiBjYW5kaWRhdGUud2luZG93VHlwZSB8fCAnJyxcbiAgICB9O1xuICB9XG4gIGZvciAoY29uc3QgX25vZGUgb2YgX25vZGVzKSB7XG4gICAgY29uc3QgX3BpZCA9IF9ub2RlLnBpZDtcbiAgICBpZiAoYXBpcy5hMTF5X2NoZWNrV2luZG93RXhpc3RzKHdpbmRvd05hbWUsIF9waWQpKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBwaWQ6IF9waWQsXG4gICAgICAgIHdpZDogX25vZGUud2lkLFxuICAgICAgICBuYW1lOiB3aW5kb3dOYW1lLFxuICAgICAgICByZWN0OiBfbm9kZS5yZWN0IHx8IG51bGwsXG4gICAgICAgIHN0YXRlczogX25vZGUuc3RhdGVzIHx8ICcnLFxuICAgICAgICB0YWc6IF9ub2RlLnRhZyB8fCAnJyxcbiAgICAgICAgd2luZG93VHlwZTogX25vZGUud2luZG93VHlwZSB8fCAnJyxcbiAgICAgIH07XG4gICAgfVxuICB9XG4gIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHRoZSB3aW5kb3cgJHt3aW5kb3dOYW1lfSBkb2Vzbid0IHByZXNlbnRgKTtcbn07XG5cbmNvbW1hbmRzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbklkID0gZnVuY3Rpb24gKHdpZCkge1xuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgY29uc3Qgd2luSGllcmFjaHkgPSBhcGlzLmFwcF9nZXRXaW5kb3dIaWVyYWNoeSgpO1xuICBjb25zdCBkb2MgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKHdpbkhpZXJhY2h5KTtcbiAgY29uc3QgeHBhdGggPSBgLy8qW0B3aWQ9XCIke3dpZH1cIiBhbmQgQElucHV0T3V0cHV0PVwidHJ1ZVwiXWA7XG4gIGNvbnN0IG5vZGVzID0gc2VsZWN0KGRvYywgeHBhdGgpO1xuICBpZiAoIW5vZGVzIHx8IG5vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHRoZSB3aW5kb3cgd2lkPSR7d2lkfSBkb2Vzbid0IHByZXNlbnRgKTtcbiAgfVxuICBsZXQgX25vZGVzID0gW107XG4gIGZvciAoY29uc3QgY3VycmVudE5vZGUgb2Ygbm9kZXMpIHtcbiAgICBjb25zdCBhdHRycyA9IEFycmF5LmZyb20oY3VycmVudE5vZGUuYXR0cmlidXRlcyk7XG4gICAgY29uc3QgX25vZGUgPSB7fTtcbiAgICBmb3IgKGNvbnN0IGF0dHIgb2YgYXR0cnMpIHtcbiAgICAgIF9ub2RlW2F0dHIubmFtZV0gPSBhdHRyLnZhbHVlO1xuICAgIH1cbiAgICBfbm9kZXMucHVzaChfbm9kZSk7XG4gIH1cbiAgX25vZGVzID0gX25vZGVzLm1hcCgocCkgPT4gKHtcbiAgICAuLi5wLFxuICAgIHBpZDogTnVtYmVyLnBhcnNlSW50KHAucGlkLCAxMCksXG4gICAgd2lkOiBOdW1iZXIucGFyc2VJbnQocC53aWQsIDEwKSxcbiAgICByZWN0OiBwYXJzZVJlY3QocC5yZWN0KSxcbiAgICBzdGF0ZXM6IHAuc3RhdGVzIHx8ICcnLFxuICAgIHRhZzogcC50YWcgfHwgJycsXG4gICAgd2luZG93VHlwZTogcFsnd2luZG93LXR5cGUnXSB8fCBwLndpbmRvd1R5cGUgfHwgJycsXG4gIH0pKS5maWx0ZXIoKHApID0+IHAucGlkICYmIHAud2lkKTtcbiAgaWYgKF9ub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93IHdpZD0ke3dpZH0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgX25vZGVzLnNvcnQoKGEsIGIpID0+IHdpbmRvd1ByaW9yaXR5KGIpIC0gd2luZG93UHJpb3JpdHkoYSkpO1xuICBjb25zdCBub2RlID0gX25vZGVzWzBdO1xuICBpZiAoIW5vZGUucGlkIHx8ICFub2RlLndpZCkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHRoZSB3aW5kb3cgd2lkPSR7d2lkfSBkb2Vzbid0IHByZXNlbnRgKTtcbiAgfVxuICBpZiAoIXNob3VsZFZlcmlmeVdpbmRvd0luQTExeSh0aGlzKSkge1xuICAgIHJldHVybiB7XG4gICAgICBwaWQ6IG5vZGUucGlkLFxuICAgICAgd2lkOiBub2RlLndpZCxcbiAgICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICAgIHJlY3Q6IG5vZGUucmVjdCB8fCBudWxsLFxuICAgICAgc3RhdGVzOiBub2RlLnN0YXRlcyB8fCAnJyxcbiAgICAgIHRhZzogbm9kZS50YWcgfHwgJycsXG4gICAgICB3aW5kb3dUeXBlOiBub2RlLndpbmRvd1R5cGUgfHwgJycsXG4gICAgfTtcbiAgfVxuICBpZiAobm9kZS5uYW1lICYmICFhcGlzLmExMXlfY2hlY2tXaW5kb3dFeGlzdHMobm9kZS5uYW1lLCBub2RlLnBpZCkpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93IHdpZD0ke3dpZH0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBwaWQ6IG5vZGUucGlkLFxuICAgIHdpZDogbm9kZS53aWQsXG4gICAgbmFtZTogbm9kZS5uYW1lLFxuICAgIHJlY3Q6IG5vZGUucmVjdCB8fCBudWxsLFxuICAgIHN0YXRlczogbm9kZS5zdGF0ZXMgfHwgJycsXG4gICAgdGFnOiBub2RlLnRhZyB8fCAnJyxcbiAgICB3aW5kb3dUeXBlOiBub2RlLndpbmRvd1R5cGUgfHwgJycsXG4gIH07XG59O1xuXG5mdW5jdGlvbiB2YWxpZGF0ZU5hbWUgKG5hbWUpIHtcbiAgaWYgKCFuYW1lKSB7XG4gICAgcmV0dXJuIG5hbWU7XG4gIH1cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBuYW1lLmxlbmd0aDsgKytpKSB7XG4gICAgaWYgKG5hbWVbaV0gPCAnMCcgfHwgbmFtZVtpXSA+ICc5Jykge1xuICAgICAgcmV0dXJuIG5hbWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiB2YWxpZGF0ZUhhbmRsZSAoaGFuZGxlKSB7XG4gIGlmICghaGFuZGxlKSB7XG4gICAgcmV0dXJuIGhhbmRsZTtcbiAgfVxuICBmb3IgKGxldCBpID0gMDsgaSA8IGhhbmRsZS5sZW5ndGg7ICsraSkge1xuICAgIGlmIChoYW5kbGVbaV0gPCAnMCcgfHwgaGFuZGxlW2ldID4gJzknKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGhhbmRsZTtcbn1cblxuY29tbWFuZHMuc2V0V2luZG93ID0gZnVuY3Rpb24gc2V0V2luZG93IChuYW1lLCBoYW5kbGUpIHtcbiAgaGFuZGxlID0gdmFsaWRhdGVIYW5kbGUoaGFuZGxlKTtcbiAgbmFtZSA9IHZhbGlkYXRlTmFtZShuYW1lKTtcbiAgaWYgKG5hbWUpIHtcbiAgICBjb25zdCB3aW4gPSB0aGlzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbk5hbWUobmFtZSk7XG4gICAgdGhpcy5fd2luID0gd2luO1xuICB9IGVsc2UgaWYgKGhhbmRsZSkge1xuICAgIGNvbnN0IHdpbiA9IHRoaXMuX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQoaGFuZGxlKTtcbiAgICB0aGlzLl93aW4gPSB3aW47XG4gIH0gZWxzZSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoXCJzZXRXaW5kb3cgYm90aCBuYW1lIGFuZCBoYW5kbGUgZG9uJ3QgaGF2ZSBhIHZhbHVlXCIpO1xuICB9XG4gIHRoaXMuX2xhc3RDYWNoZUNsZWFyQXQgPSAwO1xuICB0aGlzLl93aW5WYWxpZGF0ZWRBdCA9IDA7XG4gIHRoaXMuX3dpbkhhbmRsZVZhbGlkYXRlZEF0ID0gMDtcbiAgdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNBdCA9IDA7XG59O1xuXG5jb21tYW5kcy5nZXRXaW5kb3dSZWN0ID0gZnVuY3Rpb24gZ2V0V2luZG93UmVjdCAoKSB7XG4gIGNvbnN0IGFwaXMgPSBnZXRBcGlzKHRoaXMpO1xuICBjb25zdCB3aW4gPSB0aGlzLl93aW47XG4gIGlmICghd2luKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgd2luZG93IGlzIG5vdCBzcGVjaWZpZWRgKTtcbiAgfVxuICBjb25zdCB7d2lkfSA9IHdpbjtcbiAgcmV0dXJuIGFwaXMuYXBwX2dldFdpblJlY3Qod2lkKTtcbn07XG5cbmV4cG9ydCBkZWZhdWx0IGNvbW1hbmRzO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBLElBQUFBLE1BQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLE9BQUEsR0FBQUQsT0FBQTtBQUNBLElBQUFFLFdBQUEsR0FBQUYsT0FBQTtBQUNBLElBQUFHLGNBQUEsR0FBQUgsT0FBQTtBQUtBLElBQUlJLFdBQVcsR0FBRztFQUFDQyxJQUFJLEVBQUUsSUFBSTtFQUFFQyxPQUFPLEVBQUUsSUFBSTtFQUFFQyxFQUFFLEVBQUU7QUFBQyxDQUFDO0FBQ3BELE1BQU1DLGtCQUFrQixHQUFHLElBQUk7QUFFL0IsU0FBU0MsZUFBZUEsQ0FBRUgsT0FBTyxFQUFFO0VBQ2pDLE1BQU1JLEdBQUcsR0FBR0MsSUFBSSxDQUFDRCxHQUFHLENBQUMsQ0FBQztFQUN0QixJQUFJTixXQUFXLENBQUNFLE9BQU8sS0FBS0EsT0FBTyxJQUFJRixXQUFXLENBQUNDLElBQUksSUFBS0ssR0FBRyxHQUFHTixXQUFXLENBQUNHLEVBQUUsR0FBSUMsa0JBQWtCLEVBQUU7SUFDdEcsT0FBT0osV0FBVyxDQUFDQyxJQUFJO0VBQ3pCO0VBQ0EsSUFBSUEsSUFBSSxHQUFHLElBQUk7RUFDZixJQUFJO0lBQ0YsTUFBTU8sUUFBUSxHQUFHLENBQUNOLE9BQU8sSUFBSSxFQUFFLEVBQUVPLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQ0MsR0FBRyxDQUFDLENBQUM7SUFDakQsSUFBSUYsUUFBUSxFQUFFO01BQ1osTUFBTUcsR0FBRyxHQUFHLElBQUFDLHdCQUFTLEVBQUMsT0FBTyxFQUFFLENBQUMsSUFBSSxFQUFFSixRQUFRLENBQUMsRUFBRTtR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
