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
  const apis = getApis(this);
  const appName = this.appName;
  let pids = apis.app_running(appName);
  if ((!pids || pids.length === 0) && appName) {
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
  const apis = getApis(this);
  const pids = apis.app_running(this.appName);
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2NvbW1hbmRzL3dpbmRvdy5qcyIsIm5hbWVzIjpbIl94cGF0aCIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3htbGRvbSIsIl9iYXNlRHJpdmVyIiwiX2NoaWxkX3Byb2Nlc3MiLCJfcGdyZXBDYWNoZSIsInBpZHMiLCJhcHBOYW1lIiwidHMiLCJQR1JFUF9DQUNIRV9UVExfTVMiLCJwZ3JlcEJ5QmFzZW5hbWUiLCJub3ciLCJEYXRlIiwiYmFzZU5hbWUiLCJzcGxpdCIsInBvcCIsInJlcyIsInNwYXduU3luYyIsImVuY29kaW5nIiwidGltZW91dCIsInN0YXR1cyIsInN0ZG91dCIsInRyaW0iLCJtYXAiLCJOdW1iZXIiLCJmaWx0ZXIiLCJpc0Zpbml0ZSIsImxlbmd0aCIsImNvbW1hbmRzIiwiZ2V0QXBpcyIsImN0eCIsIl9iYWNrZW5kQXBpcyIsImVycm9ycyIsIlVua25vd25FcnJvciIsInNob3VsZFZlcmlmeVdpbmRvd0luQTExeSIsImxpbnV4QmFja2VuZCIsInBhcnNlUmVjdCIsInJlY3QiLCJtYXRjaCIsImV4ZWMiLCJ4IiwieSIsIndpZHRoIiwiaGVpZ2h0IiwiZ3JvdXBzIiwicGFyc2VJbnQiLCJ3aW5kb3dQcmlvcml0eSIsIm5vZGUiLCJfbm9kZSRzdGF0ZXMiLCJfbm9kZSR0YWciLCJfbm9kZSR3aW5kb3dUeXBlIiwic3RhdGVzIiwidG9VcHBlckNhc2UiLCJ0YWciLCJ0b0xvd2VyQ2FzZSIsIndpbmRvd1R5cGUiLCJzY29yZSIsImluY2x1ZGVzIiwiZ2V0V2luZG93SGFuZGxlIiwiX3RoaXMkX3Jlc29sdmVCZXN0QXZhMiIsIl93aW4iLCJfd2luSGFuZGxlVmFsaWRhdGVkQXQiLCJ3aWQiLCJfdGhpcyRfd2luIiwiX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQiLCJfdGhpcyRfcmVzb2x2ZUJlc3RBdmEiLCJfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3ciLCJoYW5kbGVzIiwiX2dldFdpbmRvd0hhbmRsZXNDb3JlIiwiaGFuZGxlIiwid2luIiwiZ2V0V2luZG93SGFuZGxlcyIsIl9sYXN0V2luZG93SGFuZGxlc1Jlc3VsdCIsIl9sYXN0V2luZG93SGFuZGxlc0F0IiwiX2xhc3RVaUFjdGlvbkF0IiwiYXBpcyIsIl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlIiwiX2ludmFsaWRhdGVXaW5kb3dIaWVyYXJjaHlYbWxDYWNoZSIsInJlc3VsdCIsImFwcF9ydW5uaW5nIiwiTm9TdWNoV2luZG93RXJyb3IiLCJ3aW5IaWVyYWNoeSIsImFwcF9nZXRXaW5kb3dIaWVyYWNoeSIsImRvYyIsImRvbSIsInBhcnNlRnJvbVN0cmluZyIsInhwYXRoIiwicGlkIiwiam9pbiIsIm5vZGVzIiwic2VsZWN0IiwiX25vZGVzIiwiYXR0cmlidXRlcyIsIl9ub2RlIiwiYXR0cnMiLCJBcnJheSIsImZyb20iLCJhdHRyIiwibmFtZSIsImNsYXNzIiwidmFsdWUiLCJwdXNoIiwicCIsIm5hbWVzIiwic29ydCIsImEiLCJiIiwiU2V0Iiwid2lkcyIsIm9rIiwiYTExeV9jaGVja1dpbmRvd0V4aXN0cyIsIl9nZXRXaW5BbmRQaWRfRnJvbVdpbk5hbWUiLCJ3aW5kb3dOYW1lIiwiYXYiLCJidiIsImNhbmRpZGF0ZSIsIl9waWQiLCJjdXJyZW50Tm9kZSIsInZhbGlkYXRlTmFtZSIsImkiLCJ2YWxpZGF0ZUhhbmRsZSIsInNldFdpbmRvdyIsIl9sYXN0Q2FjaGVDbGVhckF0IiwiX3dpblZhbGlkYXRlZEF0IiwiZ2V0V2luZG93UmVjdCIsImFwcF9nZXRXaW5SZWN0IiwiX2RlZmF1bHQiLCJleHBvcnRzIiwiZGVmYXVsdCJdLCJzb3VyY2VSb290IjoiLi4vLi4vLi4iLCJzb3VyY2VzIjpbImxpYi9jb21tYW5kcy93aW5kb3cuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHNlbGVjdCBmcm9tICd4cGF0aC5qcyc7XG5pbXBvcnQgeyBET01QYXJzZXIgYXMgZG9tIH0gZnJvbSAneG1sZG9tJztcbmltcG9ydCB7IGVycm9ycyB9IGZyb20gJ0BhcHBpdW0vYmFzZS1kcml2ZXInO1xuaW1wb3J0IHsgc3Bhd25TeW5jIH0gZnJvbSAnY2hpbGRfcHJvY2Vzcyc7XG5cbi8vIFNob3J0LWxpdmVkIGNhY2hlIGZvciBwZ3JlcC1ieS1iYXNlbmFtZSByZXN1bHRzLiAgU3Bhd25pbmcgcGdyZXAgb24gZXZlcnlcbi8vIGdldFdpbmRvd0hhbmRsZXMgLyBnZXRXaW5kb3cgY2FsbCBhZGRzIH41MDAgbXMgcGVyIGNhbGwuICBDYWNoaW5nIHRoZSByZXN1bHRcbi8vIGZvciAzIHNlY29uZHMgYXZvaWRzIHJlZHVuZGFudCBwcm9jZXNzIHNwYXducyBkdXJpbmcgcmFwaWQgcG9sbGluZy5cbmxldCBfcGdyZXBDYWNoZSA9IHtwaWRzOiBudWxsLCBhcHBOYW1lOiBudWxsLCB0czogMH07XG5jb25zdCBQR1JFUF9DQUNIRV9UVExfTVMgPSAzMDAwO1xuXG5mdW5jdGlvbiBwZ3JlcEJ5QmFzZW5hbWUgKGFwcE5hbWUpIHtcbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgaWYgKF9wZ3JlcENhY2hlLmFwcE5hbWUgPT09IGFwcE5hbWUgJiYgX3BncmVwQ2FjaGUucGlkcyAmJiAobm93IC0gX3BncmVwQ2FjaGUudHMpIDwgUEdSRVBfQ0FDSEVfVFRMX01TKSB7XG4gICAgcmV0dXJuIF9wZ3JlcENhY2hlLnBpZHM7XG4gIH1cbiAgbGV0IHBpZHMgPSBudWxsO1xuICB0cnkge1xuICAgIGNvbnN0IGJhc2VOYW1lID0gKGFwcE5hbWUgfHwgJycpLnNwbGl0KCcvJykucG9wKCk7XG4gICAgaWYgKGJhc2VOYW1lKSB7XG4gICAgICBjb25zdCByZXMgPSBzcGF3blN5bmMoJ3BncmVwJywgWyctZicsIGJhc2VOYW1lXSwge2VuY29kaW5nOiAndXRmOCcsIHRpbWVvdXQ6IDMwMDB9KTtcbiAgICAgIGlmIChyZXMuc3RhdHVzID09PSAwICYmIHJlcy5zdGRvdXQpIHtcbiAgICAgICAgcGlkcyA9IHJlcy5zdGRvdXQudHJpbSgpLnNwbGl0KC9cXHMrLykubWFwKE51bWJlcikuZmlsdGVyKE51bWJlci5pc0Zpbml0ZSk7XG4gICAgICB9XG4gICAgfVxuICB9IGNhdGNoIHsgLyogaWdub3JlICovIH1cbiAgaWYgKHBpZHMgJiYgcGlkcy5sZW5ndGggPiAwKSB7XG4gICAgX3BncmVwQ2FjaGUgPSB7cGlkcywgYXBwTmFtZSwgdHM6IG5vd307XG4gIH1cbiAgcmV0dXJuIHBpZHM7XG59XG5cbmNvbnN0IGNvbW1hbmRzID0ge307XG5mdW5jdGlvbiBnZXRBcGlzIChjdHgpIHtcbiAgaWYgKCFjdHg/Ll9iYWNrZW5kQXBpcykge1xuICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKCdMaW51eCBiYWNrZW5kIGlzIG5vdCBpbml0aWFsaXplZCcpO1xuICB9XG4gIHJldHVybiBjdHguX2JhY2tlbmRBcGlzO1xufVxuXG5mdW5jdGlvbiBzaG91bGRWZXJpZnlXaW5kb3dJbkExMXkgKGN0eCkge1xuICByZXR1cm4gY3R4Py5saW51eEJhY2tlbmQgIT09ICd3YXlsYW5kJztcbn1cblxuZnVuY3Rpb24gcGFyc2VSZWN0IChyZWN0KSB7XG4gIGNvbnN0IG1hdGNoID0gL15cXFsoPzx4Pi0/XFxkKyksKD88eT4tP1xcZCspLCg/PHdpZHRoPlxcZCspLCg/PGhlaWdodD5cXGQrKVxcXSQvLmV4ZWMoYCR7cmVjdCA/PyAnJ31gKTtcbiAgaWYgKCFtYXRjaCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IHt4LCB5LCB3aWR0aCwgaGVpZ2h0fSA9IG1hdGNoLmdyb3VwcztcbiAgcmV0dXJuIHtcbiAgICB4OiBOdW1iZXIucGFyc2VJbnQoeCwgMTApLFxuICAgIHk6IE51bWJlci5wYXJzZUludCh5LCAxMCksXG4gICAgd2lkdGg6IE51bWJlci5wYXJzZUludCh3aWR0aCwgMTApLFxuICAgIGhlaWdodDogTnVtYmVyLnBhcnNlSW50KGhlaWdodCwgMTApLFxuICB9O1xufVxuXG5mdW5jdGlvbiB3aW5kb3dQcmlvcml0eSAobm9kZSA9IHt9KSB7XG4gIGNvbnN0IHN0YXRlcyA9IGAke25vZGUuc3RhdGVzID8/ICcnfWAudG9VcHBlckNhc2UoKTtcbiAgY29uc3QgdGFnID0gYCR7bm9kZS50YWcgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCB3aW5kb3dUeXBlID0gYCR7bm9kZS53aW5kb3dUeXBlID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3QgcmVjdCA9IG5vZGUucmVjdDtcbiAgbGV0IHNjb3JlID0gMDtcbiAgaWYgKHJlY3QgJiYgcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwKSB7XG4gICAgc2NvcmUgKz0gcmVjdC53aWR0aCAqIHJlY3QuaGVpZ2h0O1xuICB9XG4gIGlmICh0YWcuaW5jbHVkZXMoJ2FsZXJ0JykgfHwgd2luZG93VHlwZS5pbmNsdWRlcygnYWxlcnQnKSkge1xuICAgIHNjb3JlICs9IDEwMDAwMDAwMDtcbiAgfSBlbHNlIGlmICh0YWcuaW5jbHVkZXMoJ2RpYWxvZycpIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXMoJ2RpYWxvZycpIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXMoJ21vZGFsJykpIHtcbiAgICBzY29yZSArPSA4MDAwMDAwMDtcbiAgfSBlbHNlIGlmIChcbiAgICB0YWcuaW5jbHVkZXMoJ25vdGlmaWNhdGlvbicpXG4gICAgfHwgdGFnLmluY2x1ZGVzKCdwb3BvdmVyJylcbiAgICB8fCB3aW5kb3dUeXBlLmluY2x1ZGVzKCdub3RpZmljYXRpb24nKVxuICAgIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXMoJ3BvcG92ZXInKVxuICAgIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXMoJ3BvcHVwJylcbiAgKSB7XG4gICAgc2NvcmUgKz0gNjAwMDAwMDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnQUNUSVZFJykpIHtcbiAgICBzY29yZSArPSA1MDAwMDAwMDtcbiAgfVxuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdTSE9XSU5HJykgfHwgc3RhdGVzLmluY2x1ZGVzKCdWSVNJQkxFJykpIHtcbiAgICBzY29yZSArPSAyNTAwMDAwMDtcbiAgfVxuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdFTkFCTEVEJykgfHwgc3RhdGVzLmluY2x1ZGVzKCdTRU5TSVRJVkUnKSkge1xuICAgIHNjb3JlICs9IDUwMDAwMDA7XG4gIH1cbiAgcmV0dXJuIHNjb3JlO1xufVxuXG5jb21tYW5kcy5nZXRXaW5kb3dIYW5kbGUgPSBmdW5jdGlvbiBnZXRXaW5kb3dIYW5kbGUgKCkge1xuICAvLyBTaG9ydC1saXZlZCBjYWNoZTogdGhlIGFjdGl2ZSB3aW5kb3cgZG9lc24ndCBjaGFuZ2UgYmV0d2VlbiByYXBpZCBwb2xsc1xuICBpZiAodGhpcy5fd2luKSB7XG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBpZiAodGhpcy5fd2luSGFuZGxlVmFsaWRhdGVkQXQgJiYgKG5vdyAtIHRoaXMuX3dpbkhhbmRsZVZhbGlkYXRlZEF0KSA8IDUwMDApIHtcbiAgICAgIHJldHVybiB0aGlzLl93aW4ud2lkO1xuICAgIH1cbiAgICB0cnkge1xuICAgICAgdGhpcy5fd2luID0gdGhpcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5JZCh0aGlzLl93aW4ud2lkKTtcbiAgICAgIHRoaXMuX3dpbkhhbmRsZVZhbGlkYXRlZEF0ID0gRGF0ZS5ub3coKTtcbiAgICAgIHJldHVybiB0aGlzLl93aW4/LndpZDtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHRoaXMuX3dpbkhhbmRsZVZhbGlkYXRlZEF0ID0gMDtcbiAgICAgIHJldHVybiB0aGlzLl9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdygpPy53aWQ7XG4gICAgfVxuICB9XG4gIHJldHVybiB0aGlzLl9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdygpPy53aWQ7XG59O1xuXG5jb21tYW5kcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cgPSBmdW5jdGlvbiBfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cgKCkge1xuICAvLyBJbnRlcm5hbCByZWNvdmVyeSBwYXRoIOKAlCByZXVzZSB0aGUgd2luZG93IGxpc3QgdGhhdCB3YXMgSlVTVCByZWJ1aWx0XG4gIC8vIGJ5IHRoZSBjYWxsZXIncyBnZXRXaW5kb3dIYW5kbGVzKCkuICBEbyBOT1QgaW52YWxpZGF0ZSBkZXNrdG9wIGNhY2hlXG4gIC8vIGFnYWluIHRvIGF2b2lkIGNhc2NhZGluZyAyLTRzIGRlc2t0b3AgcmVidWlsZHMuXG4gIGNvbnN0IGhhbmRsZXMgPSB0aGlzLl9nZXRXaW5kb3dIYW5kbGVzQ29yZSgpO1xuICBmb3IgKGNvbnN0IGhhbmRsZSBvZiBoYW5kbGVzKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHdpbiA9IHRoaXMuX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQoaGFuZGxlKTtcbiAgICAgIHRoaXMuX3dpbiA9IHdpbjtcbiAgICAgIHJldHVybiB3aW47XG4gICAgfSBjYXRjaCB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gIH1cbiAgdGhpcy5fd2luID0gbnVsbDtcbiAgcmV0dXJuIG51bGw7XG59O1xuXG5jb21tYW5kcy5nZXRXaW5kb3dIYW5kbGVzID0gZnVuY3Rpb24gZ2V0V2luZG93SGFuZGxlcyAoKSB7XG4gIC8vIFNob3J0LWNpcmN1aXQ6IHJldHVybiBjYWNoZWQgaGFuZGxlcyB3aGVuIG5vIFVJIGFjdGlvbiBoYXMgaGFwcGVuZWRcbiAgLy8gc2luY2UgdGhlIGxhc3Qgc2Nhbi4gIFRoaXMgYXZvaWRzIHJlZHVuZGFudCB+Mi0yOHMgbmF0aXZlIEFULVNQSVxuICAvLyBkZXNrdG9wIHJlLXNjYW5zIGR1cmluZyByYXBpZCBwb2xsaW5nIChlLmcuIHN3aXRjaF90b19uZXdfd2luZG93KS5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgaWYgKHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzUmVzdWx0XG4gICAgICAmJiB0aGlzLl9sYXN0V2luZG93SGFuZGxlc0F0ICYmIChub3cgLSB0aGlzLl9sYXN0V2luZG93SGFuZGxlc0F0KSA8IDMwMDBcbiAgICAgICYmICghdGhpcy5fbGFzdFVpQWN0aW9uQXQgfHwgdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNBdCA+IHRoaXMuX2xhc3RVaUFjdGlvbkF0KSkge1xuICAgIHJldHVybiB0aGlzLl9sYXN0V2luZG93SGFuZGxlc1Jlc3VsdDtcbiAgfVxuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgLy8gSW52YWxpZGF0ZSBkZXNrdG9wICsgd2luZG93IFhNTCBjYWNoZXMgc28gd2UgYWx3YXlzIGRpc2NvdmVyXG4gIC8vIG5ld2x5LWFwcGVhcmVkIG9yIHJlY2VudGx5LWNsb3NlZCB3aW5kb3dzIChlLmcuIFwiQ29ubmVjdCBJbnNlY3VyZWx5XCIpLlxuICAvLyBUaGlzIGNvc3RzIH4yLTNzIGZvciBhIGZyZXNoIG5hdGl2ZSBBVC1TUEkgZGVza3RvcCBzY2FuLlxuICBpZiAodHlwZW9mIGFwaXMuX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICBhcGlzLl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlKCk7XG4gIH1cbiAgaWYgKHR5cGVvZiBhcGlzLl9pbnZhbGlkYXRlV2luZG93SGllcmFyY2h5WG1sQ2FjaGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICBhcGlzLl9pbnZhbGlkYXRlV2luZG93SGllcmFyY2h5WG1sQ2FjaGUoKTtcbiAgfVxuICBjb25zdCByZXN1bHQgPSB0aGlzLl9nZXRXaW5kb3dIYW5kbGVzQ29yZSgpO1xuICB0aGlzLl9sYXN0V2luZG93SGFuZGxlc0F0ID0gRGF0ZS5ub3coKTtcbiAgdGhpcy5fbGFzdFdpbmRvd0hhbmRsZXNSZXN1bHQgPSByZXN1bHQ7XG4gIHJldHVybiByZXN1bHQ7XG59O1xuXG4vLyBDb3JlIGxvZ2ljIHNoYXJlZCBieSBnZXRXaW5kb3dIYW5kbGVzIChmcmVzaCkgYW5kIF9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdyAoY2FjaGVkKS5cbmNvbW1hbmRzLl9nZXRXaW5kb3dIYW5kbGVzQ29yZSA9IGZ1bmN0aW9uIF9nZXRXaW5kb3dIYW5kbGVzQ29yZSAoKSB7XG4gIGNvbnN0IGFwaXMgPSBnZXRBcGlzKHRoaXMpO1xuICBjb25zdCBhcHBOYW1lID0gdGhpcy5hcHBOYW1lO1xuICBsZXQgcGlkcyA9IGFwaXMuYXBwX3J1bm5pbmcoYXBwTmFtZSk7XG4gIC8vIEZhbGxiYWNrOiB0aGUgbmF0aXZlIG1vZHVsZSB1c2VzIHBncmVwIHdpdGggdGhlIGV4YWN0IHBhdGgsIHdoaWNoIGZhaWxzXG4gIC8vIGZvciB3cmFwcGVyIHNjcmlwdHMuICBUcnkgcGdyZXAgYnkgYmFzZW5hbWUgKGNhY2hlZCBmb3IgM3MpLlxuICBpZiAoKCFwaWRzIHx8IHBpZHMubGVuZ3RoID09PSAwKSAmJiBhcHBOYW1lKSB7XG4gICAgcGlkcyA9IHBncmVwQnlCYXNlbmFtZShhcHBOYW1lKTtcbiAgfVxuICBpZiAoIXBpZHMgfHwgcGlkcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGBhcHBsaWNhdGlvbiAke2FwcE5hbWV9IGlzIG5vdCBydW5uaW5nYCk7XG4gIH1cbiAgY29uc3Qgd2luSGllcmFjaHkgPSBhcGlzLmFwcF9nZXRXaW5kb3dIaWVyYWNoeSgpO1xuICBjb25zdCBkb2MgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKHdpbkhpZXJhY2h5KTtcbiAgbGV0IHhwYXRoID0gcGlkcy5tYXAoKHBpZCkgPT4gYEBwaWQ9XCIke3BpZH1cImApLmpvaW4oJyBvciAnKTtcbiAgeHBhdGggPSBgLy8qWyR7eHBhdGh9IGFuZCBASW5wdXRPdXRwdXQ9XCJ0cnVlXCJdYDtcbiAgY29uc3Qgbm9kZXMgPSBzZWxlY3QoZG9jLCB4cGF0aCk7XG4gIGlmICghbm9kZXMgfHwgbm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGxldCBfbm9kZXMgPSBbXTtcbiAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgaWYgKCFub2RlLmF0dHJpYnV0ZXMpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBfbm9kZSA9IHt9O1xuICAgIGNvbnN0IGF0dHJzID0gQXJyYXkuZnJvbShub2RlLmF0dHJpYnV0ZXMpO1xuICAgIGZvciAoY29uc3QgYXR0ciBvZiBhdHRycykge1xuICAgICAgaWYgKGF0dHIubmFtZSA9PT0gJ2NsYXNzJykge1xuICAgICAgICBfbm9kZS5jbGFzcyA9IGF0dHIudmFsdWUuc3BsaXQoJyAnKTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAnbmFtZScpIHtcbiAgICAgICAgX25vZGUubmFtZSA9IGF0dHIudmFsdWU7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ3BpZCcpIHtcbiAgICAgICAgX25vZGUucGlkID0gTnVtYmVyLnBhcnNlSW50KGF0dHIudmFsdWUsIDEwKTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAnd2lkJykge1xuICAgICAgICBfbm9kZS53aWQgPSBOdW1iZXIucGFyc2VJbnQoYXR0ci52YWx1ZSwgMTApO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICdyZWN0Jykge1xuICAgICAgICBfbm9kZS5yZWN0ID0gcGFyc2VSZWN0KGF0dHIudmFsdWUpO1xuICAgICAgfSBlbHNlIGlmIChhdHRyLm5hbWUgPT09ICdzdGF0ZXMnKSB7XG4gICAgICAgIF9ub2RlLnN0YXRlcyA9IGF0dHIudmFsdWU7XG4gICAgICB9IGVsc2UgaWYgKGF0dHIubmFtZSA9PT0gJ3RhZycpIHtcbiAgICAgICAgX25vZGUudGFnID0gYXR0ci52YWx1ZTtcbiAgICAgIH0gZWxzZSBpZiAoYXR0ci5uYW1lID09PSAnd2luZG93LXR5cGUnKSB7XG4gICAgICAgIF9ub2RlLndpbmRvd1R5cGUgPSBhdHRyLnZhbHVlO1xuICAgICAgfVxuICAgIH1cbiAgICBfbm9kZXMucHVzaChfbm9kZSk7XG4gIH1cbiAgX25vZGVzID0gX25vZGVzLmZpbHRlcigocCkgPT4gcC5waWQgJiYgcC53aWQpO1xuICBpZiAoX25vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBfbm9kZXMgPSBfbm9kZXMubWFwKChwKSA9PiB7XG4gICAgbGV0IF9ub2RlID0ge1xuICAgICAgcGlkOiBwLnBpZCxcbiAgICAgIHdpZDogcC53aWQsXG4gICAgICBuYW1lczogW10sXG4gICAgICByZWN0OiBwLnJlY3QgfHwgbnVsbCxcbiAgICAgIHN0YXRlczogcC5zdGF0ZXMgfHwgJycsXG4gICAgICB0YWc6IHAudGFnIHx8ICcnLFxuICAgICAgd2luZG93VHlwZTogcC53aW5kb3dUeXBlIHx8ICcnLFxuICAgIH07XG4gICAgaWYgKHAubmFtZSkge1xuICAgICAgX25vZGUubmFtZXMucHVzaChwLm5hbWUpO1xuICAgIH1cbiAgICBpZiAocC5jbGFzcykge1xuICAgICAgX25vZGUubmFtZXMucHVzaCguLi5wLmNsYXNzKTtcbiAgICB9XG4gICAgcmV0dXJuIF9ub2RlO1xuICB9KTtcbiAgX25vZGVzLnNvcnQoKGEsIGIpID0+IHdpbmRvd1ByaW9yaXR5KGIpIC0gd2luZG93UHJpb3JpdHkoYSkpO1xuICBpZiAoIXNob3VsZFZlcmlmeVdpbmRvd0luQTExeSh0aGlzKSkge1xuICAgIC8vIFdheWxhbmQgdXNlcyBzeW50aGV0aWMgd2luZG93IGhhbmRsZXMgZGVyaXZlZCBmcm9tIHRoZSBjdXJyZW50IEFULVNQSSB0cmVlLlxuICAgIC8vIEF2b2lkIGJsb2NraW5nIG5hdGl2ZSBhMTF5IGxvb2t1cHMgd2hpbGUgd2luZG93cyBhcmUgc3RpbGwgc2V0dGxpbmcuXG4gICAgcmV0dXJuIFsuLi5uZXcgU2V0KF9ub2Rlcy5tYXAoKG5vZGUpID0+IG5vZGUud2lkKSldO1xuICB9XG4gIGNvbnN0IHdpZHMgPSBbXTtcbiAgZm9yIChjb25zdCBfbm9kZSBvZiBfbm9kZXMpIHtcbiAgICBsZXQgb2sgPSBmYWxzZTtcbiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgX25vZGUubmFtZXMpIHtcbiAgICAgIGlmIChhcGlzLmExMXlfY2hlY2tXaW5kb3dFeGlzdHMobmFtZSwgX25vZGUucGlkKSkge1xuICAgICAgICBvayA9IHRydWU7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgICBpZiAob2spIHtcbiAgICAgIHdpZHMucHVzaChfbm9kZS53aWQpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gd2lkcztcbn07XG5cbmNvbW1hbmRzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbk5hbWUgPSBmdW5jdGlvbiAod2luZG93TmFtZSkge1xuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgY29uc3QgcGlkcyA9IGFwaXMuYXBwX3J1bm5pbmcodGhpcy5hcHBOYW1lKTtcbiAgaWYgKCFwaWRzIHx8IHBpZHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgYXBwbGljYXRpb24gJHt0aGlzLmFwcE5hbWV9IGlzIG5vdCBydW5uaW5nYCk7XG4gIH1cbiAgY29uc3Qgd2luSGllcmFjaHkgPSBhcGlzLmFwcF9nZXRXaW5kb3dIaWVyYWNoeSgpO1xuICBjb25zdCBkb2MgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKHdpbkhpZXJhY2h5KTtcbiAgbGV0IHhwYXRoID0gcGlkcy5tYXAoKHBpZCkgPT4gYEBwaWQ9XCIke3BpZH1cImApLmpvaW4oJyBvciAnKTtcbiAgeHBhdGggPSBgLy8qWygke3hwYXRofSkgYW5kIEBJbnB1dE91dHB1dD1cInRydWVcIiBhbmQgKEBuYW1lPVwiJHt3aW5kb3dOYW1lfVwiIG9yIGNvbnRhaW5zKGNvbmNhdChcIiBcIiwgQGNsYXNzLCBcIiBcIiksIFwiJHsnICcgKyB3aW5kb3dOYW1lICsgJyAnfVwiKSldYDtcbiAgY29uc3Qgbm9kZXMgPSBzZWxlY3QoZG9jLCB4cGF0aCk7XG4gIGlmICghbm9kZXMgfHwgbm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHdpbmRvdyAke3dpbmRvd05hbWV9IGRvZXNuJ3QgcHJlc2VudGApO1xuICB9XG4gIGxldCBfbm9kZXMgPSBbXTtcbiAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgaWYgKCFub2RlLmF0dHJpYnV0ZXMpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBhdHRycyA9IEFycmF5LmZyb20obm9kZS5hdHRyaWJ1dGVzKTtcbiAgICBjb25zdCBfbm9kZSA9IHt9O1xuICAgIGZvciAoY29uc3QgYXR0ciBvZiBhdHRycykge1xuICAgICAgX25vZGVbYXR0ci5uYW1lXSA9IGF0dHIudmFsdWU7XG4gICAgfVxuICAgIF9ub2Rlcy5wdXNoKF9ub2RlKTtcbiAgfVxuICBfbm9kZXMgPSBfbm9kZXMuZmlsdGVyKChwKSA9PiAocC5uYW1lIHx8IHAuY2xhc3MpICYmIHAucGlkICYmIHAud2lkKTtcbiAgaWYgKF9ub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93ICR7d2luZG93TmFtZX0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgX25vZGVzID0gX25vZGVzLm1hcCgocCkgPT4gKHtcbiAgICAuLi5wLFxuICAgIHBpZDogTnVtYmVyLnBhcnNlSW50KHAucGlkLCAxMCksXG4gICAgd2lkOiBOdW1iZXIucGFyc2VJbnQocC53aWQsIDEwKSxcbiAgICByZWN0OiBwYXJzZVJlY3QocC5yZWN0KSxcbiAgICBzdGF0ZXM6IHAuc3RhdGVzIHx8ICcnLFxuICAgIHRhZzogcC50YWcgfHwgJycsXG4gICAgd2luZG93VHlwZTogcFsnd2luZG93LXR5cGUnXSB8fCBwLndpbmRvd1R5cGUgfHwgJycsXG4gIH0pKTtcbiAgX25vZGVzLnNvcnQoKGEsIGIpID0+IHtcbiAgICBjb25zdCBhdiA9IGEubmFtZSA9PT0gd2luZG93TmFtZSA/IC0xIDogMTtcbiAgICBjb25zdCBidiA9IGIubmFtZSA9PT0gd2luZG93TmFtZSA/IC0xIDogMTtcbiAgICByZXR1cm4gYXYgLSBidiB8fCB3aW5kb3dQcmlvcml0eShiKSAtIHdpbmRvd1ByaW9yaXR5KGEpO1xuICB9KTtcbiAgaWYgKCFzaG91bGRWZXJpZnlXaW5kb3dJbkExMXkodGhpcykpIHtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSBfbm9kZXNbMF07XG4gICAgcmV0dXJuIHtcbiAgICAgIHBpZDogY2FuZGlkYXRlLnBpZCxcbiAgICAgIHdpZDogY2FuZGlkYXRlLndpZCxcbiAgICAgIG5hbWU6IGNhbmRpZGF0ZS5uYW1lIHx8IHdpbmRvd05hbWUsXG4gICAgICByZWN0OiBjYW5kaWRhdGUucmVjdCB8fCBudWxsLFxuICAgICAgc3RhdGVzOiBjYW5kaWRhdGUuc3RhdGVzIHx8ICcnLFxuICAgICAgdGFnOiBjYW5kaWRhdGUudGFnIHx8ICcnLFxuICAgICAgd2luZG93VHlwZTogY2FuZGlkYXRlLndpbmRvd1R5cGUgfHwgJycsXG4gICAgfTtcbiAgfVxuICBmb3IgKGNvbnN0IF9ub2RlIG9mIF9ub2Rlcykge1xuICAgIGNvbnN0IF9waWQgPSBfbm9kZS5waWQ7XG4gICAgaWYgKGFwaXMuYTExeV9jaGVja1dpbmRvd0V4aXN0cyh3aW5kb3dOYW1lLCBfcGlkKSkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgcGlkOiBfcGlkLFxuICAgICAgICB3aWQ6IF9ub2RlLndpZCxcbiAgICAgICAgbmFtZTogd2luZG93TmFtZSxcbiAgICAgICAgcmVjdDogX25vZGUucmVjdCB8fCBudWxsLFxuICAgICAgICBzdGF0ZXM6IF9ub2RlLnN0YXRlcyB8fCAnJyxcbiAgICAgICAgdGFnOiBfbm9kZS50YWcgfHwgJycsXG4gICAgICAgIHdpbmRvd1R5cGU6IF9ub2RlLndpbmRvd1R5cGUgfHwgJycsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93ICR7d2luZG93TmFtZX0gZG9lc24ndCBwcmVzZW50YCk7XG59O1xuXG5jb21tYW5kcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5JZCA9IGZ1bmN0aW9uICh3aWQpIHtcbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIGNvbnN0IHdpbkhpZXJhY2h5ID0gYXBpcy5hcHBfZ2V0V2luZG93SGllcmFjaHkoKTtcbiAgY29uc3QgZG9jID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyh3aW5IaWVyYWNoeSk7XG4gIGNvbnN0IHhwYXRoID0gYC8vKltAd2lkPVwiJHt3aWR9XCIgYW5kIEBJbnB1dE91dHB1dD1cInRydWVcIl1gO1xuICBjb25zdCBub2RlcyA9IHNlbGVjdChkb2MsIHhwYXRoKTtcbiAgaWYgKCFub2RlcyB8fCBub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93IHdpZD0ke3dpZH0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgbGV0IF9ub2RlcyA9IFtdO1xuICBmb3IgKGNvbnN0IGN1cnJlbnROb2RlIG9mIG5vZGVzKSB7XG4gICAgY29uc3QgYXR0cnMgPSBBcnJheS5mcm9tKGN1cnJlbnROb2RlLmF0dHJpYnV0ZXMpO1xuICAgIGNvbnN0IF9ub2RlID0ge307XG4gICAgZm9yIChjb25zdCBhdHRyIG9mIGF0dHJzKSB7XG4gICAgICBfbm9kZVthdHRyLm5hbWVdID0gYXR0ci52YWx1ZTtcbiAgICB9XG4gICAgX25vZGVzLnB1c2goX25vZGUpO1xuICB9XG4gIF9ub2RlcyA9IF9ub2Rlcy5tYXAoKHApID0+ICh7XG4gICAgLi4ucCxcbiAgICBwaWQ6IE51bWJlci5wYXJzZUludChwLnBpZCwgMTApLFxuICAgIHdpZDogTnVtYmVyLnBhcnNlSW50KHAud2lkLCAxMCksXG4gICAgcmVjdDogcGFyc2VSZWN0KHAucmVjdCksXG4gICAgc3RhdGVzOiBwLnN0YXRlcyB8fCAnJyxcbiAgICB0YWc6IHAudGFnIHx8ICcnLFxuICAgIHdpbmRvd1R5cGU6IHBbJ3dpbmRvdy10eXBlJ10gfHwgcC53aW5kb3dUeXBlIHx8ICcnLFxuICB9KSkuZmlsdGVyKChwKSA9PiBwLnBpZCAmJiBwLndpZCk7XG4gIGlmIChfbm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHdpbmRvdyB3aWQ9JHt3aWR9IGRvZXNuJ3QgcHJlc2VudGApO1xuICB9XG4gIF9ub2Rlcy5zb3J0KChhLCBiKSA9PiB3aW5kb3dQcmlvcml0eShiKSAtIHdpbmRvd1ByaW9yaXR5KGEpKTtcbiAgY29uc3Qgbm9kZSA9IF9ub2Rlc1swXTtcbiAgaWYgKCFub2RlLnBpZCB8fCAhbm9kZS53aWQpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaFdpbmRvd0Vycm9yKGB0aGUgd2luZG93IHdpZD0ke3dpZH0gZG9lc24ndCBwcmVzZW50YCk7XG4gIH1cbiAgaWYgKCFzaG91bGRWZXJpZnlXaW5kb3dJbkExMXkodGhpcykpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcGlkOiBub2RlLnBpZCxcbiAgICAgIHdpZDogbm9kZS53aWQsXG4gICAgICBuYW1lOiBub2RlLm5hbWUsXG4gICAgICByZWN0OiBub2RlLnJlY3QgfHwgbnVsbCxcbiAgICAgIHN0YXRlczogbm9kZS5zdGF0ZXMgfHwgJycsXG4gICAgICB0YWc6IG5vZGUudGFnIHx8ICcnLFxuICAgICAgd2luZG93VHlwZTogbm9kZS53aW5kb3dUeXBlIHx8ICcnLFxuICAgIH07XG4gIH1cbiAgaWYgKG5vZGUubmFtZSAmJiAhYXBpcy5hMTF5X2NoZWNrV2luZG93RXhpc3RzKG5vZGUubmFtZSwgbm9kZS5waWQpKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHdpbmRvdyB3aWQ9JHt3aWR9IGRvZXNuJ3QgcHJlc2VudGApO1xuICB9XG4gIHJldHVybiB7XG4gICAgcGlkOiBub2RlLnBpZCxcbiAgICB3aWQ6IG5vZGUud2lkLFxuICAgIG5hbWU6IG5vZGUubmFtZSxcbiAgICByZWN0OiBub2RlLnJlY3QgfHwgbnVsbCxcbiAgICBzdGF0ZXM6IG5vZGUuc3RhdGVzIHx8ICcnLFxuICAgIHRhZzogbm9kZS50YWcgfHwgJycsXG4gICAgd2luZG93VHlwZTogbm9kZS53aW5kb3dUeXBlIHx8ICcnLFxuICB9O1xufTtcblxuZnVuY3Rpb24gdmFsaWRhdGVOYW1lIChuYW1lKSB7XG4gIGlmICghbmFtZSkge1xuICAgIHJldHVybiBuYW1lO1xuICB9XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbmFtZS5sZW5ndGg7ICsraSkge1xuICAgIGlmIChuYW1lW2ldIDwgJzAnIHx8IG5hbWVbaV0gPiAnOScpIHtcbiAgICAgIHJldHVybiBuYW1lO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gdmFsaWRhdGVIYW5kbGUgKGhhbmRsZSkge1xuICBpZiAoIWhhbmRsZSkge1xuICAgIHJldHVybiBoYW5kbGU7XG4gIH1cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBoYW5kbGUubGVuZ3RoOyArK2kpIHtcbiAgICBpZiAoaGFuZGxlW2ldIDwgJzAnIHx8IGhhbmRsZVtpXSA+ICc5Jykge1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuICB9XG4gIHJldHVybiBoYW5kbGU7XG59XG5cbmNvbW1hbmRzLnNldFdpbmRvdyA9IGZ1bmN0aW9uIHNldFdpbmRvdyAobmFtZSwgaGFuZGxlKSB7XG4gIGhhbmRsZSA9IHZhbGlkYXRlSGFuZGxlKGhhbmRsZSk7XG4gIG5hbWUgPSB2YWxpZGF0ZU5hbWUobmFtZSk7XG4gIGlmIChuYW1lKSB7XG4gICAgY29uc3Qgd2luID0gdGhpcy5fZ2V0V2luQW5kUGlkX0Zyb21XaW5OYW1lKG5hbWUpO1xuICAgIHRoaXMuX3dpbiA9IHdpbjtcbiAgfSBlbHNlIGlmIChoYW5kbGUpIHtcbiAgICBjb25zdCB3aW4gPSB0aGlzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbklkKGhhbmRsZSk7XG4gICAgdGhpcy5fd2luID0gd2luO1xuICB9IGVsc2Uge1xuICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKFwic2V0V2luZG93IGJvdGggbmFtZSBhbmQgaGFuZGxlIGRvbid0IGhhdmUgYSB2YWx1ZVwiKTtcbiAgfVxuICB0aGlzLl9sYXN0Q2FjaGVDbGVhckF0ID0gMDtcbiAgdGhpcy5fd2luVmFsaWRhdGVkQXQgPSAwO1xuICB0aGlzLl93aW5IYW5kbGVWYWxpZGF0ZWRBdCA9IDA7XG4gIHRoaXMuX2xhc3RXaW5kb3dIYW5kbGVzQXQgPSAwO1xufTtcblxuY29tbWFuZHMuZ2V0V2luZG93UmVjdCA9IGZ1bmN0aW9uIGdldFdpbmRvd1JlY3QgKCkge1xuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgY29uc3Qgd2luID0gdGhpcy5fd2luO1xuICBpZiAoIXdpbikge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHdpbmRvdyBpcyBub3Qgc3BlY2lmaWVkYCk7XG4gIH1cbiAgY29uc3Qge3dpZH0gPSB3aW47XG4gIHJldHVybiBhcGlzLmFwcF9nZXRXaW5SZWN0KHdpZCk7XG59O1xuXG5leHBvcnQgZGVmYXVsdCBjb21tYW5kcztcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7QUFBQSxJQUFBQSxNQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxPQUFBLEdBQUFELE9BQUE7QUFDQSxJQUFBRSxXQUFBLEdBQUFGLE9BQUE7QUFDQSxJQUFBRyxjQUFBLEdBQUFILE9BQUE7QUFLQSxJQUFJSSxXQUFXLEdBQUc7RUFBQ0MsSUFBSSxFQUFFLElBQUk7RUFBRUMsT0FBTyxFQUFFLElBQUk7RUFBRUMsRUFBRSxFQUFFO0FBQUMsQ0FBQztBQUNwRCxNQUFNQyxrQkFBa0IsR0FBRyxJQUFJO0FBRS9CLFNBQVNDLGVBQWVBLENBQUVILE9BQU8sRUFBRTtFQUNqQyxNQUFNSSxHQUFHLEdBQUdDLElBQUksQ0FBQ0QsR0FBRyxDQUFDLENBQUM7RUFDdEIsSUFBSU4sV0FBVyxDQUFDRSxPQUFPLEtBQUtBLE9BQU8sSUFBSUYsV0FBVyxDQUFDQyxJQUFJLElBQUtLLEdBQUcsR0FBR04sV0FBVyxDQUFDRyxFQUFFLEdBQUlDLGtCQUFrQixFQUFFO0lBQ3RHLE9BQU9KLFdBQVcsQ0FBQ0MsSUFBSTtFQUN6QjtFQUNBLElBQUlBLElBQUksR0FBRyxJQUFJO0VBQ2YsSUFBSTtJQUNGLE1BQU1PLFFBQVEsR0FBRyxDQUFDTixPQUFPLElBQUksRUFBRSxFQUFFTyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUNDLEdBQUcsQ0FBQyxDQUFDO0lBQ2pELElBQUlGLFFBQVEsRUFBRTtNQUNaLE1BQU1HLEdBQUcsR0FBRyxJQUFBQyx3QkFBUyxFQUFDLE9BQU8sRUFBRSxDQUFDLElBQUksRUFBRUosUUFBUSxDQUFDLEVBQUU7UUFBQ0ssUUFBUSxFQUFFLE1BQU07UUFBRUMsT0FBTyxFQUFFO01BQUksQ0FBQyxDQUFDO01BQ25GLElBQUlILEdBQUcsQ0FBQ0ksTUFBTSxLQUFLLENBQUMsSUFBSUosR0FBRyxDQUFDSyxNQUFNLEVBQUU7UUFDbENmLElBQUksR0FBR1UsR0FBRyxDQUFDSyxNQUFNLENBQUNDLElBQUksQ0FBQyxDQUFDLENBQUNSLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQ1MsR0FBRyxDQUFDQyxNQUFNLENBQUMsQ0FBQ0MsTUFBTSxDQUFDRCxNQUFNLENBQUNFLFFBQVEsQ0FBQztNQUMzRTtJQUNGO0VBQ0YsQ0FBQyxDQUFDLE1BQU0sQ0FBZTtFQUN2QixJQUFJcEIsSUFBSSxJQUFJQSxJQUFJLENBQUNxQixNQUFNLEdBQUcsQ0FBQyxFQUFFO0lBQzNCdEIsV0FBVyxHQUFHO01BQUNDLElBQUk7TUFBRUMsT0FBTztNQUFFQyxFQUFFLEVBQUVHO0lBQUcsQ0FBQztFQUN4QztFQUNBLE9BQU9MLElBQUk7QUFDYjtBQUVBLE1BQU1zQixRQUFRLEdBQUcsQ0FBQyxDQUFDO0FBQ25CLFNBQVNDLE9BQU9BLENBQUVDLEdBQUcsRUFBRTtFQUNyQixJQUFJLEVBQUNBLEdBQUcsYUFBSEEsR0FBRyxlQUFIQSxHQUFHLENBQUVDLFlBQVksR0FBRTtJQUN0QixNQUFNLElBQUlDLGtCQUFNLENBQUNDLFlBQVksQ0FBQyxrQ0FBa0MsQ0FBQztFQUNuRTtFQUNBLE9BQU9ILEdBQUcsQ0FBQ0MsWUFBWTtBQUN6QjtBQUVBLFNBQVNHLHdCQUF3QkEsQ0FBRUosR0FBRyxFQUFFO0VBQ3RDLE9BQU8sQ0FBQUEsR0FBRyxhQUFIQSxHQUFHLHVCQUFIQSxHQUFHLENBQUVLLFlBQVksTUFBSyxTQUFTO0FBQ3hDO0FBRUEsU0FBU0MsU0FBU0EsQ0FBRUMsSUFBSSxFQUFFO0VBQ3hCLE1BQU1DLEtBQUssR0FBRyw0REFBNEQsQ0FBQ0MsSUFBSSxDQUFDLEdBQUdGLElBQUksYUFBSkEsSUFBSSxjQUFKQSxJQUFJLEdBQUksRUFBRSxFQUFFLENBQUM7RUFDaEcsSUFBSSxDQUFDQyxLQUFLLEVBQUU7SUFDVixPQUFPLElBQUk7RUFDYjtFQUNBLE1BQU07SUFBQ0UsQ0FBQztJQUFFQyxDQUFDO0lBQUVDLEtBQUs7SUFBRUM7RUFBTSxDQUFDLEdBQUdMLEtBQUssQ0FBQ00sTUFBTTtFQUMxQyxPQUFPO0lBQ0xKLENBQUMsRUFBRWhCLE1BQU0sQ0FBQ3FCLFFBQVEsQ0FBQ0wsQ0FBQyxFQUFFLEVBQUUsQ0FBQztJQUN6QkMsQ0FBQyxFQUFFakIsTUFBTSxDQUFDcUIsUUFBUSxDQUFDSixDQUFDLEVBQUUsRUFBRSxDQUFDO0lBQ3pCQyxLQUFLLEVBQUVsQixNQUFNLENBQUNxQixRQUFRLENBQUNILEtBQUssRUFBRSxFQUFFLENBQUM7SUFDakNDLE1BQU0sRUFBRW5CLE1BQU0sQ0FBQ3FCLFFBQVEsQ0FBQ0YsTUFBTSxFQUFFLEVBQUU7RUFDcEMsQ0FBQztBQUNIO0FBRUEsU0FBU0csY0FBY0EsQ0FBRUMsSUFBSSxHQUFHLENBQUMsQ0FBQyxFQUFFO0VBQUEsSUFBQUMsWUFBQSxFQUFBQyxTQUFBLEVBQUFDLGdCQUFBO0VBQ2xDLE1BQU1DLE1BQU0sR0FBRyxJQUFBSCxZQUFBLEdBQUdELElBQUksQ0FBQ0ksTUFBTSxjQUFBSCxZQUFBLGNBQUFBLFlBQUEsR0FBSSxFQUFFLEVBQUUsQ0FBQ0ksV0FBVyxDQUFDLENBQUM7RUFDbkQsTUFBTUMsR0FBRyxHQUFHLElBQUFKLFNBQUEsR0FBR0YsSUFBSSxDQUFDTSxHQUFHLGNBQUFKLFNBQUEsY0FBQUEsU0FBQSxHQUFJLEVBQUUsRUFBRSxDQUFDSyxXQUFXLENBQUMsQ0FBQztFQUM3QyxNQUFNQyxVQUFVLEdBQUcsSUFBQUwsZ0JBQUEsR0FBR0gsSUFBSSxDQUFDUSxVQUFVLGNBQUFMLGdCQUFBLGNBQUFBLGdCQUFBLEdBQUksRUFBRSxFQUFFLENBQUNJLFdBQVcsQ0FBQyxDQUFDO0VBQzNELE1BQU1qQixJQUFJLEdBQUdVLElBQUksQ0FBQ1YsSUFBSTtFQUN0QixJQUFJbUIsS0FBSyxHQUFHLENBQUM7RUFDYixJQUFJbkIsSUFBSSxJQUFJQSxJQUFJLENBQUNLLEtBQUssR0FBRyxDQUFDLElBQUlMLElBQUksQ0FBQ00sTUFBTSxHQUFHLENBQUMsRUFBRTtJQUM3Q2EsS0FBSyxJQUFJbkIsSUFBSSxDQUFDSyxLQUFLLEdBQUdMLElBQUksQ0FBQ00sTUFBTTtFQUNuQztFQUNBLElBQUlVLEdBQUcsQ0FBQ0ksUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJRixVQUFVLENBQUNFLFFBQVEsQ0FBQyxPQUFPLENBQUMsRUFBRTtJQUN6REQsS0FBSyxJQUFJLFNBQVM7RUFDcEIsQ0FBQyxNQUFNLElBQUlILEdBQUcsQ0FBQ0ksUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJRixVQUFVLENBQUNFLFFBQVEsQ0FBQyxRQUFRLENBQUMsSUFBSUYsVUFBVSxDQUFDRSxRQUFRLENBQUMsT0FBTyxDQUFDLEVBQUU7SUFDbEdELEtBQUssSUFBSSxRQUFRO0VBQ25CLENBQUMsTUFBTSxJQUNMSCxHQUFHLENBQUNJLFFBQVEsQ0FBQyxjQUFjLENBQUMsSUFDekJKLEdBQUcsQ0FBQ0ksUUFBUSxDQUFDLFNBQVMsQ0FBQyxJQUN2QkYsVUFBVSxDQUFDRSxRQUFRLENBQUMsY0FBYyxDQUFDLElBQ25DRixVQUFVLENBQUNFLFFBQVEsQ0FBQyxTQUFTLENBQUMsSUFDOUJGLFVBQVUsQ0FBQ0UsUUFBUSxDQUFDLE9BQU8sQ0FBQyxFQUMvQjtJQUNBRCxLQUFLLElBQUksUUFBUTtFQUNuQjtFQUNBLElBQUlMLE1BQU0sQ0FBQ00sUUFBUSxDQUFDLFFBQVEsQ0FBQyxFQUFFO0lBQzdCRCxLQUFLLElBQUksUUFBUTtFQUNuQjtFQUNBLElBQUlMLE1BQU0sQ0FBQ00sUUFBUSxDQUFDLFNBQVMsQ0FBQyxJQUFJTixNQUFNLENBQUNNLFFBQVEsQ0FBQyxTQUFTLENBQUMsRUFBRTtJQUM1REQsS0FBSyxJQUFJLFFBQVE7RUFDbkI7RUFDQSxJQUFJTCxNQUFNLENBQUNNLFFBQVEsQ0FBQyxTQUFTLENBQUMsSUFBSU4sTUFBTSxDQUFDTSxRQUFRLENBQUMsV0FBVyxDQUFDLEVBQUU7SUFDOURELEtBQUssSUFBSSxPQUFPO0VBQ2xCO0VBQ0EsT0FBT0EsS0FBSztBQUNkO0FBRUE1QixRQUFRLENBQUM4QixlQUFlLEdBQUcsU0FBU0EsZUFBZUEsQ0FBQSxFQUFJO0VBQUEsSUFBQUMsc0JBQUE7RUFFckQsSUFBSSxJQUFJLENBQUNDLElBQUksRUFBRTtJQUNiLE1BQU1qRCxHQUFHLEdBQUdDLElBQUksQ0FBQ0QsR0FBRyxDQUFDLENBQUM7SUFDdEIsSUFBSSxJQUFJLENBQUNrRCxxQkFBcUIsSUFBS2xELEdBQUcsR0FBRyxJQUFJLENBQUNrRCxxQkFBcUIsR0FBSSxJQUFJLEVBQUU7TUFDM0UsT0FBTyxJQUFJLENBQUNELElBQUksQ0FBQ0UsR0FBRztJQUN0QjtJQUNBLElBQUk7TUFBQSxJQUFBQyxVQUFBO01BQ0YsSUFBSSxDQUFDSCxJQUFJLEdBQUcsSUFBSSxDQUFDSSx1QkFBdUIsQ0FBQyxJQUFJLENBQUNKLElBQUksQ0FBQ0UsR0FBRyxDQUFDO01BQ3ZELElBQUksQ0FBQ0QscUJBQXFCLEdBQUdqRCxJQUFJLENBQUNELEdBQUcsQ0FBQyxDQUFDO01BQ3ZDLFFBQUFvRCxVQUFBLEdBQU8sSUFBSSxDQUFDSCxJQUFJLGNBQUFHLFVBQUEsdUJBQVRBLFVBQUEsQ0FBV0QsR0FBRztJQUN2QixDQUFDLENBQUMsTUFBTTtNQUFBLElBQUFHLHFCQUFBO01BQ04sSUFBSSxDQUFDSixxQkFBcUIsR0FBRyxDQUFDO01BQzlCLFFBQUFJLHFCQUFBLEdBQU8sSUFBSSxDQUFDQywyQkFBMkIsQ0FBQyxDQUFDLGNBQUFELHFCQUFBLHVCQUFsQ0EscUJBQUEsQ0FBb0NILEdBQUc7SUFDaEQ7RUFDRjtFQUNBLFFBQUFILHNCQUFBLEdBQU8sSUFBSSxDQUFDTywyQkFBMkIsQ0FBQyxDQUFDLGNBQUFQLHNCQUFBLHVCQUFsQ0Esc0JBQUEsQ0FBb0NHLEdBQUc7QUFDaEQsQ0FBQztBQUVEbEMsUUFBUSxDQUFDc0MsMkJBQTJCLEdBQUcsU0FBU0EsMkJBQTJCQSxDQUFBLEVBQUk7RUFJN0UsTUFBTUMsT0FBTyxHQUFHLElBQUksQ0FBQ0MscUJBQXFCLENBQUMsQ0FBQztFQUM1QyxLQUFLLE1BQU1DLE1BQU0sSUFBSUYsT0FBTyxFQUFFO0lBQzVCLElBQUk7TUFDRixNQUFNRyxHQUFHLEdBQUcsSUFBSSxDQUFDTix1QkFBdUIsQ0FBQ0ssTUFBTSxDQUFDO01BQ2hELElBQUksQ0FBQ1QsSUFBSSxHQUFHVSxHQUFHO01BQ2YsT0FBT0EsR0FBRztJQUNaLENBQUMsQ0FBQyxNQUFNO01BQ047SUFDRjtFQUNGO0VBQ0EsSUFBSSxDQUFDVixJQUFJLEdBQUcsSUFBSTtFQUNoQixPQUFPLElBQUk7QUFDYixDQUFDO0FBRURoQyxRQUFRLENBQUMyQyxnQkFBZ0IsR0FBRyxTQUFTQSxnQkFBZ0JBLENBQUEsRUFBSTtFQUl2RCxNQUFNNUQsR0FBRyxHQUFHQyxJQUFJLENBQUNELEdBQUcsQ0FBQyxDQUFDO0VBQ3RCLElBQUksSUFBSSxDQUFDNkQsd0JBQXdCLElBQzFCLElBQUksQ0FBQ0Msb0JBQW9CLElBQUs5RCxHQUFHLEdBQUcsSUFBSSxDQUFDOEQsb0JBQW9CLEdBQUksSUFBSSxLQUNwRSxDQUFDLElBQUksQ0FBQ0MsZUFBZSxJQUFJLElBQUksQ0FBQ0Qsb0JBQW9CLEdBQUcsSUFBSSxDQUFDQyxlQUFlLENBQUMsRUFBRTtJQUNsRixPQUFPLElBQUksQ0FBQ0Ysd0JBQXdCO0VBQ3RDO0VBQ0EsTUFBTUcsSUFBSSxHQUFHOUMsT0FBTyxDQUFDLElBQUksQ0FBQztFQUkxQixJQUFJLE9BQU84QyxJQUFJLENBQUNDLGdDQUFnQyxLQUFLLFVBQVUsRUFBRTtJQUMvREQsSUFBSSxDQUFDQyxnQ0FBZ0MsQ0FBQyxDQUFDO0VBQ3pDO0VBQ0EsSUFBSSxPQUFPRCxJQUFJLENBQUNFLGtDQUFrQyxLQUFLLFVBQVUsRUFBRTtJQUNqRUYsSUFBSSxDQUFDRSxrQ0FBa0MsQ0FBQyxDQUFDO0VBQzNDO0VBQ0EsTUFBTUMsTUFBTSxHQUFHLElBQUksQ0FBQ1YscUJBQXFCLENBQUMsQ0FBQztFQUMzQyxJQUFJLENBQUNLLG9CQUFvQixHQUFHN0QsSUFBSSxDQUFDRCxHQUFHLENBQUMsQ0FBQztFQUN0QyxJQUFJLENBQUM2RCx3QkFBd0IsR0FBR00sTUFBTTtFQUN0QyxPQUFPQSxNQUFNO0FBQ2YsQ0FBQztBQUdEbEQsUUFBUSxDQUFDd0MscUJBQXFCLEdBQUcsU0FBU0EscUJBQXFCQSxDQUFBLEVBQUk7RUFDakUsTUFBTU8sSUFBSSxHQUFHOUMsT0FBTyxDQUFDLElBQUksQ0FBQztFQUMxQixNQUFNdEIsT0FBTyxHQUFHLElBQUksQ0FBQ0EsT0FBTztFQUM1QixJQUFJRCxJQUFJLEdBQUdxRSxJQUFJLENBQUNJLFdBQVcsQ0FBQ3hFLE9BQU8sQ0FBQztFQUdwQyxJQUFJLENBQUMsQ0FBQ0QsSUFBSSxJQUFJQSxJQUFJLENBQUNxQixNQUFNLEtBQUssQ0FBQyxLQUFLcEIsT0FBTyxFQUFFO0lBQzNDRCxJQUFJLEdBQUdJLGVBQWUsQ0FBQ0gsT0FBTyxDQUFDO0VBQ2pDO0VBQ0EsSUFBSSxDQUFDRCxJQUFJLElBQUlBLElBQUksQ0FBQ3FCLE1BQU0sS0FBSyxDQUFDLEVBQUU7SUFDOUIsTUFBTSxJQUFJSyxrQkFBTSxDQUFDZ0QsaUJBQWlCLENBQUMsZUFBZXpFLE9BQU8saUJBQWlCLENBQUM7RUFDN0U7RUFDQSxNQUFNMEUsV0FBVyxHQUFHTixJQUFJLENBQUNPLHFCQUFxQixDQUFDLENBQUM7RUFDaEQsTUFBTUMsR0FBRyxHQUFHLElBQUlDLGlCQUFHLENBQUMsQ0FBQyxDQUFDQyxlQUFlLENBQUNKLFdBQVcsQ0FBQztFQUNsRCxJQUFJSyxLQUFLLEdBQUdoRixJQUFJLENBQUNpQixHQUFHLENBQUVnRSxHQUFHLElBQUssU0FBU0EsR0FBRyxHQUFHLENBQUMsQ0FBQ0MsSUFBSSxDQUFDLE1BQU0sQ0FBQztFQUMzREYsS0FBSyxHQUFHLE9BQU9BLEtBQUssMkJBQTJCO0VBQy9DLE1BQU1HLEtBQUssR0FBRyxJQUFBQyxjQUFNLEVBQUNQLEdBQUcsRUFBRUcsS0FBSyxDQUFDO0VBQ2hDLElBQUksQ0FBQ0csS0FBSyxJQUFJQSxLQUFLLENBQUM5RCxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQ2hDLE9BQU8sRUFBRTtFQUNYO0VBQ0EsSUFBSWdFLE1BQU0sR0FBRyxFQUFFO0VBQ2YsS0FBSyxNQUFNNUMsSUFBSSxJQUFJMEMsS0FBSyxFQUFFO0lBQ3hCLElBQUksQ0FBQzFDLElBQUksQ0FBQzZDLFVBQVUsRUFBRTtNQUNwQjtJQUNGO0lBQ0EsTUFBTUMsS0FBSyxHQUFHLENBQUMsQ0FBQztJQUNoQixNQUFNQyxLQUFLLEdBQUdDLEtBQUssQ0FBQ0MsSUFBSSxDQUFDakQsSUFBSSxDQUFDNkMsVUFBVSxDQUFDO0lBQ3pDLEtBQUssTUFBTUssSUFBSSxJQUFJSCxLQUFLLEVBQUU7TUFDeEIsSUFBSUcsSUFBSSxDQUFDQyxJQUFJLEtBQUssT0FBTyxFQUFFO1FBQ3pCTCxLQUFLLENBQUNNLEtBQUssR0FBR0YsSUFBSSxDQUFDRyxLQUFLLENBQUN0RixLQUFLLENBQUMsR0FBRyxDQUFDO01BQ3JDLENBQUMsTUFBTSxJQUFJbUYsSUFBSSxDQUFDQyxJQUFJLEtBQUssTUFBTSxFQUFFO1FBQy9CTCxLQUFLLENBQUNLLElBQUksR0FBR0QsSUFBSSxDQUFDRyxLQUFLO01BQ3pCLENBQUMsTUFBTSxJQUFJSCxJQUFJLENBQUNDLElBQUksS0FBSyxLQUFLLEVBQUU7UUFDOUJMLEtBQUssQ0FBQ04sR0FBRyxHQUFHL0QsTUFBTSxDQUFDcUIsUUFBUSxDQUFDb0QsSUFBSSxDQUFDRyxLQUFLLEVBQUUsRUFBRSxDQUFDO01BQzdDLENBQUMsTUFBTSxJQUFJSCxJQUFJLENBQUNDLElBQUksS0FBSyxLQUFLLEVBQUU7UUFDOUJMLEtBQUssQ0FBQy9CLEdBQUcsR0FBR3RDLE1BQU0sQ0FBQ3FCLFFBQVEsQ0FBQ29ELElBQUksQ0FBQ0csS0FBSyxFQUFFLEVBQUUsQ0FBQztNQUM3QyxDQUFDLE1BQU0sSUFBSUgsSUFBSSxDQUFDQyxJQUFJLEtBQUssTUFBTSxFQUFFO1FBQy9CTCxLQUFLLENBQUN4RCxJQUFJLEdBQUdELFNBQVMsQ0FBQzZELElBQUksQ0FBQ0csS0FBSyxDQUFDO01BQ3BDLENBQUMsTUFBTSxJQUFJSCxJQUFJLENBQUNDLElBQUksS0FBSyxRQUFRLEVBQUU7UUFDakNMLEtBQUssQ0FBQzFDLE1BQU0sR0FBRzhDLElBQUksQ0FBQ0csS0FBSztNQUMzQixDQUFDLE1BQU0sSUFBSUgsSUFBSSxDQUFDQyxJQUFJLEtBQUssS0FBSyxFQUFFO1FBQzlCTCxLQUFLLENBQUN4QyxHQUFHLEdBQUc0QyxJQUFJLENBQUNHLEtBQUs7TUFDeEIsQ0FBQyxNQUFNLElBQUlILElBQUksQ0FBQ0MsSUFBSSxLQUFLLGFBQWEsRUFBRTtRQUN0Q0wsS0FBSyxDQUFDdEMsVUFBVSxHQUFHMEMsSUFBSSxDQUFDRyxLQUFLO01BQy9CO0lBQ0Y7SUFDQVQsTUFBTSxDQUFDVSxJQUFJLENBQUNSLEtBQUssQ0FBQztFQUNwQjtFQUNBRixNQUFNLEdBQUdBLE1BQU0sQ0FBQ2xFLE1BQU0sQ0FBRTZFLENBQUMsSUFBS0EsQ0FBQyxDQUFDZixHQUFHLElBQUllLENBQUMsQ0FBQ3hDLEdBQUcsQ0FBQztFQUM3QyxJQUFJNkIsTUFBTSxDQUFDaEUsTUFBTSxLQUFLLENBQUMsRUFBRTtJQUN2QixPQUFPLEVBQUU7RUFDWDtFQUNBZ0UsTUFBTSxHQUFHQSxNQUFNLENBQUNwRSxHQUFHLENBQUUrRSxDQUFDLElBQUs7SUFDekIsSUFBSVQsS0FBSyxHQUFHO01BQ1ZOLEdBQUcsRUFBRWUsQ0FBQyxDQUFDZixHQUFHO01BQ1Z6QixHQUFHLEVBQUV3QyxDQUFDLENBQUN4QyxHQUFHO01BQ1Z5QyxLQUFLLEVBQUUsRUFBRTtNQUNUbEUsSUFBSSxFQUFFaUUsQ0FBQyxDQUFDakUsSUFBSSxJQUFJLElBQUk7TUFDcEJjLE1BQU0sRUFBRW1ELENBQUMsQ0FBQ25ELE1BQU0sSUFBSSxFQUFFO01BQ3RCRSxHQUFHLEVBQUVpRCxDQUFDLENBQUNqRCxHQUFHLElBQUksRUFBRTtNQUNoQkUsVUFBVSxFQUFFK0MsQ0FBQyxDQUFDL0MsVUFBVSxJQUFJO0lBQzlCLENBQUM7SUFDRCxJQUFJK0MsQ0FBQyxDQUFDSixJQUFJLEVBQUU7TUFDVkwsS0FBSyxDQUFDVSxLQUFLLENBQUNGLElBQUksQ0FBQ0MsQ0FBQyxDQUFDSixJQUFJLENBQUM7SUFDMUI7SUFDQSxJQUFJSSxDQUFDLENBQUNILEtBQUssRUFBRTtNQUNYTixLQUFLLENBQUNVLEtBQUssQ0FBQ0YsSUFBSSxDQUFDLEdBQUdDLENBQUMsQ0FBQ0gsS0FBSyxDQUFDO0lBQzlCO0lBQ0EsT0FBT04sS0FBSztFQUNkLENBQUMsQ0FBQztFQUNGRixNQUFNLENBQUNhLElBQUksQ0FBQyxDQUFDQyxDQUFDLEVBQUVDLENBQUMsS0FBSzVELGNBQWMsQ0FBQzRELENBQUMsQ0FBQyxHQUFHNUQsY0FBYyxDQUFDMkQsQ0FBQyxDQUFDLENBQUM7RUFDNUQsSUFBSSxDQUFDdkUsd0JBQXdCLENBQUMsSUFBSSxDQUFDLEVBQUU7SUFHbkMsT0FBTyxDQUFDLEdBQUcsSUFBSXlFLEdBQUcsQ0FBQ2hCLE1BQU0sQ0FBQ3BFLEdBQUcsQ0FBRXdCLElBQUksSUFBS0EsSUFBSSxDQUFDZSxHQUFHLENBQUMsQ0FBQyxDQUFDO0VBQ3JEO0VBQ0EsTUFBTThDLElBQUksR0FBRyxFQUFFO0VBQ2YsS0FBSyxNQUFNZixLQUFLLElBQUlGLE1BQU0sRUFBRTtJQUMxQixJQUFJa0IsRUFBRSxHQUFHLEtBQUs7SUFDZCxLQUFLLE1BQU1YLElBQUksSUFBSUwsS0FBSyxDQUFDVSxLQUFLLEVBQUU7TUFDOUIsSUFBSTVCLElBQUksQ0FBQ21DLHNCQUFzQixDQUFDWixJQUFJLEVBQUVMLEtBQUssQ0FBQ04sR0FBRyxDQUFDLEVBQUU7UUFDaERzQixFQUFFLEdBQUcsSUFBSTtRQUNUO01BQ0Y7SUFDRjtJQUNBLElBQUlBLEVBQUUsRUFBRTtNQUNORCxJQUFJLENBQUNQLElBQUksQ0FBQ1IsS0FBSyxDQUFDL0IsR0FBRyxDQUFDO0lBQ3RCO0VBQ0Y7RUFDQSxPQUFPOEMsSUFBSTtBQUNiLENBQUM7QUFFRGhGLFFBQVEsQ0FBQ21GLHlCQUF5QixHQUFHLFVBQVVDLFVBQVUsRUFBRTtFQUN6RCxNQUFNckMsSUFBSSxHQUFHOUMsT0FBTyxDQUFDLElBQUksQ0FBQztFQUMxQixNQUFNdkIsSUFBSSxHQUFHcUUsSUFBSSxDQUFDSSxXQUFXLENBQUMsSUFBSSxDQUFDeEUsT0FBTyxDQUFDO0VBQzNDLElBQUksQ0FBQ0QsSUFBSSxJQUFJQSxJQUFJLENBQUNxQixNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQzlCLE1BQU0sSUFBSUssa0JBQU0sQ0FBQ2dELGlCQUFpQixDQUFDLGVBQWUsSUFBSSxDQUFDekUsT0FBTyxpQkFBaUIsQ0FBQztFQUNsRjtFQUNBLE1BQU0wRSxXQUFXLEdBQUdOLElBQUksQ0FBQ08scUJBQXFCLENBQUMsQ0FBQztFQUNoRCxNQUFNQyxHQUFHLEdBQUcsSUFBSUMsaUJBQUcsQ0FBQyxDQUFDLENBQUNDLGVBQWUsQ0FBQ0osV0FBVyxDQUFDO0VBQ2xELElBQUlLLEtBQUssR0FBR2hGLElBQUksQ0FBQ2lCLEdBQUcsQ0FBRWdFLEdBQUcsSUFBSyxTQUFTQSxHQUFHLEdBQUcsQ0FBQyxDQUFDQyxJQUFJLENBQUMsTUFBTSxDQUFDO0VBQzNERixLQUFLLEdBQUcsUUFBUUEsS0FBSyx5Q0FBeUMwQixVQUFVLDRDQUE0QyxHQUFHLEdBQUdBLFVBQVUsR0FBRyxHQUFHLE1BQU07RUFDaEosTUFBTXZCLEtBQUssR0FBRyxJQUFBQyxjQUFNLEVBQUNQLEdBQUcsRUFBRUcsS0FBSyxDQUFDO0VBQ2hDLElBQUksQ0FBQ0csS0FBSyxJQUFJQSxLQUFLLENBQUM5RCxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQ2hDLE1BQU0sSUFBSUssa0JBQU0sQ0FBQ2dELGlCQUFpQixDQUFDLGNBQWNnQyxVQUFVLGtCQUFrQixDQUFDO0VBQ2hGO0VBQ0EsSUFBSXJCLE1BQU0sR0FBRyxFQUFFO0VBQ2YsS0FBSyxNQUFNNUMsSUFBSSxJQUFJMEMsS0FBSyxFQUFFO0lBQ3hCLElBQUksQ0FBQzFDLElBQUksQ0FBQzZDLFVBQVUsRUFBRTtNQUNwQjtJQUNGO0lBQ0EsTUFBTUUsS0FBSyxHQUFHQyxLQUFLLENBQUNDLElBQUksQ0FBQ2pELElBQUksQ0FBQzZDLFVBQVUsQ0FBQztJQUN6QyxNQUFNQyxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2hCLEtBQUssTUFBTUksSUFBSSxJQUFJSCxLQUFLLEVBQUU7TUFDeEJELEtBQUssQ0FBQ0ksSUFBSSxDQUFDQyxJQUFJLENBQUMsR0FBR0QsSUFBSSxDQUFDRyxLQUFLO0lBQy9CO0lBQ0FULE1BQU0sQ0FBQ1UsSUFBSSxDQUFDUixLQUFLLENBQUM7RUFDcEI7RUFDQUYsTUFBTSxHQUFHQSxNQUFNLENBQUNsRSxNQUFNLENBQUU2RSxDQUFDLElBQUssQ0FBQ0EsQ0FBQyxDQUFDSixJQUFJLElBQUlJLENBQUMsQ0FBQ0gsS0FBSyxLQUFLRyxDQUFDLENBQUNmLEdBQUcsSUFBSWUsQ0FBQyxDQUFDeEMsR0FBRyxDQUFDO0VBQ3BFLElBQUk2QixNQUFNLENBQUNoRSxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQ3ZCLE1BQU0sSUFBSUssa0JBQU0sQ0FBQ2dELGlCQUFpQixDQUFDLGNBQWNnQyxVQUFVLGtCQUFrQixDQUFDO0VBQ2hGO0VBQ0FyQixNQUFNLEdBQUdBLE1BQU0sQ0FBQ3BFLEdBQUcsQ0FBRStFLENBQUMsS0FBTTtJQUMxQixHQUFHQSxDQUFDO0lBQ0pmLEdBQUcsRUFBRS9ELE1BQU0sQ0FBQ3FCLFFBQVEsQ0FBQ3lELENBQUMsQ0FBQ2YsR0FBRyxFQUFFLEVBQUUsQ0FBQztJQUMvQnpCLEdBQUcsRUFBRXRDLE1BQU0sQ0FBQ3FCLFFBQVEsQ0FBQ3lELENBQUMsQ0FBQ3hDLEdBQUcsRUFBRSxFQUFFLENBQUM7SUFDL0J6QixJQUFJLEVBQUVELFNBQVMsQ0FBQ2tFLENBQUMsQ0FBQ2pFLElBQUksQ0FBQztJQUN2QmMsTUFBTSxFQUFFbUQsQ0FBQyxDQUFDbkQsTUFBTSxJQUFJLEVBQUU7SUFDdEJFLEdBQUcsRUFBRWlELENBQUMsQ0FBQ2pELEdBQUcsSUFBSSxFQUFFO0lBQ2hCRSxVQUFVLEVBQUUrQyxDQUFDLENBQUMsYUFBYSxDQUFDLElBQUlBLENBQUMsQ0FBQy9DLFVBQVUsSUFBSTtFQUNsRCxDQUFDLENBQUMsQ0FBQztFQUNIb0MsTUFBTSxDQUFDYSxJQUFJLENBQUMsQ0FBQ0MsQ0FBQyxFQUFFQyxDQUFDLEtBQUs7SUFDcEIsTUFBTU8sRUFBRSxHQUFHUixDQUFDLENBQUNQLElBQUksS0FBS2MsVUFBVSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUM7SUFDekMsTUFBTUUsRUFBRSxHQUFHUixDQUFDLENBQUNSLElBQUksS0FBS2MsVUFBVSxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUM7SUFDekMsT0FBT0MsRUFBRSxHQUFHQyxFQUFFLElBQUlwRSxjQUFjLENBQUM0RCxDQUFDLENBQUMsR0FBRzVELGNBQWMsQ0FBQzJELENBQUMsQ0FBQztFQUN6RCxDQUFDLENBQUM7RUFDRixJQUFJLENBQUN2RSx3QkFBd0IsQ0FBQyxJQUFJLENBQUMsRUFBRTtJQUNuQyxNQUFNaUYsU0FBUyxHQUFHeEIsTUFBTSxDQUFDLENBQUMsQ0FBQztJQUMzQixPQUFPO01BQ0xKLEdBQUcsRUFBRTRCLFNBQVMsQ0FBQzVCLEdBQUc7TUFDbEJ6QixHQUFHLEVBQUVxRCxTQUFTLENBQUNyRCxHQUFHO01BQ2xCb0MsSUFBSSxFQUFFaUIsU0FBUyxDQUFDakIsSUFBSSxJQUFJYyxVQUFVO01BQ2xDM0UsSUFBSSxFQUFFOEUsU0FBUyxDQUFDOUUsSUFBSSxJQUFJLElBQUk7TUFDNUJjLE1BQU0sRUFBRWdFLFNBQVMsQ0FBQ2hFLE1BQU0sSUFBSSxFQUFFO01BQzlCRSxHQUFHLEVBQUU4RCxTQUFTLENBQUM5RCxHQUFHLElBQUksRUFBRTtNQUN4QkUsVUFBVSxFQUFFNEQsU0FBUyxDQUFDNUQsVUFBVSxJQUFJO0lBQ3RDLENBQUM7RUFDSDtFQUNBLEtBQUssTUFBTXNDLEtBQUssSUFBSUYsTUFBTSxFQUFFO0lBQzFCLE1BQU15QixJQUFJLEdBQUd2QixLQUFLLENBQUNOLEdBQUc7SUFDdEIsSUFBSVosSUFBSSxDQUFDbUMsc0JBQXNCLENBQUNFLFVBQVUsRUFBRUksSUFBSSxDQUFDLEVBQUU7TUFDakQsT0FBTztRQUNMN0IsR0FBRyxFQUFFNkIsSUFBSTtRQUNUdEQsR0FBRyxFQUFFK0IsS0FBSyxDQUFDL0IsR0FBRztRQUNkb0MsSUFBSSxFQUFFYyxVQUFVO1FBQ2hCM0UsSUFBSSxFQUFFd0QsS0FBSyxDQUFDeEQsSUFBSSxJQUFJLElBQUk7UUFDeEJjLE1BQU0sRUFBRTBDLEtBQUssQ0FBQzFDLE1BQU0sSUFBSSxFQUFFO1FBQzFCRSxHQUFHLEVBQUV3QyxLQUFLLENBQUN4QyxHQUFHLElBQUksRUFBRTtRQUNwQkUsVUFBVSxFQUFFc0MsS0FBSyxDQUFDdEMsVUFBVSxJQUFJO01BQ2xDLENBQUM7SUFDSDtFQUNGO0VBQ0EsTUFBTSxJQUFJdkIsa0JBQU0sQ0FBQ2dELGlCQUFpQixDQUFDLGNBQWNnQyxVQUFVLGtCQUFrQixDQUFDO0FBQ2hGLENBQUM7QUFFRHBGLFFBQVEsQ0FBQ29DLHVCQUF1QixHQUFHLFVBQVVGLEdBQUcsRUFBRTtFQUNoRCxNQUFNYSxJQUFJLEdBQUc5QyxPQUFPLENBQUMsSUFBSSxDQUFDO0VBQzFCLE1BQU1vRCxXQUFXLEdBQUdOLElBQUksQ0FBQ08scUJBQXFCLENBQUMsQ0FBQztFQUNoRCxNQUFNQyxHQUFHLEdBQUcsSUFBSUMsaUJBQUcsQ0FBQyxDQUFDLENBQUNDLGVBQWUsQ0FBQ0osV0FBVyxDQUFDO0VBQ2xELE1BQU1LLEtBQUssR0FBRyxhQUFheEIsR0FBRyw0QkFBNEI7RUFDMUQsTUFBTTJCLEtBQUssR0FBRyxJQUFBQyxjQUFNLEVBQUNQLEdBQUcsRUFBRUcsS0FBSyxDQUFDO0VBQ2hDLElBQUksQ0FBQ0csS0FBSyxJQUFJQSxLQUFLLENBQUM5RCxNQUFNLEtBQUssQ0FBQyxFQUFFO0lBQ2hDLE1BQU0sSUFBSUssa0JBQU0sQ0FBQ2dELGlCQUFpQixDQUFDLGtCQUFrQmxCLEdBQUcsa0JBQWtCLENBQUM7RUFDN0U7RUFDQSxJQUFJNkIsTUFBTSxHQUFHLEVBQUU7RUFDZixLQUFLLE1BQU0wQixXQUFXLElBQUk1QixLQUFLLEVBQUU7SUFDL0IsTUFBTUssS0FBSyxHQUFHQyxLQUFLLENBQUNDLElBQUksQ0FBQ3FCLFdBQVcsQ0FBQ3pCLFVBQVUsQ0FBQztJQUNoRCxNQUFNQyxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2hCLEtBQUssTUFBTUksSUFBSSxJQUFJSCxLQUFLLEVBQUU7TUFDeEJELEtBQUssQ0FBQ0ksSUFBSSxDQUFDQyxJQUFJLENBQUMsR0FBR0QsSUFBSSxDQUFDRyxLQUFLO0lBQy9CO0lBQ0FULE1BQU0sQ0FBQ1UsSUFBSSxDQUFDUixLQUFLLENBQUM7RUFDcEI7RUFDQUYsTUFBTSxHQUFHQSxNQUFNLENBQUNwRSxHQUFHLENBQUUrRSxDQUFDLEtBQU07SUFDMUIsR0FBR0EsQ0FBQztJQUNKZixHQUFHLEVBQUUvRCxNQUFNLENBQUNxQixRQUFRLENBQUN5RCxDQUFDLENBQUNmLEdBQUcsRUFBRSxFQUFFLENBQUM7SUFDL0J6QixHQUFHLEVBQUV0QyxNQUFNLENBQUNxQixRQUFRLENBQUN5RCxDQUFDLENBQUN4QyxHQUFHLEVBQUUsRUFBRSxDQUFDO0lBQy9CekIsSUFBSSxFQUFFRCxTQUFTLENBQUNrRSxDQUFDLENBQUNqRSxJQUFJLENBQUM7SUFDdkJjLE1BQU0sRUFBRW1ELENBQUMsQ0FBQ25ELE1BQU0sSUFBSSxFQUFFO0lBQ3RCRSxHQUFHLEVBQUVpRCxDQUFDLENBQUNqRCxHQUFHLElBQUksRUFBRTtJQUNoQkUsVUFBVSxFQUFFK0MsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxJQUFJQSxDQUFDLENBQUMvQyxVQUFVLElBQUk7RUFDbEQsQ0FBQyxDQUFDLENBQUMsQ0FBQzlCLE1BQU0sQ0FBRTZFLENBQUMsSUFBS0EsQ0FBQyxDQUFDZixHQUFHLElBQUllLENBQUMsQ0FBQ3hDLEdBQUcsQ0FBQztFQUNqQyxJQUFJNkIsTUFBTSxDQUFDaEUsTUFBTSxLQUFLLENBQUMsRUFBRTtJQUN2QixNQUFNLElBQUlLLGtCQUFNLENBQUNnRCxpQkFBaUIsQ0FBQyxrQkFBa0JsQixHQUFHLGtCQUFrQixDQUFDO0VBQzdFO0VBQ0E2QixNQUFNLENBQUNhLElBQUksQ0FBQyxDQUFDQyxDQUFDLEVBQUVDLENBQUMsS0FBSzVELGNBQWMsQ0FBQzRELENBQUMsQ0FBQyxHQUFHNUQsY0FBYyxDQUFDMkQsQ0FBQyxDQUFDLENBQUM7RUFDNUQsTUFBTTFELElBQUksR0FBRzRDLE1BQU0sQ0FBQyxDQUFDLENBQUM7RUFDdEIsSUFBSSxDQUFDNUMsSUFBSSxDQUFDd0MsR0FBRyxJQUFJLENBQUN4QyxJQUFJLENBQUNlLEdBQUcsRUFBRTtJQUMxQixNQUFNLElBQUk5QixrQkFBTSxDQUFDZ0QsaUJBQWlCLENBQUMsa0JBQWtCbEIsR0FBRyxrQkFBa0IsQ0FBQztFQUM3RTtFQUNBLElBQUksQ0FBQzVCLHdCQUF3QixDQUFDLElBQUksQ0FBQyxFQUFFO0lBQ25DLE9BQU87TUFDTHFELEdBQUcsRUFBRXhDLElBQUksQ0FBQ3dDLEdBQUc7TUFDYnpCLEdBQUcsRUFBRWYsSUFBSSxDQUFDZSxHQUFHO01BQ2JvQyxJQUFJLEVBQUVuRCxJQUFJLENBQUNtRCxJQUFJO01BQ2Y3RCxJQUFJLEVBQUVVLElBQUksQ0FBQ1YsSUFBSSxJQUFJLElBQUk7TUFDdkJjLE1BQU0sRUFBRUosSUFBSSxDQUFDSSxNQUFNLElBQUksRUFBRTtNQUN6QkUsR0FBRyxFQUFFTixJQUFJLENBQUNNLEdBQUcsSUFBSSxFQUFFO01BQ25CRSxVQUFVLEVBQUVSLElBQUksQ0FBQ1EsVUFBVSxJQUFJO0lBQ2pDLENBQUM7RUFDSDtFQUNBLElBQUlSLElBQUksQ0FBQ21ELElBQUksSUFBSSxDQUFDdkIsSUFBSSxDQUFDbUMsc0JBQXNCLENBQUMvRCxJQUFJLENBQUNtRCxJQUFJLEVBQUVuRCxJQUFJLENBQUN3QyxHQUFHLENBQUMsRUFBRTtJQUNsRSxNQUFNLElBQUl2RCxrQkFBTSxDQUFDZ0QsaUJBQWlCLENBQUMsa0JBQWtCbEIsR0FBRyxrQkFBa0IsQ0FBQztFQUM3RTtFQUNBLE9BQU87SUFDTHlCLEdBQUcsRUFBRXhDLElBQUksQ0FBQ3dDLEdBQUc7SUFDYnpCLEdBQUcsRUFBRWYsSUFBSSxDQUFDZSxHQUFHO0lBQ2JvQyxJQUFJLEVBQUVuRCxJQUFJLENBQUNtRCxJQUFJO0lBQ2Y3RCxJQUFJLEVBQUVVLElBQUksQ0FBQ1YsSUFBSSxJQUFJLElBQUk7SUFDdkJjLE1BQU0sRUFBRUosSUFBSSxDQUFDSSxNQUFNLElBQUksRUFBRTtJQUN6QkUsR0FBRyxFQUFFTixJQUFJLENBQUNNLEdBQUcsSUFBSSxFQUFFO0lBQ25CRSxVQUFVLEVBQUVSLElBQUksQ0FBQ1EsVUFBVSxJQUFJO0VBQ2pDLENBQUM7QUFDSCxDQUFDO0FBRUQsU0FBUytELFlBQVlBLENBQUVwQixJQUFJLEVBQUU7RUFDM0IsSUFBSSxDQUFDQSxJQUFJLEVBQUU7SUFDVCxPQUFPQSxJQUFJO0VBQ2I7RUFDQSxLQUFLLElBQUlxQixDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUdyQixJQUFJLENBQUN2RSxNQUFNLEVBQUUsRUFBRTRGLENBQUMsRUFBRTtJQUNwQyxJQUFJckIsSUFBSSxDQUFDcUIsQ0FBQyxDQUFDLEdBQUcsR0FBRyxJQUFJckIsSUFBSSxDQUFDcUIsQ0FBQyxDQUFDLEdBQUcsR0FBRyxFQUFFO01BQ2xDLE9BQU9yQixJQUFJO0lBQ2I7RUFDRjtFQUNBLE9BQU8sSUFBSTtBQUNiO0FBRUEsU0FBU3NCLGNBQWNBLENBQUVuRCxNQUFNLEVBQUU7RUFDL0IsSUFBSSxDQUFDQSxNQUFNLEVBQUU7SUFDWCxPQUFPQSxNQUFNO0VBQ2Y7RUFDQSxLQUFLLElBQUlrRCxDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUdsRCxNQUFNLENBQUMxQyxNQUFNLEVBQUUsRUFBRTRGLENBQUMsRUFBRTtJQUN0QyxJQUFJbEQsTUFBTSxDQUFDa0QsQ0FBQyxDQUFDLEdBQUcsR0FBRyxJQUFJbEQsTUFBTSxDQUFDa0QsQ0FBQyxDQUFDLEdBQUcsR0FBRyxFQUFFO01BQ3RDLE9BQU8sSUFBSTtJQUNiO0VBQ0Y7RUFDQSxPQUFPbEQsTUFBTTtBQUNmO0FBRUF6QyxRQUFRLENBQUM2RixTQUFTLEdBQUcsU0FBU0EsU0FBU0EsQ0FBRXZCLElBQUksRUFBRTdCLE1BQU0sRUFBRTtFQUNyREEsTUFBTSxHQUFHbUQsY0FBYyxDQUFDbkQsTUFBTSxDQUFDO0VBQy9CNkIsSUFBSSxHQUFHb0IsWUFBWSxDQUFDcEIsSUFBSSxDQUFDO0VBQ3pCLElBQUlBLElBQUksRUFBRTtJQUNSLE1BQU01QixHQUFHLEdBQUcsSUFBSSxDQUFDeUMseUJBQXlCLENBQUNiLElBQUksQ0FBQztJQUNoRCxJQUFJLENBQUN0QyxJQUFJLEdBQUdVLEdBQUc7RUFDakIsQ0FBQyxNQUFNLElBQUlELE1BQU0sRUFBRTtJQUNqQixNQUFNQyxHQUFHLEdBQUcsSUFBSSxDQUFDTix1QkFBdUIsQ0FBQ0ssTUFBTSxDQUFDO0lBQ2hELElBQUksQ0FBQ1QsSUFBSSxHQUFHVSxHQUFHO0VBQ2pCLENBQUMsTUFBTTtJQUNMLE1BQU0sSUFBSXRDLGtCQUFNLENBQUNDLFlBQVksQ0FBQyxtREFBbUQsQ0FBQztFQUNwRjtFQUNBLElBQUksQ0FBQ3lGLGlCQUFpQixHQUFHLENBQUM7RUFDMUIsSUFBSSxDQUFDQyxlQUFlLEdBQUcsQ0FBQztFQUN4QixJQUFJLENBQUM5RCxxQkFBcUIsR0FBRyxDQUFDO0VBQzlCLElBQUksQ0FBQ1ksb0JBQW9CLEdBQUcsQ0FBQztBQUMvQixDQUFDO0FBRUQ3QyxRQUFRLENBQUNnRyxhQUFhLEdBQUcsU0FBU0EsYUFBYUEsQ0FBQSxFQUFJO0VBQ2pELE1BQU1qRCxJQUFJLEdBQUc5QyxPQUFPLENBQUMsSUFBSSxDQUFDO0VBQzFCLE1BQU15QyxHQUFHLEdBQUcsSUFBSSxDQUFDVixJQUFJO0VBQ3JCLElBQUksQ0FBQ1UsR0FBRyxFQUFFO0lBQ1IsTUFBTSxJQUFJdEMsa0JBQU0sQ0FBQ2dELGlCQUFpQixDQUFDLHlCQUF5QixDQUFDO0VBQy9EO0VBQ0EsTUFBTTtJQUFDbEI7RUFBRyxDQUFDLEdBQUdRLEdBQUc7RUFDakIsT0FBT0ssSUFBSSxDQUFDa0QsY0FBYyxDQUFDL0QsR0FBRyxDQUFDO0FBQ2pDLENBQUM7QUFBQyxJQUFBZ0UsUUFBQSxHQUFBQyxPQUFBLENBQUFDLE9BQUEsR0FFYXBHLFFBQVEiLCJpZ25vcmVMaXN0IjpbXX0=
