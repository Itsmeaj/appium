import { util } from '@appium/support';
import { errors } from '@appium/base-driver';
import { DOMParser as dom } from 'xmldom';
import { wait4sec } from '../utils';

const commands = {};
function getApis (ctx) {
  if (!ctx?._backendApis) {
    throw new errors.UnknownError('Linux backend is not initialized');
  }
  return ctx._backendApis;
}

commands._findElRect = function (uuid) {
  const strEl = this._cache.get(uuid);
  if (!strEl) {
    throw new errors.NoSuchElementError("the element doesn't exist");
  }
  const doc = new dom().parseFromString(strEl);
  if (!doc.documentElement.attributes) {
    throw new errors.InvalidElementCoordinatesError('the element has no rect attribute');
  }
  let attrs = Array.from(doc.documentElement.attributes);
  attrs = attrs.reduce((prev, curr) => {
    prev[curr.name] = curr.value;
    return prev;
  }, {});
  const rect = attrs.rect;
  if (!rect) {
    throw new errors.InvalidElementCoordinatesError('the element has no rect attribute');
  }
  const mat = /^\[(?<x>-?\d+),(?<y>-?\d+),(?<width>\d+),(?<height>\d+)\]$/.exec(rect);
  if (!mat) {
    throw new errors.InvalidElementCoordinatesError("the element's rect attribute is malformed");
  }
  const {x, y, width, height} = mat.groups;
  return {
    x: Number.parseInt(x, 10),
    y: Number.parseInt(y, 10),
    width: Number.parseInt(width, 10),
    height: Number.parseInt(height, 10)
  };
};

commands.setValue = commands.replaceValue = commands.setValueImmediate = async function setValue (values, elementId) {
  const apis = getApis(this);
  const uuid = elementId;
  const _v = Array.isArray(values) ? values.join('') : String(values || '');
  const {x, y, width, height} = this._findElRect(uuid);
  const _x = x + width / 2;
  const _y = y + height / 2;
  await wait4sec(0.08);
  await apis.mouse_click(_x, _y, 1);
  await wait4sec(0.12);
  await apis.keyboard_tapKey('a', 4); // control + A
  await wait4sec(0.03);
  await apis.keyboard_tapKeyCode(65535, 0); // delete
  await wait4sec(0.08);
  await apis.keyboard_typeStringCopyPaste(_v);
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
  return null;
};

commands.click = async function click (elementId) {
  const apis = getApis(this);
  const uuid = elementId;
  const {x, y, width, height} = this._findElRect(uuid);
  const _x = x + width / 2;
  const _y = y + height / 2;
  await wait4sec(0.05);
  await apis.mouse_click(_x, _y, 1);
  // Force native cache clear on next find — click changes UI state
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
  this._winValidatedAt = 0;
  return null;
};

commands.pressKeyCode = async function pressKeyCode (keycode, metastate) {
  const apis = getApis(this);
  metastate || (metastate = 0);
  if (keycode >= 0) {
    await apis.keyboard_tapKeyCode(keycode, metastate);
  } else {
    await apis.keyboard_tapKey(String.fromCharCode(-keycode), metastate);
  }
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
  return null;
};

commands.longPressKeyCode = async function longPressKeyCode (keycode, metastate) {
  const apis = getApis(this);
  metastate || (metastate = 0);
  const isKeyCode = keycode >= 0;
  if (isKeyCode) {
    await apis.keyboard_toggleKeyCode(keycode, true, metastate);
    await wait4sec(0.5);
    await apis.keyboard_toggleKeyCode(keycode, false, metastate);
  } else {
    await apis.keyboard_toggleKey(String.fromCharCode(-keycode), true, metastate);
    await wait4sec(0.5);
    await apis.keyboard_toggleKey(String.fromCharCode(-keycode), false, metastate);
  }
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
  return null;
};

commands.getProperty = commands.getAttribute = function getProperty (name, elementId) {
  const strEl = this._cache.get(elementId);
  if (!strEl) {
    throw new errors.NoSuchElementError("the element doesn't exist");
  }
  const doc = new dom().parseFromString(strEl);
  if (!doc.documentElement.attributes) {
    throw new errors.UnknownError('the element has no attributes');
  }
  let attrs = Array.from(doc.documentElement.attributes);
  attrs = attrs.reduce((prev, curr) => {
    prev[curr.name] = curr.value;
    return prev;
  }, {});
  return attrs[name];
};

