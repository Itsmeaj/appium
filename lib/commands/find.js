import { errors } from '@appium/base-driver';
import select from 'xpath.js';
import { DOMParser as dom, XMLSerializer } from 'xmldom';
import { v4 as uuidv4 } from 'uuid';

const commands = {};
const HANDLE_SCOPED_WINDOW_TOKENS = ['dialog', 'alert', 'modal', 'notification', 'popover', 'popup', 'tooltip'];
function getApis (ctx) {
  if (!ctx?._backendApis) {
    throw new errors.UnknownError('Linux backend is not initialized');
  }
  return ctx._backendApis;
}

function selectorTargetsTransientWindow (strategy, selector) {
  if (`${strategy ?? ''}` !== 'xpath') {
    return false;
  }
  const normalized = `${selector ?? ''}`.toLowerCase();
  if (!normalized) {
    return false;
  }
  return HANDLE_SCOPED_WINDOW_TOKENS.some((token) => normalized.includes(`//${token}`) || normalized.includes(`::${token}`));
}

function shouldPreferHandleScopedHierarchy (ctx, strategy, selector) {
  if (ctx?.linuxBackend !== 'wayland') {
    return false;
  }
  const tag = `${ctx?._win?.tag ?? ''}`.toLowerCase();
  const windowType = `${ctx?._win?.windowType ?? ''}`.toLowerCase();
  if (HANDLE_SCOPED_WINDOW_TOKENS.some((token) => tag.includes(token) || windowType.includes(token))) {
    return true;
  }
  return selectorTargetsTransientWindow(strategy, selector);
}

