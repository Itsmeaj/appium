"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.commands = void 0;
require("source-map-support/register");
var _driver = require("appium/driver");
var _xpath = _interopRequireDefault(require("xpath.js"));
var _xmldom = require("@xmldom/xmldom");
var _uuid = require("uuid");
const commands = exports.commands = {};
const HANDLE_SCOPED_WINDOW_TOKENS = ['dialog', 'alert', 'modal', 'notification', 'popover', 'popup', 'tooltip'];
function getApis(ctx) {
  if (!(ctx !== null && ctx !== void 0 && ctx._backendApis)) {
    throw new _driver.errors.UnknownError('Linux backend is not initialized');
  }
  return ctx._backendApis;
}
function selectorTargetsTransientWindow(strategy, selector) {
  if (`${strategy !== null && strategy !== void 0 ? strategy : ''}` !== 'xpath') {
    return false;
  }
  const normalized = `${selector !== null && selector !== void 0 ? selector : ''}`.toLowerCase();
  if (!normalized) {
    return false;
  }
  return HANDLE_SCOPED_WINDOW_TOKENS.some(token => normalized.includes(`//${token}`) || normalized.includes(`::${token}`));
}
function shouldPreferHandleScopedHierarchy(ctx, strategy, selector) {
  var _ctx$_win$tag, _ctx$_win, _ctx$_win$windowType, _ctx$_win2;
  if ((ctx === null || ctx === void 0 ? void 0 : ctx.linuxBackend) !== 'wayland') {
    return false;
  }
  const tag = `${(_ctx$_win$tag = ctx === null || ctx === void 0 ? void 0 : (_ctx$_win = ctx._win) === null || _ctx$_win === void 0 ? void 0 : _ctx$_win.tag) !== null && _ctx$_win$tag !== void 0 ? _ctx$_win$tag : ''}`.toLowerCase();
  const windowType = `${(_ctx$_win$windowType = ctx === null || ctx === void 0 ? void 0 : (_ctx$_win2 = ctx._win) === null || _ctx$_win2 === void 0 ? void 0 : _ctx$_win2.windowType) !== null && _ctx$_win$windowType !== void 0 ? _ctx$_win$windowType : ''}`.toLowerCase();
  if (HANDLE_SCOPED_WINDOW_TOKENS.some(token => tag.includes(token) || windowType.includes(token))) {
    return true;
  }
  return selectorTargetsTransientWindow(strategy, selector);
}
function toXPathLiteral(value) {
  const stringValue = `${value}`;
  if (!stringValue.includes('"')) {
    return `"${stringValue}"`;
  }
  if (!stringValue.includes('\'')) {
    return `'${stringValue}'`;
  }
  const parts = stringValue.split('"');
  const xpathParts = [];
  for (let i = 0; i < parts.length; i++) {
    xpathParts.push(`"${parts[i]}"`);
    if (i < parts.length - 1) {
      xpathParts.push(`'"'`);
    }
  }
  return `concat(${xpathParts.join(', ')})`;
}
function classTokenExpr(token) {
  return `contains(concat(" ", normalize-space(@class), " "), ${toXPathLiteral(` ${token} `)})`;
}
function createInvalidSelectorError(message) {
  if (_driver.errors.InvalidSelectorError) {
    return new _driver.errors.InvalidSelectorError(message);
  }
  return new _driver.errors.UnknownError(message);
}
function parseCssStep(step) {
  const result = {
    tag: '*',
    id: null,
    classes: [],
    attrs: []
  };
  let remaining = step.trim();
  if (!remaining) {
    throw new Error('Empty CSS selector step');
  }
  if (/[>+~,]/.test(remaining)) {
    throw new Error('Only descendant combinator is supported for css selector');
  }
  const tagMatch = /^([a-zA-Z_][\w-]*|\*)/.exec(remaining);
  if (tagMatch) {
    result.tag = tagMatch[1];
    remaining = remaining.slice(tagMatch[0].length);
  }
  while (remaining.length > 0) {
    if (remaining[0] === '#') {
      const idMatch = /^#([a-zA-Z_][\w-]*)/.exec(remaining);
      if (!idMatch) {
        throw new Error(`Malformed id selector segment in '${step}'`);
      }
      result.id = idMatch[1];
      remaining = remaining.slice(idMatch[0].length);
      continue;
    }
    if (remaining[0] === '.') {
      const classMatch = /^\.([a-zA-Z_][\w-]*)/.exec(remaining);
      if (!classMatch) {
        throw new Error(`Malformed class selector segment in '${step}'`);
      }
      result.classes.push(classMatch[1]);
      remaining = remaining.slice(classMatch[0].length);
      continue;
    }
    if (remaining[0] === '[') {
      var _ref;
      const attrMatch = /^\[\s*([^\]=~^$*|\s]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(remaining);
      if (!attrMatch) {
        throw new Error(`Malformed attribute selector segment in '${step}'`);
      }
      const [, name, doubleQuotedValue, singleQuotedValue, bareValue] = attrMatch;
      const value = (_ref = doubleQuotedValue !== null && doubleQuotedValue !== void 0 ? doubleQuotedValue : singleQuotedValue) !== null && _ref !== void 0 ? _ref : bareValue;
      result.attrs.push({
        name,
        value
      });
      remaining = remaining.slice(attrMatch[0].length);
      continue;
    }
    throw new Error(`Unsupported css selector segment '${remaining}'`);
  }
  return result;
}
function splitCssSelector(selector) {
  const parts = [];
  let current = '';
  let quote = null;
  let bracketDepth = 0;
  for (const ch of selector.trim()) {
    if (quote) {
      current += ch;
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '[') {
      bracketDepth += 1;
      current += ch;
      continue;
    }
    if (ch === ']') {
      bracketDepth -= 1;
      current += ch;
      continue;
    }
    if (/\s/.test(ch) && bracketDepth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  if (parts.length === 0) {
    throw new Error('Empty css selector');
  }
  return parts;
}
function cssSelectorToXpath(selector) {
  const steps = splitCssSelector(`${selector}`);
  const xpathSteps = steps.map(step => {
    const parsed = parseCssStep(step);
    const predicates = [];
    if (parsed.tag !== '*') {
      const tagLiteral = toXPathLiteral(parsed.tag);
      predicates.push(`(name()=${tagLiteral} or @tag=${tagLiteral})`);
    }
    if (parsed.id) {
      predicates.push(`@id=${toXPathLiteral(parsed.id)}`);
    }
    for (const cls of parsed.classes) {
      predicates.push(classTokenExpr(cls));
    }
    for (const attr of parsed.attrs) {
      if (attr.value === undefined) {
        predicates.push(`@${attr.name}`);
      } else {
        predicates.push(`@${attr.name}=${toXPathLiteral(attr.value)}`);
      }
    }
    return predicates.length > 0 ? `*[${predicates.join(' and ')}]` : '*';
  });
  return `//${xpathSteps.join('//')}`;
}
function buildXpathFromStrategy(strategy, selector) {
  const strSelector = `${selector}`;
  const selectorLiteral = toXPathLiteral(strSelector);
  switch (strategy) {
    case 'name':
      return `//*[@name=${selectorLiteral}]`;
    case 'class name':
      return `//*[${classTokenExpr(strSelector)}]`;
    case 'id':
      return `//*[@id=${selectorLiteral}]`;
    case 'accessibility id':
      return `//*[@name=${selectorLiteral} or @label=${selectorLiteral} or @accessibility-id=${selectorLiteral}]`;
    case 'tag name':
      return `//*[name()=${selectorLiteral} or @tag=${selectorLiteral}]`;
    case 'link text':
      return `//*[(name()="a" or @tag="a") and (@name=${selectorLiteral} or @text=${selectorLiteral} or normalize-space(.)=${selectorLiteral})]`;
    case 'partial link text':
      return `//*[(name()="a" or @tag="a") and (contains(@name, ${selectorLiteral}) or contains(@text, ${selectorLiteral}) or contains(normalize-space(.), ${selectorLiteral}))]`;
    case 'css selector':
      return cssSelectorToXpath(strSelector);
    case 'xpath':
      return strSelector;
    default:
      throw createInvalidSelectorError(`Unsupported locator strategy '${strategy}'`);
  }
}
function parseRect(value) {
  const match = /^\[(?<x>-?\d+),(?<y>-?\d+),(?<width>\d+),(?<height>\d+)\]$/.exec(`${value !== null && value !== void 0 ? value : ''}`);
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
function nodePriorityScore(node) {
  var _attrs$states;
  if (!(node !== null && node !== void 0 && node.attributes)) {
    return Number.NEGATIVE_INFINITY;
  }
  const attrs = {};
  for (const attr of Array.from(node.attributes)) {
    attrs[attr.name] = attr.value;
  }
  const states = `${(_attrs$states = attrs.states) !== null && _attrs$states !== void 0 ? _attrs$states : ''}`.toUpperCase();
  let score = 0;
  if (states.includes('SHOWING') || states.includes('VISIBLE')) {
    score += 200;
  }
  if (states.includes('ENABLED') || states.includes('SENSITIVE')) {
    score += 40;
  }
  if (states.includes('FOCUSED') || states.includes('ACTIVE')) {
    score += 25;
  }
  const rect = parseRect(attrs.rect);
  if (rect && rect.width > 0 && rect.height > 0) {
    score += Math.min(rect.width * rect.height, 4000000) / 10000;
    if (rect.x < -1000000 || rect.y < -1000000) {
      score -= 500;
    }
  } else {
    score -= 60;
  }
  return score;
}
function getWindowScopedHierarchy(ctx, apis, strategy, selector) {
  const {
    pid,
    name,
    wid
  } = ctx._win;
  let hierarchy = null;
  if (shouldPreferHandleScopedHierarchy(ctx, strategy, selector)) {
    hierarchy = apis.a11y_getWindowUiHierachy(name, pid);
    if ((!hierarchy || !`${hierarchy}`.trim()) && typeof apis.a11y_getWindowUiHierachyByHandle === 'function') {
      hierarchy = apis.a11y_getWindowUiHierachyByHandle(wid, pid, name);
    }
  } else {
    hierarchy = apis.a11y_getWindowUiHierachy(name, pid);
    if ((!hierarchy || !`${hierarchy}`.trim()) && ctx.linuxBackend === 'wayland') {
      if (typeof apis.a11y_getWindowUiHierachyByHandle === 'function') {
        hierarchy = apis.a11y_getWindowUiHierachyByHandle(wid, pid, name);
      }
    }
  }
  if ((!hierarchy || !`${hierarchy}`.trim()) && ctx.linuxBackend === 'wayland') {
    if (typeof apis.a11y_getDesktopUiHierachy === 'function') {
      hierarchy = apis.a11y_getDesktopUiHierachy();
    }
  }
  if (!hierarchy || !`${hierarchy}`.trim()) {
    throw new _driver.errors.NoSuchWindowError(`the selected window doesn't exist (wid=${wid}, pid=${pid}, name=${name})`);
  }
  return hierarchy;
}
commands._validateOrUpdateWinInfo = function () {
  const now = Date.now();
  if (this._winValidatedAt && now - this._winValidatedAt < 5000) {
    return true;
  }
  const apis = getApis(this);
  const {
    pid,
    wid,
    name
  } = this._win;
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new _xmldom.DOMParser().parseFromString(winHierachy);
  const nameLiteral = toXPathLiteral(name);
  let xpath = `//*[@pid="${pid}" and @wid="${wid}" and @InputOutput="true" and (@name=${nameLiteral} or ${classTokenExpr(name)})]`;
  const nodes = (0, _xpath.default)(doc, xpath);
  if (nodes && nodes.length > 0) {
    this._winValidatedAt = now;
    return true;
  }
  try {
    const win = this._getWinAndPid_FromWinId(wid);
    this._win = win;
  } catch {
    if (this.linuxBackend === 'wayland' && typeof this._resolveBestAvailableWindow === 'function') {
      return !!this._resolveBestAvailableWindow();
    }
    return false;
  }
  this._winValidatedAt = now;
  return true;
};
commands.findElOrEls = function findElOrEls(strategy, selector, mult, context) {
  const apis = getApis(this);
  let a11yHierachy = null;
  if (!context) {
    var _this$_win;
    const now = Date.now();
    const currentWid = (_this$_win = this._win) === null || _this$_win === void 0 ? void 0 : _this$_win.wid;
    const windowChanged = currentWid && currentWid !== this._lastFindWid;
    if (windowChanged || !this._lastCacheClearAt || now - this._lastCacheClearAt >= 2000) {
      apis.a11y_clear_cache();
      this._lastCacheClearAt = now;
    }
    this._lastFindWid = currentWid;
    if (!this._validateOrUpdateWinInfo()) {
      throw new _driver.errors.NoSuchWindowError(`the selected window doesn't exist`);
    }
    a11yHierachy = getWindowScopedHierarchy(this, apis, strategy, selector);
  } else {
    a11yHierachy = this._cache.get(context);
    if (!a11yHierachy) {
      throw new _driver.errors.UnknownError(`context ${context} has expired`);
    }
  }
  const doc = new _xmldom.DOMParser().parseFromString(a11yHierachy);
  const xpath = buildXpathFromStrategy(strategy, selector);
  let nodes = [];
  try {
    nodes = (0, _xpath.default)(doc, xpath);
  } catch (error) {
    throw createInvalidSelectorError(`Could not locate element by strategy '${strategy}' with selector '${selector}'. ` + `XPath was '${xpath}'. Original error: ${error.message}`);
  }
  if (!nodes || nodes.length === 0) {
    nodes = [];
    if (!context && this.linuxBackend === 'wayland') {
      try {
        let _desktopXml = apis.a11y_getDesktopUiHierachy();
        if (_desktopXml && `${_desktopXml}`.trim()) {
          const _dd = new _xmldom.DOMParser().parseFromString(_desktopXml);
          const _dn = (0, _xpath.default)(_dd, xpath);
          if (_dn && _dn.length > 0) {
            nodes = _dn;
          }
        }
        if (nodes.length === 0) {
          const _now = Date.now();
          const _cacheTs = apis._desktopHierarchyCacheAt || 0;
          const _uiTs = this._lastUiActionAt || 0;
          const _lastForce = this._lastDesktopForceScanAt || 0;
          if (_uiTs > _cacheTs && _now - _lastForce >= 3000) {
            this._lastDesktopForceScanAt = _now;
            if (typeof apis._invalidateDesktopHierarchyCache === 'function') {
              apis._invalidateDesktopHierarchyCache();
            }
            _desktopXml = apis.a11y_getDesktopUiHierachy();
            if (_desktopXml && `${_desktopXml}`.trim()) {
              const _dd2 = new _xmldom.DOMParser().parseFromString(_desktopXml);
              const _dn2 = (0, _xpath.default)(_dd2, xpath);
              if (_dn2 && _dn2.length > 0) {
                nodes = _dn2;
              }
            }
          }
        }
      } catch {}
    }
  }
  if (nodes.length > 1) {
    nodes = [...nodes].sort((a, b) => nodePriorityScore(b) - nodePriorityScore(a));
  }
  const serializer = new _xmldom.XMLSerializer();
  if (mult) {
    let elements = [];
    for (const node of nodes) {
      const str = serializer.serializeToString(node);
      const key = (0, _uuid.v4)();
      this._cache.set(key, str);
      elements.push({
        'element-6066-11e4-a52e-4f735466cecf': key,
        'ELEMENT': key
      });
    }
    return elements;
  } else {
    if (nodes.length === 0) {
      throw new _driver.errors.NoSuchElementError();
    }
    const node = nodes[0];
    const str = serializer.serializeToString(node);
    const key = (0, _uuid.v4)();
    this._cache.set(key, str);
    return {
      'element-6066-11e4-a52e-4f735466cecf': key,
      'ELEMENT': key
    };
  }
};
var _default = exports.default = commands;require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2NvbW1hbmRzL2ZpbmQuanMiLCJuYW1lcyI6WyJfZHJpdmVyIiwicmVxdWlyZSIsIl94cGF0aCIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJfeG1sZG9tIiwiX3V1aWQiLCJjb21tYW5kcyIsImV4cG9ydHMiLCJIQU5ETEVfU0NPUEVEX1dJTkRPV19UT0tFTlMiLCJnZXRBcGlzIiwiY3R4IiwiX2JhY2tlbmRBcGlzIiwiZXJyb3JzIiwiVW5rbm93bkVycm9yIiwic2VsZWN0b3JUYXJnZXRzVHJhbnNpZW50V2luZG93Iiwic3RyYXRlZ3kiLCJzZWxlY3RvciIsIm5vcm1hbGl6ZWQiLCJ0b0xvd2VyQ2FzZSIsInNvbWUiLCJ0b2tlbiIsImluY2x1ZGVzIiwic2hvdWxkUHJlZmVySGFuZGxlU2NvcGVkSGllcmFyY2h5IiwiX2N0eCRfd2luJHRhZyIsIl9jdHgkX3dpbiIsIl9jdHgkX3dpbiR3aW5kb3dUeXBlIiwiX2N0eCRfd2luMiIsImxpbnV4QmFja2VuZCIsInRhZyIsIl93aW4iLCJ3aW5kb3dUeXBlIiwidG9YUGF0aExpdGVyYWwiLCJ2YWx1ZSIsInN0cmluZ1ZhbHVlIiwicGFydHMiLCJzcGxpdCIsInhwYXRoUGFydHMiLCJpIiwibGVuZ3RoIiwicHVzaCIsImpvaW4iLCJjbGFzc1Rva2VuRXhwciIsImNyZWF0ZUludmFsaWRTZWxlY3RvckVycm9yIiwibWVzc2FnZSIsIkludmFsaWRTZWxlY3RvckVycm9yIiwicGFyc2VDc3NTdGVwIiwic3RlcCIsInJlc3VsdCIsImlkIiwiY2xhc3NlcyIsImF0dHJzIiwicmVtYWluaW5nIiwidHJpbSIsIkVycm9yIiwidGVzdCIsInRhZ01hdGNoIiwiZXhlYyIsInNsaWNlIiwiaWRNYXRjaCIsImNsYXNzTWF0Y2giLCJfcmVmIiwiYXR0ck1hdGNoIiwibmFtZSIsImRvdWJsZVF1b3RlZFZhbHVlIiwic2luZ2xlUXVvdGVkVmFsdWUiLCJiYXJlVmFsdWUiLCJzcGxpdENzc1NlbGVjdG9yIiwiY3VycmVudCIsInF1b3RlIiwiYnJhY2tldERlcHRoIiwiY2giLCJjc3NTZWxlY3RvclRvWHBhdGgiLCJzdGVwcyIsInhwYXRoU3RlcHMiLCJtYXAiLCJwYXJzZWQiLCJwcmVkaWNhdGVzIiwidGFnTGl0ZXJhbCIsImNscyIsImF0dHIiLCJ1bmRlZmluZWQiLCJidWlsZFhwYXRoRnJvbVN0cmF0ZWd5Iiwic3RyU2VsZWN0b3IiLCJzZWxlY3RvckxpdGVyYWwiLCJwYXJzZVJlY3QiLCJtYXRjaCIsIngiLCJ5Iiwid2lkdGgiLCJoZWlnaHQiLCJncm91cHMiLCJOdW1iZXIiLCJwYXJzZUludCIsIm5vZGVQcmlvcml0eVNjb3JlIiwibm9kZSIsIl9hdHRycyRzdGF0ZXMiLCJhdHRyaWJ1dGVzIiwiTkVHQVRJVkVfSU5GSU5JVFkiLCJBcnJheSIsImZyb20iLCJzdGF0ZXMiLCJ0b1VwcGVyQ2FzZSIsInNjb3JlIiwicmVjdCIsIk1hdGgiLCJtaW4iLCJnZXRXaW5kb3dTY29wZWRIaWVyYXJjaHkiLCJhcGlzIiwicGlkIiwid2lkIiwiaGllcmFyY2h5IiwiYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5IiwiYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5QnlIYW5kbGUiLCJhMTF5X2dldERlc2t0b3BVaUhpZXJhY2h5IiwiTm9TdWNoV2luZG93RXJyb3IiLCJfdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8iLCJub3ciLCJEYXRlIiwiX3dpblZhbGlkYXRlZEF0Iiwid2luSGllcmFjaHkiLCJhcHBfZ2V0V2luZG93SGllcmFjaHkiLCJkb2MiLCJkb20iLCJwYXJzZUZyb21TdHJpbmciLCJuYW1lTGl0ZXJhbCIsInhwYXRoIiwibm9kZXMiLCJzZWxlY3QiLCJ3aW4iLCJfZ2V0V2luQW5kUGlkX0Zyb21XaW5JZCIsIl9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdyIsImZpbmRFbE9yRWxzIiwibXVsdCIsImNvbnRleHQiLCJhMTF5SGllcmFjaHkiLCJfdGhpcyRfd2luIiwiY3VycmVudFdpZCIsIndpbmRvd0NoYW5nZWQiLCJfbGFzdEZpbmRXaWQiLCJfbGFzdENhY2hlQ2xlYXJBdCIsImExMXlfY2xlYXJfY2FjaGUiLCJfY2FjaGUiLCJnZXQiLCJlcnJvciIsIl9kZXNrdG9wWG1sIiwiX2RkIiwiX2RuIiwiX25vdyIsIl9jYWNoZVRzIiwiX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0IiwiX3VpVHMiLCJfbGFzdFVpQWN0aW9uQXQiLCJfbGFzdEZvcmNlIiwiX2xhc3REZXNrdG9wRm9yY2VTY2FuQXQiLCJfaW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSIsIl9kZDIiLCJfZG4yIiwic29ydCIsImEiLCJiIiwic2VyaWFsaXplciIsIlhNTFNlcmlhbGl6ZXIiLCJlbGVtZW50cyIsInN0ciIsInNlcmlhbGl6ZVRvU3RyaW5nIiwia2V5IiwidXVpZHY0Iiwic2V0IiwiTm9TdWNoRWxlbWVudEVycm9yIiwiX2RlZmF1bHQiLCJkZWZhdWx0Il0sInNvdXJjZVJvb3QiOiIuLi8uLi8uLiIsInNvdXJjZXMiOlsibGliL2NvbW1hbmRzL2ZpbmQuanMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgZXJyb3JzIH0gZnJvbSAnYXBwaXVtL2RyaXZlcic7XG5pbXBvcnQgc2VsZWN0IGZyb20gJ3hwYXRoLmpzJztcbmltcG9ydCB7IERPTVBhcnNlciBhcyBkb20sIFhNTFNlcmlhbGl6ZXIgfSBmcm9tICdAeG1sZG9tL3htbGRvbSc7XG5pbXBvcnQgeyB2NCBhcyB1dWlkdjQgfSBmcm9tICd1dWlkJztcblxuY29uc3QgY29tbWFuZHMgPSB7fTtcbmNvbnN0IEhBTkRMRV9TQ09QRURfV0lORE9XX1RPS0VOUyA9IFsnZGlhbG9nJywgJ2FsZXJ0JywgJ21vZGFsJywgJ25vdGlmaWNhdGlvbicsICdwb3BvdmVyJywgJ3BvcHVwJywgJ3Rvb2x0aXAnXTtcbmZ1bmN0aW9uIGdldEFwaXMgKGN0eCkge1xuICBpZiAoIWN0eD8uX2JhY2tlbmRBcGlzKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoJ0xpbnV4IGJhY2tlbmQgaXMgbm90IGluaXRpYWxpemVkJyk7XG4gIH1cbiAgcmV0dXJuIGN0eC5fYmFja2VuZEFwaXM7XG59XG5cbmZ1bmN0aW9uIHNlbGVjdG9yVGFyZ2V0c1RyYW5zaWVudFdpbmRvdyAoc3RyYXRlZ3ksIHNlbGVjdG9yKSB7XG4gIGlmIChgJHtzdHJhdGVneSA/PyAnJ31gICE9PSAneHBhdGgnKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWQgPSBgJHtzZWxlY3RvciA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGlmICghbm9ybWFsaXplZCkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICByZXR1cm4gSEFORExFX1NDT1BFRF9XSU5ET1dfVE9LRU5TLnNvbWUoKHRva2VuKSA9PiBub3JtYWxpemVkLmluY2x1ZGVzKGAvLyR7dG9rZW59YCkgfHwgbm9ybWFsaXplZC5pbmNsdWRlcyhgOjoke3Rva2VufWApKTtcbn1cblxuZnVuY3Rpb24gc2hvdWxkUHJlZmVySGFuZGxlU2NvcGVkSGllcmFyY2h5IChjdHgsIHN0cmF0ZWd5LCBzZWxlY3Rvcikge1xuICBpZiAoY3R4Py5saW51eEJhY2tlbmQgIT09ICd3YXlsYW5kJykge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICBjb25zdCB0YWcgPSBgJHtjdHg/Ll93aW4/LnRhZyA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHdpbmRvd1R5cGUgPSBgJHtjdHg/Ll93aW4/LndpbmRvd1R5cGUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBpZiAoSEFORExFX1NDT1BFRF9XSU5ET1dfVE9LRU5TLnNvbWUoKHRva2VuKSA9PiB0YWcuaW5jbHVkZXModG9rZW4pIHx8IHdpbmRvd1R5cGUuaW5jbHVkZXModG9rZW4pKSkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIHJldHVybiBzZWxlY3RvclRhcmdldHNUcmFuc2llbnRXaW5kb3coc3RyYXRlZ3ksIHNlbGVjdG9yKTtcbn1cblxuZnVuY3Rpb24gdG9YUGF0aExpdGVyYWwgKHZhbHVlKSB7XG4gIGNvbnN0IHN0cmluZ1ZhbHVlID0gYCR7dmFsdWV9YDtcbiAgaWYgKCFzdHJpbmdWYWx1ZS5pbmNsdWRlcygnXCInKSkge1xuICAgIHJldHVybiBgXCIke3N0cmluZ1ZhbHVlfVwiYDtcbiAgfVxuICBpZiAoIXN0cmluZ1ZhbHVlLmluY2x1ZGVzKCdcXCcnKSkge1xuICAgIHJldHVybiBgJyR7c3RyaW5nVmFsdWV9J2A7XG4gIH1cbiAgY29uc3QgcGFydHMgPSBzdHJpbmdWYWx1ZS5zcGxpdCgnXCInKTtcbiAgY29uc3QgeHBhdGhQYXJ0cyA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHBhcnRzLmxlbmd0aDsgaSsrKSB7XG4gICAgeHBhdGhQYXJ0cy5wdXNoKGBcIiR7cGFydHNbaV19XCJgKTtcbiAgICBpZiAoaSA8IHBhcnRzLmxlbmd0aCAtIDEpIHtcbiAgICAgIHhwYXRoUGFydHMucHVzaChgJ1wiJ2ApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gYGNvbmNhdCgke3hwYXRoUGFydHMuam9pbignLCAnKX0pYDtcbn1cblxuZnVuY3Rpb24gY2xhc3NUb2tlbkV4cHIgKHRva2VuKSB7XG4gIHJldHVybiBgY29udGFpbnMoY29uY2F0KFwiIFwiLCBub3JtYWxpemUtc3BhY2UoQGNsYXNzKSwgXCIgXCIpLCAke3RvWFBhdGhMaXRlcmFsKGAgJHt0b2tlbn0gYCl9KWA7XG59XG5cbmZ1bmN0aW9uIGNyZWF0ZUludmFsaWRTZWxlY3RvckVycm9yIChtZXNzYWdlKSB7XG4gIGlmIChlcnJvcnMuSW52YWxpZFNlbGVjdG9yRXJyb3IpIHtcbiAgICByZXR1cm4gbmV3IGVycm9ycy5JbnZhbGlkU2VsZWN0b3JFcnJvcihtZXNzYWdlKTtcbiAgfVxuICByZXR1cm4gbmV3IGVycm9ycy5Vbmtub3duRXJyb3IobWVzc2FnZSk7XG59XG5cbmZ1bmN0aW9uIHBhcnNlQ3NzU3RlcCAoc3RlcCkge1xuICBjb25zdCByZXN1bHQgPSB7XG4gICAgdGFnOiAnKicsXG4gICAgaWQ6IG51bGwsXG4gICAgY2xhc3NlczogW10sXG4gICAgYXR0cnM6IFtdLFxuICB9O1xuICBsZXQgcmVtYWluaW5nID0gc3RlcC50cmltKCk7XG4gIGlmICghcmVtYWluaW5nKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdFbXB0eSBDU1Mgc2VsZWN0b3Igc3RlcCcpO1xuICB9XG4gIGlmICgvWz4rfixdLy50ZXN0KHJlbWFpbmluZykpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZGVzY2VuZGFudCBjb21iaW5hdG9yIGlzIHN1cHBvcnRlZCBmb3IgY3NzIHNlbGVjdG9yJyk7XG4gIH1cblxuICBjb25zdCB0YWdNYXRjaCA9IC9eKFthLXpBLVpfXVtcXHctXSp8XFwqKS8uZXhlYyhyZW1haW5pbmcpO1xuICBpZiAodGFnTWF0Y2gpIHtcbiAgICByZXN1bHQudGFnID0gdGFnTWF0Y2hbMV07XG4gICAgcmVtYWluaW5nID0gcmVtYWluaW5nLnNsaWNlKHRhZ01hdGNoWzBdLmxlbmd0aCk7XG4gIH1cblxuICB3aGlsZSAocmVtYWluaW5nLmxlbmd0aCA+IDApIHtcbiAgICBpZiAocmVtYWluaW5nWzBdID09PSAnIycpIHtcbiAgICAgIGNvbnN0IGlkTWF0Y2ggPSAvXiMoW2EtekEtWl9dW1xcdy1dKikvLmV4ZWMocmVtYWluaW5nKTtcbiAgICAgIGlmICghaWRNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1hbGZvcm1lZCBpZCBzZWxlY3RvciBzZWdtZW50IGluICcke3N0ZXB9J2ApO1xuICAgICAgfVxuICAgICAgcmVzdWx0LmlkID0gaWRNYXRjaFsxXTtcbiAgICAgIHJlbWFpbmluZyA9IHJlbWFpbmluZy5zbGljZShpZE1hdGNoWzBdLmxlbmd0aCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHJlbWFpbmluZ1swXSA9PT0gJy4nKSB7XG4gICAgICBjb25zdCBjbGFzc01hdGNoID0gL15cXC4oW2EtekEtWl9dW1xcdy1dKikvLmV4ZWMocmVtYWluaW5nKTtcbiAgICAgIGlmICghY2xhc3NNYXRjaCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1hbGZvcm1lZCBjbGFzcyBzZWxlY3RvciBzZWdtZW50IGluICcke3N0ZXB9J2ApO1xuICAgICAgfVxuICAgICAgcmVzdWx0LmNsYXNzZXMucHVzaChjbGFzc01hdGNoWzFdKTtcbiAgICAgIHJlbWFpbmluZyA9IHJlbWFpbmluZy5zbGljZShjbGFzc01hdGNoWzBdLmxlbmd0aCk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHJlbWFpbmluZ1swXSA9PT0gJ1snKSB7XG4gICAgICBjb25zdCBhdHRyTWF0Y2ggPSAvXlxcW1xccyooW15cXF09fl4kKnxcXHNdKylcXHMqKD86PVxccyooPzpcIihbXlwiXSopXCJ8JyhbXiddKiknfChbXlxcXVxcc10rKSlcXHMqKT9cXF0vLmV4ZWMocmVtYWluaW5nKTtcbiAgICAgIGlmICghYXR0ck1hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgTWFsZm9ybWVkIGF0dHJpYnV0ZSBzZWxlY3RvciBzZWdtZW50IGluICcke3N0ZXB9J2ApO1xuICAgICAgfVxuICAgICAgY29uc3QgWywgbmFtZSwgZG91YmxlUXVvdGVkVmFsdWUsIHNpbmdsZVF1b3RlZFZhbHVlLCBiYXJlVmFsdWVdID0gYXR0ck1hdGNoO1xuICAgICAgY29uc3QgdmFsdWUgPSBkb3VibGVRdW90ZWRWYWx1ZSA/PyBzaW5nbGVRdW90ZWRWYWx1ZSA/PyBiYXJlVmFsdWU7XG4gICAgICByZXN1bHQuYXR0cnMucHVzaCh7bmFtZSwgdmFsdWV9KTtcbiAgICAgIHJlbWFpbmluZyA9IHJlbWFpbmluZy5zbGljZShhdHRyTWF0Y2hbMF0ubGVuZ3RoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNzcyBzZWxlY3RvciBzZWdtZW50ICcke3JlbWFpbmluZ30nYCk7XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG5mdW5jdGlvbiBzcGxpdENzc1NlbGVjdG9yIChzZWxlY3Rvcikge1xuICBjb25zdCBwYXJ0cyA9IFtdO1xuICBsZXQgY3VycmVudCA9ICcnO1xuICBsZXQgcXVvdGUgPSBudWxsO1xuICBsZXQgYnJhY2tldERlcHRoID0gMDtcbiAgZm9yIChjb25zdCBjaCBvZiBzZWxlY3Rvci50cmltKCkpIHtcbiAgICBpZiAocXVvdGUpIHtcbiAgICAgIGN1cnJlbnQgKz0gY2g7XG4gICAgICBpZiAoY2ggPT09IHF1b3RlKSB7XG4gICAgICAgIHF1b3RlID0gbnVsbDtcbiAgICAgIH1cbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09ICdcXCcnKSB7XG4gICAgICBxdW90ZSA9IGNoO1xuICAgICAgY3VycmVudCArPSBjaDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09ICdbJykge1xuICAgICAgYnJhY2tldERlcHRoICs9IDE7XG4gICAgICBjdXJyZW50ICs9IGNoO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gJ10nKSB7XG4gICAgICBicmFja2V0RGVwdGggLT0gMTtcbiAgICAgIGN1cnJlbnQgKz0gY2g7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKC9cXHMvLnRlc3QoY2gpICYmIGJyYWNrZXREZXB0aCA9PT0gMCkge1xuICAgICAgaWYgKGN1cnJlbnQudHJpbSgpKSB7XG4gICAgICAgIHBhcnRzLnB1c2goY3VycmVudC50cmltKCkpO1xuICAgICAgfVxuICAgICAgY3VycmVudCA9ICcnO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGN1cnJlbnQgKz0gY2g7XG4gIH1cbiAgaWYgKGN1cnJlbnQudHJpbSgpKSB7XG4gICAgcGFydHMucHVzaChjdXJyZW50LnRyaW0oKSk7XG4gIH1cbiAgaWYgKHBhcnRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHRocm93IG5ldyBFcnJvcignRW1wdHkgY3NzIHNlbGVjdG9yJyk7XG4gIH1cbiAgcmV0dXJuIHBhcnRzO1xufVxuXG5mdW5jdGlvbiBjc3NTZWxlY3RvclRvWHBhdGggKHNlbGVjdG9yKSB7XG4gIGNvbnN0IHN0ZXBzID0gc3BsaXRDc3NTZWxlY3RvcihgJHtzZWxlY3Rvcn1gKTtcbiAgY29uc3QgeHBhdGhTdGVwcyA9IHN0ZXBzLm1hcCgoc3RlcCkgPT4ge1xuICAgIGNvbnN0IHBhcnNlZCA9IHBhcnNlQ3NzU3RlcChzdGVwKTtcbiAgICBjb25zdCBwcmVkaWNhdGVzID0gW107XG4gICAgaWYgKHBhcnNlZC50YWcgIT09ICcqJykge1xuICAgICAgY29uc3QgdGFnTGl0ZXJhbCA9IHRvWFBhdGhMaXRlcmFsKHBhcnNlZC50YWcpO1xuICAgICAgcHJlZGljYXRlcy5wdXNoKGAobmFtZSgpPSR7dGFnTGl0ZXJhbH0gb3IgQHRhZz0ke3RhZ0xpdGVyYWx9KWApO1xuICAgIH1cbiAgICBpZiAocGFyc2VkLmlkKSB7XG4gICAgICBwcmVkaWNhdGVzLnB1c2goYEBpZD0ke3RvWFBhdGhMaXRlcmFsKHBhcnNlZC5pZCl9YCk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgY2xzIG9mIHBhcnNlZC5jbGFzc2VzKSB7XG4gICAgICBwcmVkaWNhdGVzLnB1c2goY2xhc3NUb2tlbkV4cHIoY2xzKSk7XG4gICAgfVxuICAgIGZvciAoY29uc3QgYXR0ciBvZiBwYXJzZWQuYXR0cnMpIHtcbiAgICAgIGlmIChhdHRyLnZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgcHJlZGljYXRlcy5wdXNoKGBAJHthdHRyLm5hbWV9YCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBwcmVkaWNhdGVzLnB1c2goYEAke2F0dHIubmFtZX09JHt0b1hQYXRoTGl0ZXJhbChhdHRyLnZhbHVlKX1gKTtcbiAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHByZWRpY2F0ZXMubGVuZ3RoID4gMFxuICAgICAgPyBgKlske3ByZWRpY2F0ZXMuam9pbignIGFuZCAnKX1dYFxuICAgICAgOiAnKic7XG4gIH0pO1xuICByZXR1cm4gYC8vJHt4cGF0aFN0ZXBzLmpvaW4oJy8vJyl9YDtcbn1cblxuZnVuY3Rpb24gYnVpbGRYcGF0aEZyb21TdHJhdGVneSAoc3RyYXRlZ3ksIHNlbGVjdG9yKSB7XG4gIGNvbnN0IHN0clNlbGVjdG9yID0gYCR7c2VsZWN0b3J9YDtcbiAgY29uc3Qgc2VsZWN0b3JMaXRlcmFsID0gdG9YUGF0aExpdGVyYWwoc3RyU2VsZWN0b3IpO1xuICBzd2l0Y2ggKHN0cmF0ZWd5KSB7XG4gICAgY2FzZSAnbmFtZSc6XG4gICAgICByZXR1cm4gYC8vKltAbmFtZT0ke3NlbGVjdG9yTGl0ZXJhbH1dYDtcbiAgICBjYXNlICdjbGFzcyBuYW1lJzpcbiAgICAgIHJldHVybiBgLy8qWyR7Y2xhc3NUb2tlbkV4cHIoc3RyU2VsZWN0b3IpfV1gO1xuICAgIGNhc2UgJ2lkJzpcbiAgICAgIHJldHVybiBgLy8qW0BpZD0ke3NlbGVjdG9yTGl0ZXJhbH1dYDtcbiAgICBjYXNlICdhY2Nlc3NpYmlsaXR5IGlkJzpcbiAgICAgIHJldHVybiBgLy8qW0BuYW1lPSR7c2VsZWN0b3JMaXRlcmFsfSBvciBAbGFiZWw9JHtzZWxlY3RvckxpdGVyYWx9IG9yIEBhY2Nlc3NpYmlsaXR5LWlkPSR7c2VsZWN0b3JMaXRlcmFsfV1gO1xuICAgIGNhc2UgJ3RhZyBuYW1lJzpcbiAgICAgIHJldHVybiBgLy8qW25hbWUoKT0ke3NlbGVjdG9yTGl0ZXJhbH0gb3IgQHRhZz0ke3NlbGVjdG9yTGl0ZXJhbH1dYDtcbiAgICBjYXNlICdsaW5rIHRleHQnOlxuICAgICAgcmV0dXJuIGAvLypbKG5hbWUoKT1cImFcIiBvciBAdGFnPVwiYVwiKSBhbmQgKEBuYW1lPSR7c2VsZWN0b3JMaXRlcmFsfSBvciBAdGV4dD0ke3NlbGVjdG9yTGl0ZXJhbH0gb3Igbm9ybWFsaXplLXNwYWNlKC4pPSR7c2VsZWN0b3JMaXRlcmFsfSldYDtcbiAgICBjYXNlICdwYXJ0aWFsIGxpbmsgdGV4dCc6XG4gICAgICByZXR1cm4gYC8vKlsobmFtZSgpPVwiYVwiIG9yIEB0YWc9XCJhXCIpIGFuZCAoY29udGFpbnMoQG5hbWUsICR7c2VsZWN0b3JMaXRlcmFsfSkgb3IgY29udGFpbnMoQHRleHQsICR7c2VsZWN0b3JMaXRlcmFsfSkgb3IgY29udGFpbnMobm9ybWFsaXplLXNwYWNlKC4pLCAke3NlbGVjdG9yTGl0ZXJhbH0pKV1gO1xuICAgIGNhc2UgJ2NzcyBzZWxlY3Rvcic6XG4gICAgICByZXR1cm4gY3NzU2VsZWN0b3JUb1hwYXRoKHN0clNlbGVjdG9yKTtcbiAgICBjYXNlICd4cGF0aCc6XG4gICAgICByZXR1cm4gc3RyU2VsZWN0b3I7XG4gICAgZGVmYXVsdDpcbiAgICAgIHRocm93IGNyZWF0ZUludmFsaWRTZWxlY3RvckVycm9yKGBVbnN1cHBvcnRlZCBsb2NhdG9yIHN0cmF0ZWd5ICcke3N0cmF0ZWd5fSdgKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBwYXJzZVJlY3QgKHZhbHVlKSB7XG4gIGNvbnN0IG1hdGNoID0gL15cXFsoPzx4Pi0/XFxkKyksKD88eT4tP1xcZCspLCg/PHdpZHRoPlxcZCspLCg/PGhlaWdodD5cXGQrKVxcXSQvLmV4ZWMoYCR7dmFsdWUgPz8gJyd9YCk7XG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCB7eCwgeSwgd2lkdGgsIGhlaWdodH0gPSBtYXRjaC5ncm91cHM7XG4gIHJldHVybiB7XG4gICAgeDogTnVtYmVyLnBhcnNlSW50KHgsIDEwKSxcbiAgICB5OiBOdW1iZXIucGFyc2VJbnQoeSwgMTApLFxuICAgIHdpZHRoOiBOdW1iZXIucGFyc2VJbnQod2lkdGgsIDEwKSxcbiAgICBoZWlnaHQ6IE51bWJlci5wYXJzZUludChoZWlnaHQsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gbm9kZVByaW9yaXR5U2NvcmUgKG5vZGUpIHtcbiAgaWYgKCFub2RlPy5hdHRyaWJ1dGVzKSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuICBjb25zdCBhdHRycyA9IHt9O1xuICBmb3IgKGNvbnN0IGF0dHIgb2YgQXJyYXkuZnJvbShub2RlLmF0dHJpYnV0ZXMpKSB7XG4gICAgYXR0cnNbYXR0ci5uYW1lXSA9IGF0dHIudmFsdWU7XG4gIH1cbiAgY29uc3Qgc3RhdGVzID0gYCR7YXR0cnMuc3RhdGVzID8/ICcnfWAudG9VcHBlckNhc2UoKTtcbiAgbGV0IHNjb3JlID0gMDtcbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnU0hPV0lORycpIHx8IHN0YXRlcy5pbmNsdWRlcygnVklTSUJMRScpKSB7XG4gICAgc2NvcmUgKz0gMjAwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ0VOQUJMRUQnKSB8fCBzdGF0ZXMuaW5jbHVkZXMoJ1NFTlNJVElWRScpKSB7XG4gICAgc2NvcmUgKz0gNDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnRk9DVVNFRCcpIHx8IHN0YXRlcy5pbmNsdWRlcygnQUNUSVZFJykpIHtcbiAgICBzY29yZSArPSAyNTtcbiAgfVxuXG4gIGNvbnN0IHJlY3QgPSBwYXJzZVJlY3QoYXR0cnMucmVjdCk7XG4gIGlmIChyZWN0ICYmIHJlY3Qud2lkdGggPiAwICYmIHJlY3QuaGVpZ2h0ID4gMCkge1xuICAgIHNjb3JlICs9IE1hdGgubWluKHJlY3Qud2lkdGggKiByZWN0LmhlaWdodCwgNDAwMDAwMCkgLyAxMDAwMDtcbiAgICBpZiAocmVjdC54IDwgLTEwMDAwMDAgfHwgcmVjdC55IDwgLTEwMDAwMDApIHtcbiAgICAgIHNjb3JlIC09IDUwMDtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgc2NvcmUgLT0gNjA7XG4gIH1cbiAgcmV0dXJuIHNjb3JlO1xufVxuXG5mdW5jdGlvbiBnZXRXaW5kb3dTY29wZWRIaWVyYXJjaHkgKGN0eCwgYXBpcywgc3RyYXRlZ3ksIHNlbGVjdG9yKSB7XG4gIGNvbnN0IHtwaWQsIG5hbWUsIHdpZH0gPSBjdHguX3dpbjtcbiAgbGV0IGhpZXJhcmNoeSA9IG51bGw7XG4gIGlmIChzaG91bGRQcmVmZXJIYW5kbGVTY29wZWRIaWVyYXJjaHkoY3R4LCBzdHJhdGVneSwgc2VsZWN0b3IpKSB7XG4gICAgLy8gRmFzdCBwYXRoOiB0cnkgbmF0aXZlIHBlci13aW5kb3cgQVQtU1BJIGNhbGwgZmlyc3QuICBUaGlzIHJldHVybnMgZnJlc2hcbiAgICAvLyBlbGVtZW50IGRhdGEgKH4yMDBtcykgd2l0aG91dCBuZWVkaW5nIHRoZSBmdWxsIGRlc2t0b3AgaGllcmFyY2h5LiAgVGhlXG4gICAgLy8gaGFuZGxlLXNjb3BlZCBmYWxsYmFjayB1c2VzIGNhY2hlZCBkZXNrdG9wIFhNTCB3aGljaCBtYXkgaGF2ZSBzdGFsZVxuICAgIC8vIGVsZW1lbnQgc3RhdGVzIGFmdGVyIFVJIGFjdGlvbnMgKGNsaWNrL3NldFZhbHVlL2NsZWFyKS5cbiAgICBoaWVyYXJjaHkgPSBhcGlzLmExMXlfZ2V0V2luZG93VWlIaWVyYWNoeShuYW1lLCBwaWQpO1xuICAgIGlmICgoIWhpZXJhcmNoeSB8fCAhYCR7aGllcmFyY2h5fWAudHJpbSgpKSAmJiB0eXBlb2YgYXBpcy5hMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgaGllcmFyY2h5ID0gYXBpcy5hMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSh3aWQsIHBpZCwgbmFtZSk7XG4gICAgfVxuICB9IGVsc2Uge1xuICAgIGhpZXJhcmNoeSA9IGFwaXMuYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5KG5hbWUsIHBpZCk7XG4gICAgaWYgKCghaGllcmFyY2h5IHx8ICFgJHtoaWVyYXJjaHl9YC50cmltKCkpICYmIGN0eC5saW51eEJhY2tlbmQgPT09ICd3YXlsYW5kJykge1xuICAgICAgaWYgKHR5cGVvZiBhcGlzLmExMXlfZ2V0V2luZG93VWlIaWVyYWNoeUJ5SGFuZGxlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgIGhpZXJhcmNoeSA9IGFwaXMuYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5QnlIYW5kbGUod2lkLCBwaWQsIG5hbWUpO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICAvLyBXYXlsYW5kIHVsdGltYXRlIGZhbGxiYWNrOiB1c2UgdGhlIGZ1bGwgZGVza3RvcCBhY2Nlc3NpYmlsaXR5IGhpZXJhcmNoeSB3aGVuXG4gIC8vIGJvdGggd2luZG93LXNjb3BlZCBhbmQgaGFuZGxlLXNjb3BlZCBsb29rdXBzIHJldHVybiBub3RoaW5nLiAgVGhpcyBjb3ZlcnNcbiAgLy8gUkhFTC9HTk9NRSBzY2VuYXJpb3Mgd2hlcmUgQVQtU1BJIHdpbmRvdyBuYW1lcyBkb24ndCBtYXRjaCB0aGUgZXhwZWN0ZWRcbiAgLy8gaWRlbnRpZmllcnMgaW1tZWRpYXRlbHkgYWZ0ZXIgbGF1bmNoIG9yIGRpYWxvZyB0cmFuc2l0aW9ucy5cbiAgaWYgKCghaGllcmFyY2h5IHx8ICFgJHtoaWVyYXJjaHl9YC50cmltKCkpICYmIGN0eC5saW51eEJhY2tlbmQgPT09ICd3YXlsYW5kJykge1xuICAgIGlmICh0eXBlb2YgYXBpcy5hMTF5X2dldERlc2t0b3BVaUhpZXJhY2h5ID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBoaWVyYXJjaHkgPSBhcGlzLmExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkoKTtcbiAgICB9XG4gIH1cbiAgaWYgKCFoaWVyYXJjaHkgfHwgIWAke2hpZXJhcmNoeX1gLnRyaW0oKSkge1xuICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoXG4gICAgICBgdGhlIHNlbGVjdGVkIHdpbmRvdyBkb2Vzbid0IGV4aXN0ICh3aWQ9JHt3aWR9LCBwaWQ9JHtwaWR9LCBuYW1lPSR7bmFtZX0pYFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIGhpZXJhcmNoeTtcbn1cblxuY29tbWFuZHMuX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvID0gZnVuY3Rpb24gKCkge1xuICAvLyBTaG9ydC1saXZlZCBjYWNoZTogaWYgd2UgdmFsaWRhdGVkIHdpdGhpbiB0aGUgbGFzdCA1IHNlY29uZHMsIHNraXAgdGhlXG4gIC8vIGV4cGVuc2l2ZSBhcHBfZ2V0V2luZG93SGllcmFjaHkoKSBjYWxsLiAgVGhlIHdpbmRvdyBkb2Vzbid0IG1vdmUvY2xvc2VcbiAgLy8gYmV0d2VlbiByYXBpZCBmaW5kX2VsZW1lbnQgcG9sbHMuXG4gIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gIGlmICh0aGlzLl93aW5WYWxpZGF0ZWRBdCAmJiAobm93IC0gdGhpcy5fd2luVmFsaWRhdGVkQXQpIDwgNTAwMCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG4gIGNvbnN0IGFwaXMgPSBnZXRBcGlzKHRoaXMpO1xuICBjb25zdCB7cGlkLCB3aWQsIG5hbWV9ID0gdGhpcy5fd2luO1xuICBjb25zdCB3aW5IaWVyYWNoeSA9IGFwaXMuYXBwX2dldFdpbmRvd0hpZXJhY2h5KCk7XG4gIGNvbnN0IGRvYyA9IG5ldyBkb20oKS5wYXJzZUZyb21TdHJpbmcod2luSGllcmFjaHkpO1xuICBjb25zdCBuYW1lTGl0ZXJhbCA9IHRvWFBhdGhMaXRlcmFsKG5hbWUpO1xuICBsZXQgeHBhdGggPSBgLy8qW0BwaWQ9XCIke3BpZH1cIiBhbmQgQHdpZD1cIiR7d2lkfVwiIGFuZCBASW5wdXRPdXRwdXQ9XCJ0cnVlXCIgYW5kIChAbmFtZT0ke25hbWVMaXRlcmFsfSBvciAke2NsYXNzVG9rZW5FeHByKG5hbWUpfSldYDtcbiAgY29uc3Qgbm9kZXMgPSBzZWxlY3QoZG9jLCB4cGF0aCk7XG4gIGlmIChub2RlcyAmJiBub2Rlcy5sZW5ndGggPiAwKSB7XG4gICAgdGhpcy5fd2luVmFsaWRhdGVkQXQgPSBub3c7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgdHJ5IHtcbiAgICBjb25zdCB3aW4gPSB0aGlzLl9nZXRXaW5BbmRQaWRfRnJvbVdpbklkKHdpZCk7XG4gICAgdGhpcy5fd2luID0gd2luO1xuICB9IGNhdGNoIHtcbiAgICBpZiAodGhpcy5saW51eEJhY2tlbmQgPT09ICd3YXlsYW5kJyAmJiB0eXBlb2YgdGhpcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3cgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIHJldHVybiAhIXRoaXMuX3Jlc29sdmVCZXN0QXZhaWxhYmxlV2luZG93KCk7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuICB0aGlzLl93aW5WYWxpZGF0ZWRBdCA9IG5vdztcbiAgcmV0dXJuIHRydWU7XG59O1xuXG5jb21tYW5kcy5maW5kRWxPckVscyA9IGZ1bmN0aW9uIGZpbmRFbE9yRWxzIChzdHJhdGVneSwgc2VsZWN0b3IsIG11bHQsIGNvbnRleHQpIHtcbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIGxldCBhMTF5SGllcmFjaHkgPSBudWxsO1xuICBpZiAoIWNvbnRleHQpIHtcbiAgICAvLyBSYXRlLWxpbWl0IG5hdGl2ZSBBVC1TUEkgY2FjaGUgY2xlYXJzIHRvIG9uY2UgcGVyIDJzIHdpdGhpbiB0aGUgU0FNRVxuICAgIC8vIHdpbmRvdy4gIEZvcmNlIGEgY2xlYXIgd2hlbiB0aGUgYWN0aXZlIHdpbmRvdyBjaGFuZ2VkIChzZXRXaW5kb3cgd2FzXG4gICAgLy8gY2FsbGVkKSBzbyB3ZSBnZXQgZnJlc2ggQVQtU1BJIGRhdGEgZm9yIHRoZSBuZXcgd2luZG93LlxuICAgIGNvbnN0IG5vdyA9IERhdGUubm93KCk7XG4gICAgY29uc3QgY3VycmVudFdpZCA9IHRoaXMuX3dpbj8ud2lkO1xuICAgIGNvbnN0IHdpbmRvd0NoYW5nZWQgPSBjdXJyZW50V2lkICYmIGN1cnJlbnRXaWQgIT09IHRoaXMuX2xhc3RGaW5kV2lkO1xuICAgIGlmICh3aW5kb3dDaGFuZ2VkIHx8ICF0aGlzLl9sYXN0Q2FjaGVDbGVhckF0IHx8IChub3cgLSB0aGlzLl9sYXN0Q2FjaGVDbGVhckF0KSA+PSAyMDAwKSB7XG4gICAgICBhcGlzLmExMXlfY2xlYXJfY2FjaGUoKTtcbiAgICAgIHRoaXMuX2xhc3RDYWNoZUNsZWFyQXQgPSBub3c7XG4gICAgfVxuICAgIHRoaXMuX2xhc3RGaW5kV2lkID0gY3VycmVudFdpZDtcbiAgICBpZiAoIXRoaXMuX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvKCkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoV2luZG93RXJyb3IoYHRoZSBzZWxlY3RlZCB3aW5kb3cgZG9lc24ndCBleGlzdGApO1xuICAgIH1cbiAgICBhMTF5SGllcmFjaHkgPSBnZXRXaW5kb3dTY29wZWRIaWVyYXJjaHkodGhpcywgYXBpcywgc3RyYXRlZ3ksIHNlbGVjdG9yKTtcbiAgfSBlbHNlIHtcbiAgICBhMTF5SGllcmFjaHkgPSB0aGlzLl9jYWNoZS5nZXQoY29udGV4dCk7XG4gICAgaWYgKCFhMTF5SGllcmFjaHkpIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuVW5rbm93bkVycm9yKGBjb250ZXh0ICR7Y29udGV4dH0gaGFzIGV4cGlyZWRgKTtcbiAgICB9XG4gIH1cbiAgY29uc3QgZG9jID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyhhMTF5SGllcmFjaHkpO1xuXG4gIGNvbnN0IHhwYXRoID0gYnVpbGRYcGF0aEZyb21TdHJhdGVneShzdHJhdGVneSwgc2VsZWN0b3IpO1xuXG4gIGxldCBub2RlcyA9IFtdO1xuICB0cnkge1xuICAgIG5vZGVzID0gc2VsZWN0KGRvYywgeHBhdGgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHRocm93IGNyZWF0ZUludmFsaWRTZWxlY3RvckVycm9yKFxuICAgICAgYENvdWxkIG5vdCBsb2NhdGUgZWxlbWVudCBieSBzdHJhdGVneSAnJHtzdHJhdGVneX0nIHdpdGggc2VsZWN0b3IgJyR7c2VsZWN0b3J9Jy4gYCArXG4gICAgICBgWFBhdGggd2FzICcke3hwYXRofScuIE9yaWdpbmFsIGVycm9yOiAke2Vycm9yLm1lc3NhZ2V9YFxuICAgICk7XG4gIH1cbiAgaWYgKCFub2RlcyB8fCBub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICBub2RlcyA9IFtdO1xuICAgIC8vIFdheWxhbmQgZmFsbGJhY2s6IHdoZW4gYSB3aW5kb3ctc2NvcGVkIHNlYXJjaCByZXR1cm5zIG5vIHJlc3VsdHMsIHJldHJ5XG4gICAgLy8gYWdhaW5zdCB0aGUgZnVsbCBkZXNrdG9wIEFULVNQSSB0cmVlLiAgR1RLIG1vZGFsL3RyYW5zaWVudCBkaWFsb2dzXG4gICAgLy8gKGUuZy4gXCJBZGQgU2VydmVyXCIpIG1heSBub3QgcmVnaXN0ZXIgYXMgc2VwYXJhdGUgY29tcG9zaXRvciB3aW5kb3dzLCBzb1xuICAgIC8vIGdldFdpbmRvd0hhbmRsZXMgbmV2ZXIgZGlzY292ZXJzIHRoZW0gYW5kIHRoZSB3aW5kb3ctc2NvcGVkIGhpZXJhcmNoeVxuICAgIC8vIG9ubHkgY292ZXJzIHRoZSBwYXJlbnQgd2luZG93LiAgVGhlIGRlc2t0b3AgdHJlZSBhbHdheXMgY29udGFpbnMgdGhlc2VcbiAgICAvLyBkaWFsb2dzIGJlY2F1c2UgQVQtU1BJIHJlcG9ydHMgdGhlbSByZWdhcmRsZXNzIG9mIGNvbXBvc2l0b3Igc3RhdGUuXG4gICAgLy9cbiAgICAvLyBQZXJmb3JtYW5jZTogdGhlIGRlc2t0b3AgQVQtU1BJIHNjYW4gaXMgZXhwZW5zaXZlICg1LTM1cyBkZXBlbmRpbmcgb25cbiAgICAvLyB0cmVlIHNpemUpLiAgV2UgZmlyc3QgdHJ5IHRoZSBjYWNoZWQgaGllcmFyY2h5ICh+MG1zKSB3aGljaCB3b3JrcyBmb3JcbiAgICAvLyByZXBlYXQgc2VhcmNoZXMuICBBIGZvcmNlZCBjYWNoZSByZWZyZXNoIG9ubHkgaGFwcGVucyB3aGVuOlxuICAgIC8vICAgKGEpIHRoZSBjYWNoZWQgc2NhbiBhbHNvIG1pc3NlZCwgQU5EXG4gICAgLy8gICAoYikgYSBVSSBhY3Rpb24gKGNsaWNrL3R5cGUpIG9jY3VycmVkIHNpbmNlIHRoZSBsYXN0IGNhY2hlLCBBTkRcbiAgICAvLyAgIChjKSBhdCBsZWFzdCAzcyBlbGFwc2VkIHNpbmNlIHRoZSBsYXN0IGZvcmNlZCByZWZyZXNoLlxuICAgIC8vIFRoaXMgZW5zdXJlcyBhdCBtb3N0IG9uZSBleHBlbnNpdmUgc2NhbiBwZXIgVUkgdHJhbnNpdGlvbi5cbiAgICBpZiAoIWNvbnRleHQgJiYgdGhpcy5saW51eEJhY2tlbmQgPT09ICd3YXlsYW5kJykge1xuICAgICAgdHJ5IHtcbiAgICAgICAgLy8gMS4gVHJ5IGNhY2hlZCBkZXNrdG9wIGhpZXJhcmNoeSBmaXJzdCAoZmFzdCBwYXRoKVxuICAgICAgICBsZXQgX2Rlc2t0b3BYbWwgPSBhcGlzLmExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkoKTtcbiAgICAgICAgaWYgKF9kZXNrdG9wWG1sICYmIGAke19kZXNrdG9wWG1sfWAudHJpbSgpKSB7XG4gICAgICAgICAgY29uc3QgX2RkID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyhfZGVza3RvcFhtbCk7XG4gICAgICAgICAgY29uc3QgX2RuID0gc2VsZWN0KF9kZCwgeHBhdGgpO1xuICAgICAgICAgIGlmIChfZG4gJiYgX2RuLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIG5vZGVzID0gX2RuO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyAyLiBDYWNoZWQgbWlzc2VkIOKAlCBmb3JjZSBPTkUgZnJlc2ggc2NhbiBpZiBhIFVJIGFjdGlvbiBoYXBwZW5lZFxuICAgICAgICAvLyAgICBzaW5jZSB0aGUgbGFzdCBjYWNoZSBhbmQgd2UgaGF2ZW4ndCBmb3JjZWQgcmVjZW50bHkuXG4gICAgICAgIGlmIChub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICBjb25zdCBfbm93ID0gRGF0ZS5ub3coKTtcbiAgICAgICAgICBjb25zdCBfY2FjaGVUcyA9IGFwaXMuX2Rlc2t0b3BIaWVyYXJjaHlDYWNoZUF0IHx8IDA7XG4gICAgICAgICAgY29uc3QgX3VpVHMgPSB0aGlzLl9sYXN0VWlBY3Rpb25BdCB8fCAwO1xuICAgICAgICAgIGNvbnN0IF9sYXN0Rm9yY2UgPSB0aGlzLl9sYXN0RGVza3RvcEZvcmNlU2NhbkF0IHx8IDA7XG4gICAgICAgICAgaWYgKF91aVRzID4gX2NhY2hlVHMgJiYgKF9ub3cgLSBfbGFzdEZvcmNlKSA+PSAzMDAwKSB7XG4gICAgICAgICAgICB0aGlzLl9sYXN0RGVza3RvcEZvcmNlU2NhbkF0ID0gX25vdztcbiAgICAgICAgICAgIGlmICh0eXBlb2YgYXBpcy5faW52YWxpZGF0ZURlc2t0b3BIaWVyYXJjaHlDYWNoZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICBhcGlzLl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBfZGVza3RvcFhtbCA9IGFwaXMuYTExeV9nZXREZXNrdG9wVWlIaWVyYWNoeSgpO1xuICAgICAgICAgICAgaWYgKF9kZXNrdG9wWG1sICYmIGAke19kZXNrdG9wWG1sfWAudHJpbSgpKSB7XG4gICAgICAgICAgICAgIGNvbnN0IF9kZDIgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKF9kZXNrdG9wWG1sKTtcbiAgICAgICAgICAgICAgY29uc3QgX2RuMiA9IHNlbGVjdChfZGQyLCB4cGF0aCk7XG4gICAgICAgICAgICAgIGlmIChfZG4yICYmIF9kbjIubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIG5vZGVzID0gX2RuMjtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCB7IC8qIGRlc2t0b3AgZmFsbGJhY2sgaXMgYmVzdC1lZmZvcnQgKi8gfVxuICAgIH1cbiAgfVxuICBpZiAobm9kZXMubGVuZ3RoID4gMSkge1xuICAgIG5vZGVzID0gWy4uLm5vZGVzXS5zb3J0KChhLCBiKSA9PiBub2RlUHJpb3JpdHlTY29yZShiKSAtIG5vZGVQcmlvcml0eVNjb3JlKGEpKTtcbiAgfVxuICBjb25zdCBzZXJpYWxpemVyID0gbmV3IFhNTFNlcmlhbGl6ZXIoKTtcbiAgaWYgKG11bHQpIHtcbiAgICBsZXQgZWxlbWVudHMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICAgIGNvbnN0IHN0ciA9IHNlcmlhbGl6ZXIuc2VyaWFsaXplVG9TdHJpbmcobm9kZSk7XG4gICAgICBjb25zdCBrZXkgPSB1dWlkdjQoKTtcbiAgICAgIHRoaXMuX2NhY2hlLnNldChrZXksIHN0cik7XG4gICAgICBlbGVtZW50cy5wdXNoKHtcbiAgICAgICAgJ2VsZW1lbnQtNjA2Ni0xMWU0LWE1MmUtNGY3MzU0NjZjZWNmJzoga2V5LFxuICAgICAgICAnRUxFTUVOVCc6IGtleVxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBlbGVtZW50cztcbiAgfSBlbHNlIHtcbiAgICBpZiAobm9kZXMubGVuZ3RoID09PSAwKSB7XG4gICAgICB0aHJvdyBuZXcgZXJyb3JzLk5vU3VjaEVsZW1lbnRFcnJvcigpO1xuICAgIH1cbiAgICBjb25zdCBub2RlID0gbm9kZXNbMF07XG4gICAgY29uc3Qgc3RyID0gc2VyaWFsaXplci5zZXJpYWxpemVUb1N0cmluZyhub2RlKTtcbiAgICBjb25zdCBrZXkgPSB1dWlkdjQoKTtcbiAgICB0aGlzLl9jYWNoZS5zZXQoa2V5LCBzdHIpO1xuICAgIHJldHVybiB7XG4gICAgICAnZWxlbWVudC02MDY2LTExZTQtYTUyZS00ZjczNTQ2NmNlY2YnOiBrZXksXG4gICAgICAnRUxFTUVOVCc6IGtleVxuICAgIH07XG4gIH1cbn07XG5cblxuZXhwb3J0IHsgY29tbWFuZHMgfTtcbmV4cG9ydCBkZWZhdWx0IGNvbW1hbmRzO1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7OztBQUFBLElBQUFBLE9BQUEsR0FBQUMsT0FBQTtBQUNBLElBQUFDLE1BQUEsR0FBQUMsc0JBQUEsQ0FBQUYsT0FBQTtBQUNBLElBQUFHLE9BQUEsR0FBQUgsT0FBQTtBQUNBLElBQUFJLEtBQUEsR0FBQUosT0FBQTtBQUVBLE1BQU1LLFFBQVEsR0FBQUMsT0FBQSxDQUFBRCxRQUFBLEdBQUcsQ0FBQyxDQUFDO0FBQ25CLE1BQU1FLDJCQUEyQixHQUFHLENBQUMsUUFBUSxFQUFFLE9BQU8sRUFBRSxPQUFPLEVBQUUsY0FBYyxFQUFFLFNBQVMsRUFBRSxPQUFPLEVBQUUsU0FBUyxDQUFD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