commands.getElementRect = function getElementRect (elementId) {
  const rect = this.getProperty('rect', elementId);
  if (!rect) {
    throw new errors.InvalidElementCoordinatesError('the element has no rect attribute');
  }
  const mat = /^\[(?<x>-?\d+),(?<y>-?\d+),(?<width>\d+),(?<height>\d+)\]$/.exec(rect);
  if (!mat) {
    throw new errors.InvalidElementCoordinatesError("the element's rect attribute is malformed");
  }
  const {x, y, width, height} = mat.groups;
  return {
    x: Number.parseInt(x, 10),
    y: Number.parseInt(y, 10),
    width: Number.parseInt(width, 10),
    height: Number.parseInt(height, 10)
  };
};

commands.getSize = function getSize (elementId) {
  const rect = this.getElementRect(elementId);
  return {
    width: rect.width,
    height: rect.height
  };
};

commands.clear = async function clear (elementId) {
  const apis = getApis(this);
  await this.click(elementId);
  await wait4sec(0.1);
  await apis.keyboard_tapKey('a', 4); // control + A
  await wait4sec(0.03);
  await apis.keyboard_tapKeyCode(65535, 0); // delete
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
};

commands.getName = function getName (elementId) {
  const name = this.getProperty('name', elementId);
  return name;
};

commands.getText = function getText (elementId) {
  const text = this.getProperty('text', elementId);
  return text;
};

commands.linuxGetDisplaySize = function linuxGetDisplaySize () {
  const apis = getApis(this);
  return apis.c_getMainDisplaySize();
};

commands.linuxMouseMove = async function linuxMouseMove (opts = {}) {
  const apis = getApis(this);
  const {x, y} = opts;
  const _x = Number.parseInt(x, 10);
  const _y = Number.parseInt(y, 10);
  if (!util.hasValue(_x) || !util.hasValue(_y)) {
    throw new errors.UnknownError('parameter x, y are required');
  }
  await apis.mouse_move(_x, _y);
  return null;
};

commands.linuxMouseSwipe = async function linuxMouseSwipe (opts = {}) {
  const apis = getApis(this);
  const {sx, sy, ex, ey} = opts;
  const _sx = Number.parseInt(sx, 10);
  const _sy = Number.parseInt(sy, 10);
  const _ex = Number.parseInt(ex, 10);
  const _ey = Number.parseInt(ey, 10);
  if (!util.hasValue(_sx) || !util.hasValue(_sy) || !util.hasValue(_ex) || !util.hasValue(_ey)) {
    throw new errors.UnknownError('parameter sx, sy, ex, ey are required');
  }
  await apis.mouse_swipe(_sx, _sy, _ex, _ey);
  return null;
};

commands.linuxRightClick = async function linuxRightClick (opts = {}) {
  const apis = getApis(this);
  const {elementId} = opts;
  if (!util.hasValue(elementId)) {
    throw new errors.UnknownError('parameter elementId is required');
  }
  const rect = this.getElementRect(elementId);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await apis.mouse_click(x, y, 3);
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
  return null;
};

commands.linuxDoubleClick = async function linuxDoubleClick (opts = {}) {
  const apis = getApis(this);
  const {elementId} = opts;
  if (!util.hasValue(elementId)) {
    throw new errors.UnknownError('parameter elementId is required');
  }
  const rect = this.getElementRect(elementId);
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  await apis.mouse_doubleClick(x, y, 1);
  this._lastUiActionAt = Date.now();
  this._lastCacheClearAt = 0;
  this._winValidatedAt = 0;
  return null;
};

commands.linuxMouseScroll = async function linuxMouseScroll (opts = {}) {
  const apis = getApis(this);
  const {moveLeftSteps, moveUpSteps} = opts;
  let _moveLeftSteps = Number.parseInt(moveLeftSteps, 10);
  let _moveUpSteps = Number.parseInt(moveUpSteps, 10);
  _moveLeftSteps = !_moveLeftSteps ? 0 : _moveLeftSteps;
  _moveUpSteps = !_moveUpSteps ? 0 : _moveUpSteps;
  if (_moveLeftSteps !== 0 || _moveUpSteps !== 0) {
    await apis.mouse_scroll_x_y(_moveLeftSteps, _moveUpSteps);
  }
};

commands.linuxCopy = async function linuxCopy (opts = {}) {
  const apis = getApis(this);
  const {str} = opts;
  if (!util.hasValue(str)) {
    throw new errors.UnknownError('parameter str is required');
  }
  await apis.keyboard_copy(str);
};

commands.linuxGetClipboard = async function linuxGetClipboard () {
  const apis = getApis(this);
  return await apis.keyboard_getClipboardContent();
};

export default commands;
