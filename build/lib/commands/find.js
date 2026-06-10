"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = exports.commands = void 0;
require("source-map-support/register");
var _baseDriver = require("@appium/base-driver");
var _xpath = _interopRequireDefault(require("xpath.js"));
var _xmldom = require("xmldom");
var _uuid = require("uuid");
const commands = exports.commands = {};
const HANDLE_SCOPED_WINDOW_TOKENS = ['dialog', 'alert', 'modal', 'notification', 'popover', 'popup', 'tooltip'];
function getApis(ctx) {
  if (!(ctx !== null && ctx !== void 0 && ctx._backendApis)) {
    throw new _baseDriver.errors.UnknownError('Linux backend is not initialized');
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
  if (_baseDriver.errors.InvalidSelectorError) {
    return new _baseDriver.errors.InvalidSelectorError(message);
  }
  return new _baseDriver.errors.UnknownError(message);
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
    throw new _baseDriver.errors.NoSuchWindowError(`the selected window doesn't exist (wid=${wid}, pid=${pid}, name=${name})`);
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
      throw new _baseDriver.errors.NoSuchWindowError(`the selected window doesn't exist`);
    }
    a11yHierachy = getWindowScopedHierarchy(this, apis, strategy, selector);
  } else {
    a11yHierachy = this._cache.get(context);
    if (!a11yHierachy) {
      throw new _baseDriver.errors.UnknownError(`context ${context} has expired`);
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
      throw new _baseDriver.errors.NoSuchElementError();
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2NvbW1hbmRzL2ZpbmQuanMiLCJuYW1lcyI6WyJfYmFzZURyaXZlciIsInJlcXVpcmUiLCJfeHBhdGgiLCJfaW50ZXJvcFJlcXVpcmVEZWZhdWx0IiwiX3htbGRvbSIsIl91dWlkIiwiY29tbWFuZHMiLCJleHBvcnRzIiwiSEFORExFX1NDT1BFRF9XSU5ET1dfVE9LRU5TIiwiZ2V0QXBpcyIsImN0eCIsIl9iYWNrZW5kQXBpcyIsImVycm9ycyIsIlVua25vd25FcnJvciIsInNlbGVjdG9yVGFyZ2V0c1RyYW5zaWVudFdpbmRvdyIsInN0cmF0ZWd5Iiwic2VsZWN0b3IiLCJub3JtYWxpemVkIiwidG9Mb3dlckNhc2UiLCJzb21lIiwidG9rZW4iLCJpbmNsdWRlcyIsInNob3VsZFByZWZlckhhbmRsZVNjb3BlZEhpZXJhcmNoeSIsIl9jdHgkX3dpbiR0YWciLCJfY3R4JF93aW4iLCJfY3R4JF93aW4kd2luZG93VHlwZSIsIl9jdHgkX3dpbjIiLCJsaW51eEJhY2tlbmQiLCJ0YWciLCJfd2luIiwid2luZG93VHlwZSIsInRvWFBhdGhMaXRlcmFsIiwidmFsdWUiLCJzdHJpbmdWYWx1ZSIsInBhcnRzIiwic3BsaXQiLCJ4cGF0aFBhcnRzIiwiaSIsImxlbmd0aCIsInB1c2giLCJqb2luIiwiY2xhc3NUb2tlbkV4cHIiLCJjcmVhdGVJbnZhbGlkU2VsZWN0b3JFcnJvciIsIm1lc3NhZ2UiLCJJbnZhbGlkU2VsZWN0b3JFcnJvciIsInBhcnNlQ3NzU3RlcCIsInN0ZXAiLCJyZXN1bHQiLCJpZCIsImNsYXNzZXMiLCJhdHRycyIsInJlbWFpbmluZyIsInRyaW0iLCJFcnJvciIsInRlc3QiLCJ0YWdNYXRjaCIsImV4ZWMiLCJzbGljZSIsImlkTWF0Y2giLCJjbGFzc01hdGNoIiwiX3JlZiIsImF0dHJNYXRjaCIsIm5hbWUiLCJkb3VibGVRdW90ZWRWYWx1ZSIsInNpbmdsZVF1b3RlZFZhbHVlIiwiYmFyZVZhbHVlIiwic3BsaXRDc3NTZWxlY3RvciIsImN1cnJlbnQiLCJxdW90ZSIsImJyYWNrZXREZXB0aCIsImNoIiwiY3NzU2VsZWN0b3JUb1hwYXRoIiwic3RlcHMiLCJ4cGF0aFN0ZXBzIiwibWFwIiwicGFyc2VkIiwicHJlZGljYXRlcyIsInRhZ0xpdGVyYWwiLCJjbHMiLCJhdHRyIiwidW5kZWZpbmVkIiwiYnVpbGRYcGF0aEZyb21TdHJhdGVneSIsInN0clNlbGVjdG9yIiwic2VsZWN0b3JMaXRlcmFsIiwicGFyc2VSZWN0IiwibWF0Y2giLCJ4IiwieSIsIndpZHRoIiwiaGVpZ2h0IiwiZ3JvdXBzIiwiTnVtYmVyIiwicGFyc2VJbnQiLCJub2RlUHJpb3JpdHlTY29yZSIsIm5vZGUiLCJfYXR0cnMkc3RhdGVzIiwiYXR0cmlidXRlcyIsIk5FR0FUSVZFX0lORklOSVRZIiwiQXJyYXkiLCJmcm9tIiwic3RhdGVzIiwidG9VcHBlckNhc2UiLCJzY29yZSIsInJlY3QiLCJNYXRoIiwibWluIiwiZ2V0V2luZG93U2NvcGVkSGllcmFyY2h5IiwiYXBpcyIsInBpZCIsIndpZCIsImhpZXJhcmNoeSIsImExMXlfZ2V0V2luZG93VWlIaWVyYWNoeSIsImExMXlfZ2V0V2luZG93VWlIaWVyYWNoeUJ5SGFuZGxlIiwiYTExeV9nZXREZXNrdG9wVWlIaWVyYWNoeSIsIk5vU3VjaFdpbmRvd0Vycm9yIiwiX3ZhbGlkYXRlT3JVcGRhdGVXaW5JbmZvIiwibm93IiwiRGF0ZSIsIl93aW5WYWxpZGF0ZWRBdCIsIndpbkhpZXJhY2h5IiwiYXBwX2dldFdpbmRvd0hpZXJhY2h5IiwiZG9jIiwiZG9tIiwicGFyc2VGcm9tU3RyaW5nIiwibmFtZUxpdGVyYWwiLCJ4cGF0aCIsIm5vZGVzIiwic2VsZWN0Iiwid2luIiwiX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQiLCJfcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3ciLCJmaW5kRWxPckVscyIsIm11bHQiLCJjb250ZXh0IiwiYTExeUhpZXJhY2h5IiwiX3RoaXMkX3dpbiIsImN1cnJlbnRXaWQiLCJ3aW5kb3dDaGFuZ2VkIiwiX2xhc3RGaW5kV2lkIiwiX2xhc3RDYWNoZUNsZWFyQXQiLCJhMTF5X2NsZWFyX2NhY2hlIiwiX2NhY2hlIiwiZ2V0IiwiZXJyb3IiLCJfZGVza3RvcFhtbCIsIl9kZCIsIl9kbiIsIl9ub3ciLCJfY2FjaGVUcyIsIl9kZXNrdG9wSGllcmFyY2h5Q2FjaGVBdCIsIl91aVRzIiwiX2xhc3RVaUFjdGlvbkF0IiwiX2xhc3RGb3JjZSIsIl9sYXN0RGVza3RvcEZvcmNlU2NhbkF0IiwiX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUiLCJfZGQyIiwiX2RuMiIsInNvcnQiLCJhIiwiYiIsInNlcmlhbGl6ZXIiLCJYTUxTZXJpYWxpemVyIiwiZWxlbWVudHMiLCJzdHIiLCJzZXJpYWxpemVUb1N0cmluZyIsImtleSIsInV1aWR2NCIsInNldCIsIk5vU3VjaEVsZW1lbnRFcnJvciIsIl9kZWZhdWx0IiwiZGVmYXVsdCJdLCJzb3VyY2VSb290IjoiLi4vLi4vLi4iLCJzb3VyY2VzIjpbImxpYi9jb21tYW5kcy9maW5kLmpzIl0sInNvdXJjZXNDb250ZW50IjpbImltcG9ydCB7IGVycm9ycyB9IGZyb20gJ0BhcHBpdW0vYmFzZS1kcml2ZXInO1xuaW1wb3J0IHNlbGVjdCBmcm9tICd4cGF0aC5qcyc7XG5pbXBvcnQgeyBET01QYXJzZXIgYXMgZG9tLCBYTUxTZXJpYWxpemVyIH0gZnJvbSAneG1sZG9tJztcbmltcG9ydCB7IHY0IGFzIHV1aWR2NCB9IGZyb20gJ3V1aWQnO1xuXG5jb25zdCBjb21tYW5kcyA9IHt9O1xuY29uc3QgSEFORExFX1NDT1BFRF9XSU5ET1dfVE9LRU5TID0gWydkaWFsb2cnLCAnYWxlcnQnLCAnbW9kYWwnLCAnbm90aWZpY2F0aW9uJywgJ3BvcG92ZXInLCAncG9wdXAnLCAndG9vbHRpcCddO1xuZnVuY3Rpb24gZ2V0QXBpcyAoY3R4KSB7XG4gIGlmICghY3R4Py5fYmFja2VuZEFwaXMpIHtcbiAgICB0aHJvdyBuZXcgZXJyb3JzLlVua25vd25FcnJvcignTGludXggYmFja2VuZCBpcyBub3QgaW5pdGlhbGl6ZWQnKTtcbiAgfVxuICByZXR1cm4gY3R4Ll9iYWNrZW5kQXBpcztcbn1cblxuZnVuY3Rpb24gc2VsZWN0b3JUYXJnZXRzVHJhbnNpZW50V2luZG93IChzdHJhdGVneSwgc2VsZWN0b3IpIHtcbiAgaWYgKGAke3N0cmF0ZWd5ID8/ICcnfWAgIT09ICd4cGF0aCcpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgY29uc3Qgbm9ybWFsaXplZCA9IGAke3NlbGVjdG9yID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiBIQU5ETEVfU0NPUEVEX1dJTkRPV19UT0tFTlMuc29tZSgodG9rZW4pID0+IG5vcm1hbGl6ZWQuaW5jbHVkZXMoYC8vJHt0b2tlbn1gKSB8fCBub3JtYWxpemVkLmluY2x1ZGVzKGA6OiR7dG9rZW59YCkpO1xufVxuXG5mdW5jdGlvbiBzaG91bGRQcmVmZXJIYW5kbGVTY29wZWRIaWVyYXJjaHkgKGN0eCwgc3RyYXRlZ3ksIHNlbGVjdG9yKSB7XG4gIGlmIChjdHg/LmxpbnV4QmFja2VuZCAhPT0gJ3dheWxhbmQnKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IHRhZyA9IGAke2N0eD8uX3dpbj8udGFnID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3Qgd2luZG93VHlwZSA9IGAke2N0eD8uX3dpbj8ud2luZG93VHlwZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChIQU5ETEVfU0NPUEVEX1dJTkRPV19UT0tFTlMuc29tZSgodG9rZW4pID0+IHRhZy5pbmNsdWRlcyh0b2tlbikgfHwgd2luZG93VHlwZS5pbmNsdWRlcyh0b2tlbikpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgcmV0dXJuIHNlbGVjdG9yVGFyZ2V0c1RyYW5zaWVudFdpbmRvdyhzdHJhdGVneSwgc2VsZWN0b3IpO1xufVxuXG5mdW5jdGlvbiB0b1hQYXRoTGl0ZXJhbCAodmFsdWUpIHtcbiAgY29uc3Qgc3RyaW5nVmFsdWUgPSBgJHt2YWx1ZX1gO1xuICBpZiAoIXN0cmluZ1ZhbHVlLmluY2x1ZGVzKCdcIicpKSB7XG4gICAgcmV0dXJuIGBcIiR7c3RyaW5nVmFsdWV9XCJgO1xuICB9XG4gIGlmICghc3RyaW5nVmFsdWUuaW5jbHVkZXMoJ1xcJycpKSB7XG4gICAgcmV0dXJuIGAnJHtzdHJpbmdWYWx1ZX0nYDtcbiAgfVxuICBjb25zdCBwYXJ0cyA9IHN0cmluZ1ZhbHVlLnNwbGl0KCdcIicpO1xuICBjb25zdCB4cGF0aFBhcnRzID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcGFydHMubGVuZ3RoOyBpKyspIHtcbiAgICB4cGF0aFBhcnRzLnB1c2goYFwiJHtwYXJ0c1tpXX1cImApO1xuICAgIGlmIChpIDwgcGFydHMubGVuZ3RoIC0gMSkge1xuICAgICAgeHBhdGhQYXJ0cy5wdXNoKGAnXCInYCk7XG4gICAgfVxuICB9XG4gIHJldHVybiBgY29uY2F0KCR7eHBhdGhQYXJ0cy5qb2luKCcsICcpfSlgO1xufVxuXG5mdW5jdGlvbiBjbGFzc1Rva2VuRXhwciAodG9rZW4pIHtcbiAgcmV0dXJuIGBjb250YWlucyhjb25jYXQoXCIgXCIsIG5vcm1hbGl6ZS1zcGFjZShAY2xhc3MpLCBcIiBcIiksICR7dG9YUGF0aExpdGVyYWwoYCAke3Rva2VufSBgKX0pYDtcbn1cblxuZnVuY3Rpb24gY3JlYXRlSW52YWxpZFNlbGVjdG9yRXJyb3IgKG1lc3NhZ2UpIHtcbiAgaWYgKGVycm9ycy5JbnZhbGlkU2VsZWN0b3JFcnJvcikge1xuICAgIHJldHVybiBuZXcgZXJyb3JzLkludmFsaWRTZWxlY3RvckVycm9yKG1lc3NhZ2UpO1xuICB9XG4gIHJldHVybiBuZXcgZXJyb3JzLlVua25vd25FcnJvcihtZXNzYWdlKTtcbn1cblxuZnVuY3Rpb24gcGFyc2VDc3NTdGVwIChzdGVwKSB7XG4gIGNvbnN0IHJlc3VsdCA9IHtcbiAgICB0YWc6ICcqJyxcbiAgICBpZDogbnVsbCxcbiAgICBjbGFzc2VzOiBbXSxcbiAgICBhdHRyczogW10sXG4gIH07XG4gIGxldCByZW1haW5pbmcgPSBzdGVwLnRyaW0oKTtcbiAgaWYgKCFyZW1haW5pbmcpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ0VtcHR5IENTUyBzZWxlY3RvciBzdGVwJyk7XG4gIH1cbiAgaWYgKC9bPit+LF0vLnRlc3QocmVtYWluaW5nKSkge1xuICAgIHRocm93IG5ldyBFcnJvcignT25seSBkZXNjZW5kYW50IGNvbWJpbmF0b3IgaXMgc3VwcG9ydGVkIGZvciBjc3Mgc2VsZWN0b3InKTtcbiAgfVxuXG4gIGNvbnN0IHRhZ01hdGNoID0gL14oW2EtekEtWl9dW1xcdy1dKnxcXCopLy5leGVjKHJlbWFpbmluZyk7XG4gIGlmICh0YWdNYXRjaCkge1xuICAgIHJlc3VsdC50YWcgPSB0YWdNYXRjaFsxXTtcbiAgICByZW1haW5pbmcgPSByZW1haW5pbmcuc2xpY2UodGFnTWF0Y2hbMF0ubGVuZ3RoKTtcbiAgfVxuXG4gIHdoaWxlIChyZW1haW5pbmcubGVuZ3RoID4gMCkge1xuICAgIGlmIChyZW1haW5pbmdbMF0gPT09ICcjJykge1xuICAgICAgY29uc3QgaWRNYXRjaCA9IC9eIyhbYS16QS1aX11bXFx3LV0qKS8uZXhlYyhyZW1haW5pbmcpO1xuICAgICAgaWYgKCFpZE1hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgTWFsZm9ybWVkIGlkIHNlbGVjdG9yIHNlZ21lbnQgaW4gJyR7c3RlcH0nYCk7XG4gICAgICB9XG4gICAgICByZXN1bHQuaWQgPSBpZE1hdGNoWzFdO1xuICAgICAgcmVtYWluaW5nID0gcmVtYWluaW5nLnNsaWNlKGlkTWF0Y2hbMF0ubGVuZ3RoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAocmVtYWluaW5nWzBdID09PSAnLicpIHtcbiAgICAgIGNvbnN0IGNsYXNzTWF0Y2ggPSAvXlxcLihbYS16QS1aX11bXFx3LV0qKS8uZXhlYyhyZW1haW5pbmcpO1xuICAgICAgaWYgKCFjbGFzc01hdGNoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgTWFsZm9ybWVkIGNsYXNzIHNlbGVjdG9yIHNlZ21lbnQgaW4gJyR7c3RlcH0nYCk7XG4gICAgICB9XG4gICAgICByZXN1bHQuY2xhc3Nlcy5wdXNoKGNsYXNzTWF0Y2hbMV0pO1xuICAgICAgcmVtYWluaW5nID0gcmVtYWluaW5nLnNsaWNlKGNsYXNzTWF0Y2hbMF0ubGVuZ3RoKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAocmVtYWluaW5nWzBdID09PSAnWycpIHtcbiAgICAgIGNvbnN0IGF0dHJNYXRjaCA9IC9eXFxbXFxzKihbXlxcXT1+XiQqfFxcc10rKVxccyooPzo9XFxzKig/OlwiKFteXCJdKilcInwnKFteJ10qKSd8KFteXFxdXFxzXSspKVxccyopP1xcXS8uZXhlYyhyZW1haW5pbmcpO1xuICAgICAgaWYgKCFhdHRyTWF0Y2gpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBNYWxmb3JtZWQgYXR0cmlidXRlIHNlbGVjdG9yIHNlZ21lbnQgaW4gJyR7c3RlcH0nYCk7XG4gICAgICB9XG4gICAgICBjb25zdCBbLCBuYW1lLCBkb3VibGVRdW90ZWRWYWx1ZSwgc2luZ2xlUXVvdGVkVmFsdWUsIGJhcmVWYWx1ZV0gPSBhdHRyTWF0Y2g7XG4gICAgICBjb25zdCB2YWx1ZSA9IGRvdWJsZVF1b3RlZFZhbHVlID8/IHNpbmdsZVF1b3RlZFZhbHVlID8/IGJhcmVWYWx1ZTtcbiAgICAgIHJlc3VsdC5hdHRycy5wdXNoKHtuYW1lLCB2YWx1ZX0pO1xuICAgICAgcmVtYWluaW5nID0gcmVtYWluaW5nLnNsaWNlKGF0dHJNYXRjaFswXS5sZW5ndGgpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY3NzIHNlbGVjdG9yIHNlZ21lbnQgJyR7cmVtYWluaW5nfSdgKTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbmZ1bmN0aW9uIHNwbGl0Q3NzU2VsZWN0b3IgKHNlbGVjdG9yKSB7XG4gIGNvbnN0IHBhcnRzID0gW107XG4gIGxldCBjdXJyZW50ID0gJyc7XG4gIGxldCBxdW90ZSA9IG51bGw7XG4gIGxldCBicmFja2V0RGVwdGggPSAwO1xuICBmb3IgKGNvbnN0IGNoIG9mIHNlbGVjdG9yLnRyaW0oKSkge1xuICAgIGlmIChxdW90ZSkge1xuICAgICAgY3VycmVudCArPSBjaDtcbiAgICAgIGlmIChjaCA9PT0gcXVvdGUpIHtcbiAgICAgICAgcXVvdGUgPSBudWxsO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gJ1wiJyB8fCBjaCA9PT0gJ1xcJycpIHtcbiAgICAgIHF1b3RlID0gY2g7XG4gICAgICBjdXJyZW50ICs9IGNoO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChjaCA9PT0gJ1snKSB7XG4gICAgICBicmFja2V0RGVwdGggKz0gMTtcbiAgICAgIGN1cnJlbnQgKz0gY2g7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoID09PSAnXScpIHtcbiAgICAgIGJyYWNrZXREZXB0aCAtPSAxO1xuICAgICAgY3VycmVudCArPSBjaDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoL1xccy8udGVzdChjaCkgJiYgYnJhY2tldERlcHRoID09PSAwKSB7XG4gICAgICBpZiAoY3VycmVudC50cmltKCkpIHtcbiAgICAgICAgcGFydHMucHVzaChjdXJyZW50LnRyaW0oKSk7XG4gICAgICB9XG4gICAgICBjdXJyZW50ID0gJyc7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY3VycmVudCArPSBjaDtcbiAgfVxuICBpZiAoY3VycmVudC50cmltKCkpIHtcbiAgICBwYXJ0cy5wdXNoKGN1cnJlbnQudHJpbSgpKTtcbiAgfVxuICBpZiAocGFydHMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdFbXB0eSBjc3Mgc2VsZWN0b3InKTtcbiAgfVxuICByZXR1cm4gcGFydHM7XG59XG5cbmZ1bmN0aW9uIGNzc1NlbGVjdG9yVG9YcGF0aCAoc2VsZWN0b3IpIHtcbiAgY29uc3Qgc3RlcHMgPSBzcGxpdENzc1NlbGVjdG9yKGAke3NlbGVjdG9yfWApO1xuICBjb25zdCB4cGF0aFN0ZXBzID0gc3RlcHMubWFwKChzdGVwKSA9PiB7XG4gICAgY29uc3QgcGFyc2VkID0gcGFyc2VDc3NTdGVwKHN0ZXApO1xuICAgIGNvbnN0IHByZWRpY2F0ZXMgPSBbXTtcbiAgICBpZiAocGFyc2VkLnRhZyAhPT0gJyonKSB7XG4gICAgICBjb25zdCB0YWdMaXRlcmFsID0gdG9YUGF0aExpdGVyYWwocGFyc2VkLnRhZyk7XG4gICAgICBwcmVkaWNhdGVzLnB1c2goYChuYW1lKCk9JHt0YWdMaXRlcmFsfSBvciBAdGFnPSR7dGFnTGl0ZXJhbH0pYCk7XG4gICAgfVxuICAgIGlmIChwYXJzZWQuaWQpIHtcbiAgICAgIHByZWRpY2F0ZXMucHVzaChgQGlkPSR7dG9YUGF0aExpdGVyYWwocGFyc2VkLmlkKX1gKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBjbHMgb2YgcGFyc2VkLmNsYXNzZXMpIHtcbiAgICAgIHByZWRpY2F0ZXMucHVzaChjbGFzc1Rva2VuRXhwcihjbHMpKTtcbiAgICB9XG4gICAgZm9yIChjb25zdCBhdHRyIG9mIHBhcnNlZC5hdHRycykge1xuICAgICAgaWYgKGF0dHIudmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICBwcmVkaWNhdGVzLnB1c2goYEAke2F0dHIubmFtZX1gKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHByZWRpY2F0ZXMucHVzaChgQCR7YXR0ci5uYW1lfT0ke3RvWFBhdGhMaXRlcmFsKGF0dHIudmFsdWUpfWApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gcHJlZGljYXRlcy5sZW5ndGggPiAwXG4gICAgICA/IGAqWyR7cHJlZGljYXRlcy5qb2luKCcgYW5kICcpfV1gXG4gICAgICA6ICcqJztcbiAgfSk7XG4gIHJldHVybiBgLy8ke3hwYXRoU3RlcHMuam9pbignLy8nKX1gO1xufVxuXG5mdW5jdGlvbiBidWlsZFhwYXRoRnJvbVN0cmF0ZWd5IChzdHJhdGVneSwgc2VsZWN0b3IpIHtcbiAgY29uc3Qgc3RyU2VsZWN0b3IgPSBgJHtzZWxlY3Rvcn1gO1xuICBjb25zdCBzZWxlY3RvckxpdGVyYWwgPSB0b1hQYXRoTGl0ZXJhbChzdHJTZWxlY3Rvcik7XG4gIHN3aXRjaCAoc3RyYXRlZ3kpIHtcbiAgICBjYXNlICduYW1lJzpcbiAgICAgIHJldHVybiBgLy8qW0BuYW1lPSR7c2VsZWN0b3JMaXRlcmFsfV1gO1xuICAgIGNhc2UgJ2NsYXNzIG5hbWUnOlxuICAgICAgcmV0dXJuIGAvLypbJHtjbGFzc1Rva2VuRXhwcihzdHJTZWxlY3Rvcil9XWA7XG4gICAgY2FzZSAnaWQnOlxuICAgICAgcmV0dXJuIGAvLypbQGlkPSR7c2VsZWN0b3JMaXRlcmFsfV1gO1xuICAgIGNhc2UgJ2FjY2Vzc2liaWxpdHkgaWQnOlxuICAgICAgcmV0dXJuIGAvLypbQG5hbWU9JHtzZWxlY3RvckxpdGVyYWx9IG9yIEBsYWJlbD0ke3NlbGVjdG9yTGl0ZXJhbH0gb3IgQGFjY2Vzc2liaWxpdHktaWQ9JHtzZWxlY3RvckxpdGVyYWx9XWA7XG4gICAgY2FzZSAndGFnIG5hbWUnOlxuICAgICAgcmV0dXJuIGAvLypbbmFtZSgpPSR7c2VsZWN0b3JMaXRlcmFsfSBvciBAdGFnPSR7c2VsZWN0b3JMaXRlcmFsfV1gO1xuICAgIGNhc2UgJ2xpbmsgdGV4dCc6XG4gICAgICByZXR1cm4gYC8vKlsobmFtZSgpPVwiYVwiIG9yIEB0YWc9XCJhXCIpIGFuZCAoQG5hbWU9JHtzZWxlY3RvckxpdGVyYWx9IG9yIEB0ZXh0PSR7c2VsZWN0b3JMaXRlcmFsfSBvciBub3JtYWxpemUtc3BhY2UoLik9JHtzZWxlY3RvckxpdGVyYWx9KV1gO1xuICAgIGNhc2UgJ3BhcnRpYWwgbGluayB0ZXh0JzpcbiAgICAgIHJldHVybiBgLy8qWyhuYW1lKCk9XCJhXCIgb3IgQHRhZz1cImFcIikgYW5kIChjb250YWlucyhAbmFtZSwgJHtzZWxlY3RvckxpdGVyYWx9KSBvciBjb250YWlucyhAdGV4dCwgJHtzZWxlY3RvckxpdGVyYWx9KSBvciBjb250YWlucyhub3JtYWxpemUtc3BhY2UoLiksICR7c2VsZWN0b3JMaXRlcmFsfSkpXWA7XG4gICAgY2FzZSAnY3NzIHNlbGVjdG9yJzpcbiAgICAgIHJldHVybiBjc3NTZWxlY3RvclRvWHBhdGgoc3RyU2VsZWN0b3IpO1xuICAgIGNhc2UgJ3hwYXRoJzpcbiAgICAgIHJldHVybiBzdHJTZWxlY3RvcjtcbiAgICBkZWZhdWx0OlxuICAgICAgdGhyb3cgY3JlYXRlSW52YWxpZFNlbGVjdG9yRXJyb3IoYFVuc3VwcG9ydGVkIGxvY2F0b3Igc3RyYXRlZ3kgJyR7c3RyYXRlZ3l9J2ApO1xuICB9XG59XG5cbmZ1bmN0aW9uIHBhcnNlUmVjdCAodmFsdWUpIHtcbiAgY29uc3QgbWF0Y2ggPSAvXlxcWyg/PHg+LT9cXGQrKSwoPzx5Pi0/XFxkKyksKD88d2lkdGg+XFxkKyksKD88aGVpZ2h0PlxcZCspXFxdJC8uZXhlYyhgJHt2YWx1ZSA/PyAnJ31gKTtcbiAgaWYgKCFtYXRjaCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGNvbnN0IHt4LCB5LCB3aWR0aCwgaGVpZ2h0fSA9IG1hdGNoLmdyb3VwcztcbiAgcmV0dXJuIHtcbiAgICB4OiBOdW1iZXIucGFyc2VJbnQoeCwgMTApLFxuICAgIHk6IE51bWJlci5wYXJzZUludCh5LCAxMCksXG4gICAgd2lkdGg6IE51bWJlci5wYXJzZUludCh3aWR0aCwgMTApLFxuICAgIGhlaWdodDogTnVtYmVyLnBhcnNlSW50KGhlaWdodCwgMTApLFxuICB9O1xufVxuXG5mdW5jdGlvbiBub2RlUHJpb3JpdHlTY29yZSAobm9kZSkge1xuICBpZiAoIW5vZGU/LmF0dHJpYnV0ZXMpIHtcbiAgICByZXR1cm4gTnVtYmVyLk5FR0FUSVZFX0lORklOSVRZO1xuICB9XG4gIGNvbnN0IGF0dHJzID0ge307XG4gIGZvciAoY29uc3QgYXR0ciBvZiBBcnJheS5mcm9tKG5vZGUuYXR0cmlidXRlcykpIHtcbiAgICBhdHRyc1thdHRyLm5hbWVdID0gYXR0ci52YWx1ZTtcbiAgfVxuICBjb25zdCBzdGF0ZXMgPSBgJHthdHRycy5zdGF0ZXMgPz8gJyd9YC50b1VwcGVyQ2FzZSgpO1xuICBsZXQgc2NvcmUgPSAwO1xuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdTSE9XSU5HJykgfHwgc3RhdGVzLmluY2x1ZGVzKCdWSVNJQkxFJykpIHtcbiAgICBzY29yZSArPSAyMDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnRU5BQkxFRCcpIHx8IHN0YXRlcy5pbmNsdWRlcygnU0VOU0lUSVZFJykpIHtcbiAgICBzY29yZSArPSA0MDtcbiAgfVxuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdGT0NVU0VEJykgfHwgc3RhdGVzLmluY2x1ZGVzKCdBQ1RJVkUnKSkge1xuICAgIHNjb3JlICs9IDI1O1xuICB9XG5cbiAgY29uc3QgcmVjdCA9IHBhcnNlUmVjdChhdHRycy5yZWN0KTtcbiAgaWYgKHJlY3QgJiYgcmVjdC53aWR0aCA+IDAgJiYgcmVjdC5oZWlnaHQgPiAwKSB7XG4gICAgc2NvcmUgKz0gTWF0aC5taW4ocmVjdC53aWR0aCAqIHJlY3QuaGVpZ2h0LCA0MDAwMDAwKSAvIDEwMDAwO1xuICAgIGlmIChyZWN0LnggPCAtMTAwMDAwMCB8fCByZWN0LnkgPCAtMTAwMDAwMCkge1xuICAgICAgc2NvcmUgLT0gNTAwO1xuICAgIH1cbiAgfSBlbHNlIHtcbiAgICBzY29yZSAtPSA2MDtcbiAgfVxuICByZXR1cm4gc2NvcmU7XG59XG5cbmZ1bmN0aW9uIGdldFdpbmRvd1Njb3BlZEhpZXJhcmNoeSAoY3R4LCBhcGlzLCBzdHJhdGVneSwgc2VsZWN0b3IpIHtcbiAgY29uc3Qge3BpZCwgbmFtZSwgd2lkfSA9IGN0eC5fd2luO1xuICBsZXQgaGllcmFyY2h5ID0gbnVsbDtcbiAgaWYgKHNob3VsZFByZWZlckhhbmRsZVNjb3BlZEhpZXJhcmNoeShjdHgsIHN0cmF0ZWd5LCBzZWxlY3RvcikpIHtcbiAgICAvLyBGYXN0IHBhdGg6IHRyeSBuYXRpdmUgcGVyLXdpbmRvdyBBVC1TUEkgY2FsbCBmaXJzdC4gIFRoaXMgcmV0dXJucyBmcmVzaFxuICAgIC8vIGVsZW1lbnQgZGF0YSAofjIwMG1zKSB3aXRob3V0IG5lZWRpbmcgdGhlIGZ1bGwgZGVza3RvcCBoaWVyYXJjaHkuICBUaGVcbiAgICAvLyBoYW5kbGUtc2NvcGVkIGZhbGxiYWNrIHVzZXMgY2FjaGVkIGRlc2t0b3AgWE1MIHdoaWNoIG1heSBoYXZlIHN0YWxlXG4gICAgLy8gZWxlbWVudCBzdGF0ZXMgYWZ0ZXIgVUkgYWN0aW9ucyAoY2xpY2svc2V0VmFsdWUvY2xlYXIpLlxuICAgIGhpZXJhcmNoeSA9IGFwaXMuYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5KG5hbWUsIHBpZCk7XG4gICAgaWYgKCghaGllcmFyY2h5IHx8ICFgJHtoaWVyYXJjaHl9YC50cmltKCkpICYmIHR5cGVvZiBhcGlzLmExMXlfZ2V0V2luZG93VWlIaWVyYWNoeUJ5SGFuZGxlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBoaWVyYXJjaHkgPSBhcGlzLmExMXlfZ2V0V2luZG93VWlIaWVyYWNoeUJ5SGFuZGxlKHdpZCwgcGlkLCBuYW1lKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaGllcmFyY2h5ID0gYXBpcy5hMTF5X2dldFdpbmRvd1VpSGllcmFjaHkobmFtZSwgcGlkKTtcbiAgICBpZiAoKCFoaWVyYXJjaHkgfHwgIWAke2hpZXJhcmNoeX1gLnRyaW0oKSkgJiYgY3R4LmxpbnV4QmFja2VuZCA9PT0gJ3dheWxhbmQnKSB7XG4gICAgICBpZiAodHlwZW9mIGFwaXMuYTExeV9nZXRXaW5kb3dVaUhpZXJhY2h5QnlIYW5kbGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgaGllcmFyY2h5ID0gYXBpcy5hMTF5X2dldFdpbmRvd1VpSGllcmFjaHlCeUhhbmRsZSh3aWQsIHBpZCwgbmFtZSk7XG4gICAgICB9XG4gICAgfVxuICB9XG4gIC8vIFdheWxhbmQgdWx0aW1hdGUgZmFsbGJhY2s6IHVzZSB0aGUgZnVsbCBkZXNrdG9wIGFjY2Vzc2liaWxpdHkgaGllcmFyY2h5IHdoZW5cbiAgLy8gYm90aCB3aW5kb3ctc2NvcGVkIGFuZCBoYW5kbGUtc2NvcGVkIGxvb2t1cHMgcmV0dXJuIG5vdGhpbmcuICBUaGlzIGNvdmVyc1xuICAvLyBSSEVML0dOT01FIHNjZW5hcmlvcyB3aGVyZSBBVC1TUEkgd2luZG93IG5hbWVzIGRvbid0IG1hdGNoIHRoZSBleHBlY3RlZFxuICAvLyBpZGVudGlmaWVycyBpbW1lZGlhdGVseSBhZnRlciBsYXVuY2ggb3IgZGlhbG9nIHRyYW5zaXRpb25zLlxuICBpZiAoKCFoaWVyYXJjaHkgfHwgIWAke2hpZXJhcmNoeX1gLnRyaW0oKSkgJiYgY3R4LmxpbnV4QmFja2VuZCA9PT0gJ3dheWxhbmQnKSB7XG4gICAgaWYgKHR5cGVvZiBhcGlzLmExMXlfZ2V0RGVza3RvcFVpSGllcmFjaHkgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgIGhpZXJhcmNoeSA9IGFwaXMuYTExeV9nZXREZXNrdG9wVWlIaWVyYWNoeSgpO1xuICAgIH1cbiAgfVxuICBpZiAoIWhpZXJhcmNoeSB8fCAhYCR7aGllcmFyY2h5fWAudHJpbSgpKSB7XG4gICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihcbiAgICAgIGB0aGUgc2VsZWN0ZWQgd2luZG93IGRvZXNuJ3QgZXhpc3QgKHdpZD0ke3dpZH0sIHBpZD0ke3BpZH0sIG5hbWU9JHtuYW1lfSlgXG4gICAgKTtcbiAgfVxuICByZXR1cm4gaGllcmFyY2h5O1xufVxuXG5jb21tYW5kcy5fdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8gPSBmdW5jdGlvbiAoKSB7XG4gIC8vIFNob3J0LWxpdmVkIGNhY2hlOiBpZiB3ZSB2YWxpZGF0ZWQgd2l0aGluIHRoZSBsYXN0IDUgc2Vjb25kcywgc2tpcCB0aGVcbiAgLy8gZXhwZW5zaXZlIGFwcF9nZXRXaW5kb3dIaWVyYWNoeSgpIGNhbGwuICBUaGUgd2luZG93IGRvZXNuJ3QgbW92ZS9jbG9zZVxuICAvLyBiZXR3ZWVuIHJhcGlkIGZpbmRfZWxlbWVudCBwb2xscy5cbiAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgaWYgKHRoaXMuX3dpblZhbGlkYXRlZEF0ICYmIChub3cgLSB0aGlzLl93aW5WYWxpZGF0ZWRBdCkgPCA1MDAwKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbiAgY29uc3QgYXBpcyA9IGdldEFwaXModGhpcyk7XG4gIGNvbnN0IHtwaWQsIHdpZCwgbmFtZX0gPSB0aGlzLl93aW47XG4gIGNvbnN0IHdpbkhpZXJhY2h5ID0gYXBpcy5hcHBfZ2V0V2luZG93SGllcmFjaHkoKTtcbiAgY29uc3QgZG9jID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyh3aW5IaWVyYWNoeSk7XG4gIGNvbnN0IG5hbWVMaXRlcmFsID0gdG9YUGF0aExpdGVyYWwobmFtZSk7XG4gIGxldCB4cGF0aCA9IGAvLypbQHBpZD1cIiR7cGlkfVwiIGFuZCBAd2lkPVwiJHt3aWR9XCIgYW5kIEBJbnB1dE91dHB1dD1cInRydWVcIiBhbmQgKEBuYW1lPSR7bmFtZUxpdGVyYWx9IG9yICR7Y2xhc3NUb2tlbkV4cHIobmFtZSl9KV1gO1xuICBjb25zdCBub2RlcyA9IHNlbGVjdChkb2MsIHhwYXRoKTtcbiAgaWYgKG5vZGVzICYmIG5vZGVzLmxlbmd0aCA+IDApIHtcbiAgICB0aGlzLl93aW5WYWxpZGF0ZWRBdCA9IG5vdztcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICB0cnkge1xuICAgIGNvbnN0IHdpbiA9IHRoaXMuX2dldFdpbkFuZFBpZF9Gcm9tV2luSWQod2lkKTtcbiAgICB0aGlzLl93aW4gPSB3aW47XG4gIH0gY2F0Y2gge1xuICAgIGlmICh0aGlzLmxpbnV4QmFja2VuZCA9PT0gJ3dheWxhbmQnICYmIHR5cGVvZiB0aGlzLl9yZXNvbHZlQmVzdEF2YWlsYWJsZVdpbmRvdyA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcmV0dXJuICEhdGhpcy5fcmVzb2x2ZUJlc3RBdmFpbGFibGVXaW5kb3coKTtcbiAgICB9XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHRoaXMuX3dpblZhbGlkYXRlZEF0ID0gbm93O1xuICByZXR1cm4gdHJ1ZTtcbn07XG5cbmNvbW1hbmRzLmZpbmRFbE9yRWxzID0gZnVuY3Rpb24gZmluZEVsT3JFbHMgKHN0cmF0ZWd5LCBzZWxlY3RvciwgbXVsdCwgY29udGV4dCkge1xuICBjb25zdCBhcGlzID0gZ2V0QXBpcyh0aGlzKTtcbiAgbGV0IGExMXlIaWVyYWNoeSA9IG51bGw7XG4gIGlmICghY29udGV4dCkge1xuICAgIC8vIFJhdGUtbGltaXQgbmF0aXZlIEFULVNQSSBjYWNoZSBjbGVhcnMgdG8gb25jZSBwZXIgMnMgd2l0aGluIHRoZSBTQU1FXG4gICAgLy8gd2luZG93LiAgRm9yY2UgYSBjbGVhciB3aGVuIHRoZSBhY3RpdmUgd2luZG93IGNoYW5nZWQgKHNldFdpbmRvdyB3YXNcbiAgICAvLyBjYWxsZWQpIHNvIHdlIGdldCBmcmVzaCBBVC1TUEkgZGF0YSBmb3IgdGhlIG5ldyB3aW5kb3cuXG4gICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcbiAgICBjb25zdCBjdXJyZW50V2lkID0gdGhpcy5fd2luPy53aWQ7XG4gICAgY29uc3Qgd2luZG93Q2hhbmdlZCA9IGN1cnJlbnRXaWQgJiYgY3VycmVudFdpZCAhPT0gdGhpcy5fbGFzdEZpbmRXaWQ7XG4gICAgaWYgKHdpbmRvd0NoYW5nZWQgfHwgIXRoaXMuX2xhc3RDYWNoZUNsZWFyQXQgfHwgKG5vdyAtIHRoaXMuX2xhc3RDYWNoZUNsZWFyQXQpID49IDIwMDApIHtcbiAgICAgIGFwaXMuYTExeV9jbGVhcl9jYWNoZSgpO1xuICAgICAgdGhpcy5fbGFzdENhY2hlQ2xlYXJBdCA9IG5vdztcbiAgICB9XG4gICAgdGhpcy5fbGFzdEZpbmRXaWQgPSBjdXJyZW50V2lkO1xuICAgIGlmICghdGhpcy5fdmFsaWRhdGVPclVwZGF0ZVdpbkluZm8oKSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Ob1N1Y2hXaW5kb3dFcnJvcihgdGhlIHNlbGVjdGVkIHdpbmRvdyBkb2Vzbid0IGV4aXN0YCk7XG4gICAgfVxuICAgIGExMXlIaWVyYWNoeSA9IGdldFdpbmRvd1Njb3BlZEhpZXJhcmNoeSh0aGlzLCBhcGlzLCBzdHJhdGVneSwgc2VsZWN0b3IpO1xuICB9IGVsc2Uge1xuICAgIGExMXlIaWVyYWNoeSA9IHRoaXMuX2NhY2hlLmdldChjb250ZXh0KTtcbiAgICBpZiAoIWExMXlIaWVyYWNoeSkge1xuICAgICAgdGhyb3cgbmV3IGVycm9ycy5Vbmtub3duRXJyb3IoYGNvbnRleHQgJHtjb250ZXh0fSBoYXMgZXhwaXJlZGApO1xuICAgIH1cbiAgfVxuICBjb25zdCBkb2MgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKGExMXlIaWVyYWNoeSk7XG5cbiAgY29uc3QgeHBhdGggPSBidWlsZFhwYXRoRnJvbVN0cmF0ZWd5KHN0cmF0ZWd5LCBzZWxlY3Rvcik7XG5cbiAgbGV0IG5vZGVzID0gW107XG4gIHRyeSB7XG4gICAgbm9kZXMgPSBzZWxlY3QoZG9jLCB4cGF0aCk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgdGhyb3cgY3JlYXRlSW52YWxpZFNlbGVjdG9yRXJyb3IoXG4gICAgICBgQ291bGQgbm90IGxvY2F0ZSBlbGVtZW50IGJ5IHN0cmF0ZWd5ICcke3N0cmF0ZWd5fScgd2l0aCBzZWxlY3RvciAnJHtzZWxlY3Rvcn0nLiBgICtcbiAgICAgIGBYUGF0aCB3YXMgJyR7eHBhdGh9Jy4gT3JpZ2luYWwgZXJyb3I6ICR7ZXJyb3IubWVzc2FnZX1gXG4gICAgKTtcbiAgfVxuICBpZiAoIW5vZGVzIHx8IG5vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgIG5vZGVzID0gW107XG4gICAgLy8gV2F5bGFuZCBmYWxsYmFjazogd2hlbiBhIHdpbmRvdy1zY29wZWQgc2VhcmNoIHJldHVybnMgbm8gcmVzdWx0cywgcmV0cnlcbiAgICAvLyBhZ2FpbnN0IHRoZSBmdWxsIGRlc2t0b3AgQVQtU1BJIHRyZWUuICBHVEsgbW9kYWwvdHJhbnNpZW50IGRpYWxvZ3NcbiAgICAvLyAoZS5nLiBcIkFkZCBTZXJ2ZXJcIikgbWF5IG5vdCByZWdpc3RlciBhcyBzZXBhcmF0ZSBjb21wb3NpdG9yIHdpbmRvd3MsIHNvXG4gICAgLy8gZ2V0V2luZG93SGFuZGxlcyBuZXZlciBkaXNjb3ZlcnMgdGhlbSBhbmQgdGhlIHdpbmRvdy1zY29wZWQgaGllcmFyY2h5XG4gICAgLy8gb25seSBjb3ZlcnMgdGhlIHBhcmVudCB3aW5kb3cuICBUaGUgZGVza3RvcCB0cmVlIGFsd2F5cyBjb250YWlucyB0aGVzZVxuICAgIC8vIGRpYWxvZ3MgYmVjYXVzZSBBVC1TUEkgcmVwb3J0cyB0aGVtIHJlZ2FyZGxlc3Mgb2YgY29tcG9zaXRvciBzdGF0ZS5cbiAgICAvL1xuICAgIC8vIFBlcmZvcm1hbmNlOiB0aGUgZGVza3RvcCBBVC1TUEkgc2NhbiBpcyBleHBlbnNpdmUgKDUtMzVzIGRlcGVuZGluZyBvblxuICAgIC8vIHRyZWUgc2l6ZSkuICBXZSBmaXJzdCB0cnkgdGhlIGNhY2hlZCBoaWVyYXJjaHkgKH4wbXMpIHdoaWNoIHdvcmtzIGZvclxuICAgIC8vIHJlcGVhdCBzZWFyY2hlcy4gIEEgZm9yY2VkIGNhY2hlIHJlZnJlc2ggb25seSBoYXBwZW5zIHdoZW46XG4gICAgLy8gICAoYSkgdGhlIGNhY2hlZCBzY2FuIGFsc28gbWlzc2VkLCBBTkRcbiAgICAvLyAgIChiKSBhIFVJIGFjdGlvbiAoY2xpY2svdHlwZSkgb2NjdXJyZWQgc2luY2UgdGhlIGxhc3QgY2FjaGUsIEFORFxuICAgIC8vICAgKGMpIGF0IGxlYXN0IDNzIGVsYXBzZWQgc2luY2UgdGhlIGxhc3QgZm9yY2VkIHJlZnJlc2guXG4gICAgLy8gVGhpcyBlbnN1cmVzIGF0IG1vc3Qgb25lIGV4cGVuc2l2ZSBzY2FuIHBlciBVSSB0cmFuc2l0aW9uLlxuICAgIGlmICghY29udGV4dCAmJiB0aGlzLmxpbnV4QmFja2VuZCA9PT0gJ3dheWxhbmQnKSB7XG4gICAgICB0cnkge1xuICAgICAgICAvLyAxLiBUcnkgY2FjaGVkIGRlc2t0b3AgaGllcmFyY2h5IGZpcnN0IChmYXN0IHBhdGgpXG4gICAgICAgIGxldCBfZGVza3RvcFhtbCA9IGFwaXMuYTExeV9nZXREZXNrdG9wVWlIaWVyYWNoeSgpO1xuICAgICAgICBpZiAoX2Rlc2t0b3BYbWwgJiYgYCR7X2Rlc2t0b3BYbWx9YC50cmltKCkpIHtcbiAgICAgICAgICBjb25zdCBfZGQgPSBuZXcgZG9tKCkucGFyc2VGcm9tU3RyaW5nKF9kZXNrdG9wWG1sKTtcbiAgICAgICAgICBjb25zdCBfZG4gPSBzZWxlY3QoX2RkLCB4cGF0aCk7XG4gICAgICAgICAgaWYgKF9kbiAmJiBfZG4ubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbm9kZXMgPSBfZG47XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIDIuIENhY2hlZCBtaXNzZWQg4oCUIGZvcmNlIE9ORSBmcmVzaCBzY2FuIGlmIGEgVUkgYWN0aW9uIGhhcHBlbmVkXG4gICAgICAgIC8vICAgIHNpbmNlIHRoZSBsYXN0IGNhY2hlIGFuZCB3ZSBoYXZlbid0IGZvcmNlZCByZWNlbnRseS5cbiAgICAgICAgaWYgKG5vZGVzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgIGNvbnN0IF9ub3cgPSBEYXRlLm5vdygpO1xuICAgICAgICAgIGNvbnN0IF9jYWNoZVRzID0gYXBpcy5fZGVza3RvcEhpZXJhcmNoeUNhY2hlQXQgfHwgMDtcbiAgICAgICAgICBjb25zdCBfdWlUcyA9IHRoaXMuX2xhc3RVaUFjdGlvbkF0IHx8IDA7XG4gICAgICAgICAgY29uc3QgX2xhc3RGb3JjZSA9IHRoaXMuX2xhc3REZXNrdG9wRm9yY2VTY2FuQXQgfHwgMDtcbiAgICAgICAgICBpZiAoX3VpVHMgPiBfY2FjaGVUcyAmJiAoX25vdyAtIF9sYXN0Rm9yY2UpID49IDMwMDApIHtcbiAgICAgICAgICAgIHRoaXMuX2xhc3REZXNrdG9wRm9yY2VTY2FuQXQgPSBfbm93O1xuICAgICAgICAgICAgaWYgKHR5cGVvZiBhcGlzLl9pbnZhbGlkYXRlRGVza3RvcEhpZXJhcmNoeUNhY2hlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgIGFwaXMuX2ludmFsaWRhdGVEZXNrdG9wSGllcmFyY2h5Q2FjaGUoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF9kZXNrdG9wWG1sID0gYXBpcy5hMTF5X2dldERlc2t0b3BVaUhpZXJhY2h5KCk7XG4gICAgICAgICAgICBpZiAoX2Rlc2t0b3BYbWwgJiYgYCR7X2Rlc2t0b3BYbWx9YC50cmltKCkpIHtcbiAgICAgICAgICAgICAgY29uc3QgX2RkMiA9IG5ldyBkb20oKS5wYXJzZUZyb21TdHJpbmcoX2Rlc2t0b3BYbWwpO1xuICAgICAgICAgICAgICBjb25zdCBfZG4yID0gc2VsZWN0KF9kZDIsIHhwYXRoKTtcbiAgICAgICAgICAgICAgaWYgKF9kbjIgJiYgX2RuMi5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgbm9kZXMgPSBfZG4yO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9IGNhdGNoIHsgLyogZGVza3RvcCBmYWxsYmFjayBpcyBiZXN0LWVmZm9ydCAqLyB9XG4gICAgfVxuICB9XG4gIGlmIChub2Rlcy5sZW5ndGggPiAxKSB7XG4gICAgbm9kZXMgPSBbLi4ubm9kZXNdLnNvcnQoKGEsIGIpID0+IG5vZGVQcmlvcml0eVNjb3JlKGIpIC0gbm9kZVByaW9yaXR5U2NvcmUoYSkpO1xuICB9XG4gIGNvbnN0IHNlcmlhbGl6ZXIgPSBuZXcgWE1MU2VyaWFsaXplcigpO1xuICBpZiAobXVsdCkge1xuICAgIGxldCBlbGVtZW50cyA9IFtdO1xuICAgIGZvciAoY29uc3Qgbm9kZSBvZiBub2Rlcykge1xuICAgICAgY29uc3Qgc3RyID0gc2VyaWFsaXplci5zZXJpYWxpemVUb1N0cmluZyhub2RlKTtcbiAgICAgIGNvbnN0IGtleSA9IHV1aWR2NCgpO1xuICAgICAgdGhpcy5fY2FjaGUuc2V0KGtleSwgc3RyKTtcbiAgICAgIGVsZW1lbnRzLnB1c2goe1xuICAgICAgICAnZWxlbWVudC02MDY2LTExZTQtYTUyZS00ZjczNTQ2NmNlY2YnOiBrZXksXG4gICAgICAgICdFTEVNRU5UJzoga2V5XG4gICAgICB9KTtcbiAgICB9XG4gICAgcmV0dXJuIGVsZW1lbnRzO1xuICB9IGVsc2Uge1xuICAgIGlmIChub2Rlcy5sZW5ndGggPT09IDApIHtcbiAgICAgIHRocm93IG5ldyBlcnJvcnMuTm9TdWNoRWxlbWVudEVycm9yKCk7XG4gICAgfVxuICAgIGNvbnN0IG5vZGUgPSBub2Rlc1swXTtcbiAgICBjb25zdCBzdHIgPSBzZXJpYWxpemVyLnNlcmlhbGl6ZVRvU3RyaW5nKG5vZGUpO1xuICAgIGNvbnN0IGtleSA9IHV1aWR2NCgpO1xuICAgIHRoaXMuX2NhY2hlLnNldChrZXksIHN0cik7XG4gICAgcmV0dXJuIHtcbiAgICAgICdlbGVtZW50LTYwNjYtMTFlNC1hNTJlLTRmNzM1NDY2Y2VjZic6IGtleSxcbiAgICAgICdFTEVNRU5UJzoga2V5XG4gICAgfTtcbiAgfVxufTtcblxuXG5leHBvcnQgeyBjb21tYW5kcyB9O1xuZXhwb3J0IGRlZmF1bHQgY29tbWFuZHM7XG4iXSwibWFwcGluZ3MiOiI7Ozs7Ozs7O0FBQUEsSUFBQUEsV0FBQSxHQUFBQyxPQUFBO0FBQ0EsSUFBQUMsTUFBQSxHQUFBQyxzQkFBQSxDQUFBRixPQUFBO0FBQ0EsSUFBQUcsT0FBQSxHQUFBSCxPQUFBO0FBQ0EsSUFBQUksS0FBQSxHQUFBSixPQUFBO0FBRUEsTUFBTUssUUFBUSxHQUFBQyxPQUFBLENBQUFELFFBQUEsR0FBRyxDQUFDLENBQUM7QUFDbkIsTUFBTUUsMkJBQTJCLEdBQUcsQ0FBQyxRQUFRLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxjQUFjLEVBQUUsU0FBUyxFQUFFLE9BQU8sRUFBRSxTQUFTLENB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