function toXPathLiteral (value) {
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

function classTokenExpr (token) {
  return `contains(concat(" ", normalize-space(@class), " "), ${toXPathLiteral(` ${token} `)})`;
}

function createInvalidSelectorError (message) {
  if (errors.InvalidSelectorError) {
    return new errors.InvalidSelectorError(message);
  }
  return new errors.UnknownError(message);
}

function parseCssStep (step) {
  const result = {
    tag: '*',
    id: null,
    classes: [],
    attrs: [],
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
      const attrMatch = /^\[\s*([^\]=~^$*|\s]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(remaining);
      if (!attrMatch) {
        throw new Error(`Malformed attribute selector segment in '${step}'`);
      }
      const [, name, doubleQuotedValue, singleQuotedValue, bareValue] = attrMatch;
      const value = doubleQuotedValue ?? singleQuotedValue ?? bareValue;
      result.attrs.push({name, value});
      remaining = remaining.slice(attrMatch[0].length);
      continue;
    }
    throw new Error(`Unsupported css selector segment '${remaining}'`);
  }

  return result;
}

function splitCssSelector (selector) {
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

function cssSelectorToXpath (selector) {
  const steps = splitCssSelector(`${selector}`);
  const xpathSteps = steps.map((step) => {
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
    return predicates.length > 0
      ? `*[${predicates.join(' and ')}]`
      : '*';
  });
  return `//${xpathSteps.join('//')}`;
}

function buildXpathFromStrategy (strategy, selector) {
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

function parseRect (value) {
  const match = /^\[(?<x>-?\d+),(?<y>-?\d+),(?<width>\d+),(?<height>\d+)\]$/.exec(`${value ?? ''}`);
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

function nodePriorityScore (node) {
  if (!node?.attributes) {
    return Number.NEGATIVE_INFINITY;
  }
  const attrs = {};
  for (const attr of Array.from(node.attributes)) {
    attrs[attr.name] = attr.value;
  }
  const states = `${attrs.states ?? ''}`.toUpperCase();
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

function getWindowScopedHierarchy (ctx, apis, strategy, selector) {
  const {pid, name, wid} = ctx._win;
  let hierarchy = null;
  if (shouldPreferHandleScopedHierarchy(ctx, strategy, selector)) {
    // Fast path: try native per-window AT-SPI call first.  This returns fresh
    // element data (~200ms) without needing the full desktop hierarchy.  The
    // handle-scoped fallback uses cached desktop XML which may have stale
    // element states after UI actions (click/setValue/clear).
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
  // Wayland ultimate fallback: use the full desktop accessibility hierarchy when
  // both window-scoped and handle-scoped lookups return nothing.  This covers
  // RHEL/GNOME scenarios where AT-SPI window names don't match the expected
  // identifiers immediately after launch or dialog transitions.
  if ((!hierarchy || !`${hierarchy}`.trim()) && ctx.linuxBackend === 'wayland') {
    if (typeof apis.a11y_getDesktopUiHierachy === 'function') {
      hierarchy = apis.a11y_getDesktopUiHierachy();
    }
  }
  if (!hierarchy || !`${hierarchy}`.trim()) {
    throw new errors.NoSuchWindowError(
      `the selected window doesn't exist (wid=${wid}, pid=${pid}, name=${name})`
    );
  }
  return hierarchy;
}

commands._validateOrUpdateWinInfo = function () {
  // Short-lived cache: if we validated within the last 5 seconds, skip the
  // expensive app_getWindowHierachy() call.  The window doesn't move/close
  // between rapid find_element polls.
  const now = Date.now();
  if (this._winValidatedAt && (now - this._winValidatedAt) < 5000) {
    return true;
  }
  const apis = getApis(this);
  const {pid, wid, name} = this._win;
  const winHierachy = apis.app_getWindowHierachy();
  const doc = new dom().parseFromString(winHierachy);
  const nameLiteral = toXPathLiteral(name);
  let xpath = `//*[@pid="${pid}" and @wid="${wid}" and @InputOutput="true" and (@name=${nameLiteral} or ${classTokenExpr(name)})]`;
  const nodes = select(doc, xpath);
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

commands.findElOrEls = function findElOrEls (strategy, selector, mult, context) {
  const apis = getApis(this);
  let a11yHierachy = null;
  if (!context) {
    // Rate-limit native AT-SPI cache clears to once per 2s within the SAME
    // window.  Force a clear when the active window changed (setWindow was
    // called) so we get fresh AT-SPI data for the new window.
    const now = Date.now();
    const currentWid = this._win?.wid;
    const windowChanged = currentWid && currentWid !== this._lastFindWid;
    if (windowChanged || !this._lastCacheClearAt || (now - this._lastCacheClearAt) >= 2000) {
      apis.a11y_clear_cache();
      this._lastCacheClearAt = now;
    }
    this._lastFindWid = currentWid;
    if (!this._validateOrUpdateWinInfo()) {
      throw new errors.NoSuchWindowError(`the selected window doesn't exist`);
    }
    a11yHierachy = getWindowScopedHierarchy(this, apis, strategy, selector);
  } else {
    a11yHierachy = this._cache.get(context);
    if (!a11yHierachy) {
      throw new errors.UnknownError(`context ${context} has expired`);
    }
  }
  const doc = new dom().parseFromString(a11yHierachy);

  const xpath = buildXpathFromStrategy(strategy, selector);

  let nodes = [];
  try {
    nodes = select(doc, xpath);
  } catch (error) {
    throw createInvalidSelectorError(
      `Could not locate element by strategy '${strategy}' with selector '${selector}'. ` +
      `XPath was '${xpath}'. Original error: ${error.message}`
    );
  }
  if (!nodes || nodes.length === 0) {
    nodes = [];
    // Wayland fallback: when a window-scoped search returns no results, retry
    // against the full desktop AT-SPI tree.  GTK modal/transient dialogs
    // (e.g. "Add Server") may not register as separate compositor windows, so
    // getWindowHandles never discovers them and the window-scoped hierarchy
    // only covers the parent window.  The desktop tree always contains these
    // dialogs because AT-SPI reports them regardless of compositor state.
    //
    // Performance: the desktop AT-SPI scan is expensive (5-35s depending on
    // tree size).  We first try the cached hierarchy (~0ms) which works for
    // repeat searches.  A forced cache refresh only happens when:
    //   (a) the cached scan also missed, AND
    //   (b) a UI action (click/type) occurred since the last cache, AND
    //   (c) at least 3s elapsed since the last forced refresh.
    // This ensures at most one expensive scan per UI transition.
    if (!context && this.linuxBackend === 'wayland') {
      try {
        // 1. Try cached desktop hierarchy first (fast path)
        let _desktopXml = apis.a11y_getDesktopUiHierachy();
        if (_desktopXml && `${_desktopXml}`.trim()) {
          const _dd = new dom().parseFromString(_desktopXml);
          const _dn = select(_dd, xpath);
          if (_dn && _dn.length > 0) {
            nodes = _dn;
          }
        }
        // 2. Cached missed — force ONE fresh scan if a UI action happened
        //    since the last cache and we haven't forced recently.
        if (nodes.length === 0) {
          const _now = Date.now();
          const _cacheTs = apis._desktopHierarchyCacheAt || 0;
          const _uiTs = this._lastUiActionAt || 0;
          const _lastForce = this._lastDesktopForceScanAt || 0;
          if (_uiTs > _cacheTs && (_now - _lastForce) >= 3000) {
            this._lastDesktopForceScanAt = _now;
            if (typeof apis._invalidateDesktopHierarchyCache === 'function') {
              apis._invalidateDesktopHierarchyCache();
            }
            _desktopXml = apis.a11y_getDesktopUiHierachy();
            if (_desktopXml && `${_desktopXml}`.trim()) {
              const _dd2 = new dom().parseFromString(_desktopXml);
              const _dn2 = select(_dd2, xpath);
              if (_dn2 && _dn2.length > 0) {
                nodes = _dn2;
              }
            }
          }
        }
      } catch { /* desktop fallback is best-effort */ }
    }
  }
  if (nodes.length > 1) {
    nodes = [...nodes].sort((a, b) => nodePriorityScore(b) - nodePriorityScore(a));
  }
  const serializer = new XMLSerializer();
  if (mult) {
    let elements = [];
    for (const node of nodes) {
      const str = serializer.serializeToString(node);
      const key = uuidv4();
      this._cache.set(key, str);
      elements.push({
        'element-6066-11e4-a52e-4f735466cecf': key,
        'ELEMENT': key
      });
    }
    return elements;
  } else {
    if (nodes.length === 0) {
      throw new errors.NoSuchElementError();
    }
    const node = nodes[0];
    const str = serializer.serializeToString(node);
    const key = uuidv4();
    this._cache.set(key, str);
    return {
      'element-6066-11e4-a52e-4f735466cecf': key,
      'ELEMENT': key
    };
  }
};


export { commands };
export default commands;
