"use strict";

var _interopRequireDefault = require("@babel/runtime/helpers/interopRequireDefault");
Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.attrsToObject = attrsToObject;
exports.buildWindowIdentity = buildWindowIdentity;
exports.extractWaylandWindowCandidates = extractWaylandWindowCandidates;
exports.isTransientWindowCandidate = isTransientWindowCandidate;
exports.isWindowLikeNode = isWindowLikeNode;
exports.materializeWaylandWindows = materializeWaylandWindows;
exports.parseRect = parseRect;
exports.resolveWaylandScopedWindowXml = resolveWaylandScopedWindowXml;
exports.scopedWindowResolutionScore = scopedWindowResolutionScore;
exports.windowCandidateScore = windowCandidateScore;
require("source-map-support/register");
var _crypto = _interopRequireDefault(require("crypto"));
var _xpath = _interopRequireDefault(require("xpath.js"));
var _xmldom = require("xmldom");
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
function attrsToObject(node) {
  if (!(node !== null && node !== void 0 && node.attributes)) {
    return {};
  }
  const attrs = {};
  for (const attr of Array.from(node.attributes)) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}
const WINDOW_LIKE_TOKENS = ['window', 'frame', 'dialog', 'alert', 'notification', 'popover'];
const TRANSIENT_WINDOW_TOKENS = ['alert', 'dialog', 'modal', 'notification', 'popover', 'popup', 'tooltip'];
function includesWindowToken(value, tokens) {
  const normalized = `${value !== null && value !== void 0 ? value : ''}`.toLowerCase();
  if (!normalized) {
    return false;
  }
  return tokens.some(token => normalized.includes(token));
}
function isWindowLikeNode(node, attrs) {
  var _ref, _node$nodeName, _attrs$role, _attrs$xmlRoles, _attrs$windowType;
  const tag = `${(_ref = (_node$nodeName = node === null || node === void 0 ? void 0 : node.nodeName) !== null && _node$nodeName !== void 0 ? _node$nodeName : node === null || node === void 0 ? void 0 : node.tagName) !== null && _ref !== void 0 ? _ref : ''}`.toLowerCase();
  const roleName = `${(_attrs$role = attrs === null || attrs === void 0 ? void 0 : attrs.role) !== null && _attrs$role !== void 0 ? _attrs$role : ''}`.toLowerCase();
  const xmlRoles = `${(_attrs$xmlRoles = attrs === null || attrs === void 0 ? void 0 : attrs['xml-roles']) !== null && _attrs$xmlRoles !== void 0 ? _attrs$xmlRoles : ''}`.toLowerCase();
  const windowType = `${(_attrs$windowType = attrs === null || attrs === void 0 ? void 0 : attrs['window-type']) !== null && _attrs$windowType !== void 0 ? _attrs$windowType : ''}`.toLowerCase();
  return [tag, roleName, xmlRoles, windowType].some(value => includesWindowToken(value, WINDOW_LIKE_TOKENS));
}
function transientWindowBonus(candidate) {
  var _candidate$nodeTag, _candidate$windowType;
  const nodeTag = `${(_candidate$nodeTag = candidate === null || candidate === void 0 ? void 0 : candidate.nodeTag) !== null && _candidate$nodeTag !== void 0 ? _candidate$nodeTag : ''}`.toLowerCase();
  const windowType = `${(_candidate$windowType = candidate === null || candidate === void 0 ? void 0 : candidate.windowType) !== null && _candidate$windowType !== void 0 ? _candidate$windowType : ''}`.toLowerCase();
  if ([nodeTag, windowType].some(value => includesWindowToken(value, ['alert']))) {
    return 100000000;
  }
  if ([nodeTag, windowType].some(value => includesWindowToken(value, ['dialog', 'modal']))) {
    return 80000000;
  }
  if ([nodeTag, windowType].some(value => includesWindowToken(value, TRANSIENT_WINDOW_TOKENS))) {
    return 60000000;
  }
  return 0;
}
function isTransientWindowCandidate(candidate) {
  var _candidate$nodeTag2, _candidate$windowType2, _candidate$states;
  const nodeTag = `${(_candidate$nodeTag2 = candidate === null || candidate === void 0 ? void 0 : candidate.nodeTag) !== null && _candidate$nodeTag2 !== void 0 ? _candidate$nodeTag2 : ''}`.toLowerCase();
  const windowType = `${(_candidate$windowType2 = candidate === null || candidate === void 0 ? void 0 : candidate.windowType) !== null && _candidate$windowType2 !== void 0 ? _candidate$windowType2 : ''}`.toLowerCase();
  const states = `${(_candidate$states = candidate === null || candidate === void 0 ? void 0 : candidate.states) !== null && _candidate$states !== void 0 ? _candidate$states : ''}`.toUpperCase();
  return [nodeTag, windowType].some(value => includesWindowToken(value, TRANSIENT_WINDOW_TOKENS)) || states.includes('MODAL');
}
function normalizeText(value) {
  return `${value !== null && value !== void 0 ? value : ''}`.trim().toLowerCase();
}
function primaryClassName(className) {
  return `${className !== null && className !== void 0 ? className : ''}`.split(/\s+/).filter(Boolean)[0] || '';
}
function rectArea(rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return 0;
  }
  return rect.width * rect.height;
}
function rectOverlapArea(left, right) {
  if (!left || !right) {
    return 0;
  }
  const x1 = Math.max(left.x, right.x);
  const y1 = Math.max(left.y, right.y);
  const x2 = Math.min(left.x + left.width, right.x + right.width);
  const y2 = Math.min(left.y + left.height, right.y + right.height);
  const width = x2 - x1;
  const height = y2 - y1;
  if (width <= 0 || height <= 0) {
    return 0;
  }
  return width * height;
}
function rectCenterDistance(left, right) {
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }
  const leftCx = left.x + left.width / 2;
  const leftCy = left.y + left.height / 2;
  const rightCx = right.x + right.width / 2;
  const rightCy = right.y + right.height / 2;
  return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}
function buildWindowIdentity(candidate) {
  var _candidate$pid, _candidate$nodeTag3, _candidate$windowType3, _candidate$name;
  return [Number.parseInt(`${(_candidate$pid = candidate === null || candidate === void 0 ? void 0 : candidate.pid) !== null && _candidate$pid !== void 0 ? _candidate$pid : ''}`, 10) || 0, `${(_candidate$nodeTag3 = candidate === null || candidate === void 0 ? void 0 : candidate.nodeTag) !== null && _candidate$nodeTag3 !== void 0 ? _candidate$nodeTag3 : ''}`.toLowerCase(), `${(_candidate$windowType3 = candidate === null || candidate === void 0 ? void 0 : candidate.windowType) !== null && _candidate$windowType3 !== void 0 ? _candidate$windowType3 : ''}`.toLowerCase(), `${(_candidate$name = candidate === null || candidate === void 0 ? void 0 : candidate.name) !== null && _candidate$name !== void 0 ? _candidate$name : ''}`.trim(), primaryClassName(candidate === null || candidate === void 0 ? void 0 : candidate.className)].join('|');
}
function windowCandidateScore(candidate) {
  var _candidate$states2;
  const states = `${(_candidate$states2 = candidate === null || candidate === void 0 ? void 0 : candidate.states) !== null && _candidate$states2 !== void 0 ? _candidate$states2 : ''}`.toUpperCase();
  let score = rectArea(candidate === null || candidate === void 0 ? void 0 : candidate.rect);
  if (candidate !== null && candidate !== void 0 && candidate.windowLike) {
    score += 120000000;
  }
  score += transientWindowBonus(candidate);
  if (states.includes('ACTIVE')) {
    score += 50000000;
  }
  if (states.includes('SHOWING') || states.includes('VISIBLE')) {
    score += 20000000;
  }
  if (states.includes('ENABLED') || states.includes('SENSITIVE')) {
    score += 5000000;
  }
  return score;
}
function parsePid(value) {
  const pid = Number.parseInt(`${value !== null && value !== void 0 ? value : ''}`, 10);
  return Number.isFinite(pid) ? pid : null;
}
function resolveNodePid(node, attrs, pidSet) {
  const ownPid = parsePid(attrs === null || attrs === void 0 ? void 0 : attrs.pid);
  if (ownPid !== null && pidSet.has(ownPid)) {
    return ownPid;
  }
  const stack = [];
  try {
    stack.push(...Array.from((node === null || node === void 0 ? void 0 : node.childNodes) || []));
  } catch {
    return null;
  }
  while (stack.length > 0) {
    const candidate = stack.pop();
    if (!candidate || candidate.nodeType !== 1) {
      continue;
    }
    const candidateAttrs = attrsToObject(candidate);
    const candidatePid = parsePid(candidateAttrs.pid);
    if (candidatePid !== null && pidSet.has(candidatePid)) {
      return candidatePid;
    }
    try {
      stack.push(...Array.from(candidate.childNodes || []));
    } catch {
      continue;
    }
  }
  return null;
}
function extractWaylandWindowCandidates(desktopXml, pids) {
  if (!`${desktopXml !== null && desktopXml !== void 0 ? desktopXml : ''}`.trim()) {
    return [];
  }
  const normalizedPids = (pids || []).map(pid => Number.parseInt(`${pid}`, 10)).filter(pid => Number.isFinite(pid));
  if (normalizedPids.length === 0) {
    return [];
  }
  const pidSet = new Set(normalizedPids);
  const serializer = new _xmldom.XMLSerializer();
  const doc = new _xmldom.DOMParser().parseFromString(desktopXml);
  let nodes = [];
  try {
    nodes = (0, _xpath.default)(doc, '//*');
  } catch {
    nodes = [];
  }
  const allCandidates = [];
  const explicitWindows = [];
  for (const node of nodes) {
    var _attrs$name, _attrs$class, _ref2, _node$nodeName2, _attrs$windowType2, _attrs$states;
    const attrs = attrsToObject(node);
    const windowLike = isWindowLikeNode(node, attrs);
    const ownPid = parsePid(attrs.pid);
    const pid = ownPid !== null && pidSet.has(ownPid) ? ownPid : windowLike ? resolveNodePid(node, attrs, pidSet) : null;
    if (!Number.isFinite(pid)) {
      continue;
    }
    if (ownPid === null && !windowLike) {
      continue;
    }
    const rect = parseRect(attrs.rect);
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const rawName = `${(_attrs$name = attrs.name) !== null && _attrs$name !== void 0 ? _attrs$name : ''}`.trim();
    const className = `${(_attrs$class = attrs.class) !== null && _attrs$class !== void 0 ? _attrs$class : ''}`.trim();
    const candidate = {
      pid,
      name: rawName || primaryClassName(className) || `window-${pid}`,
      className,
      nodeTag: `${(_ref2 = (_node$nodeName2 = node === null || node === void 0 ? void 0 : node.nodeName) !== null && _node$nodeName2 !== void 0 ? _node$nodeName2 : node === null || node === void 0 ? void 0 : node.tagName) !== null && _ref2 !== void 0 ? _ref2 : ''}`.toLowerCase(),
      windowType: `${(_attrs$windowType2 = attrs['window-type']) !== null && _attrs$windowType2 !== void 0 ? _attrs$windowType2 : ''}`.trim(),
      rect,
      states: `${(_attrs$states = attrs.states) !== null && _attrs$states !== void 0 ? _attrs$states : ''}`.toUpperCase(),
      windowLike,
      xml: serializer.serializeToString(node)
    };
    allCandidates.push(candidate);
    if (candidate.windowLike) {
      explicitWindows.push(candidate);
    }
  }
  const chosenCandidates = explicitWindows.length > 0 ? explicitWindows : allCandidates;
  return chosenCandidates.map(candidate => ({
    ...candidate,
    identityKey: buildWindowIdentity(candidate),
    score: windowCandidateScore(candidate)
  }));
}
function nextWindowHandle(identityKey, usedWids) {
  const digest = _crypto.default.createHash('sha1').update(identityKey).digest('hex').slice(0, 8);
  let wid = Number.parseInt(digest, 16) % 2000000000 + 1000;
  while (usedWids.has(wid)) {
    wid += 1;
  }
  usedWids.add(wid);
  return wid;
}
function materializeWaylandWindows(candidates, previousWidByIdentity = new Map()) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const existing = grouped.get(candidate.identityKey);
    if (!existing || existing.score < candidate.score) {
      var _existing$duplicateCo;
      grouped.set(candidate.identityKey, {
        ...candidate,
        duplicateCount: (_existing$duplicateCo = existing === null || existing === void 0 ? void 0 : existing.duplicateCount) !== null && _existing$duplicateCo !== void 0 ? _existing$duplicateCo : 1
      });
      continue;
    }
    if (existing.score === candidate.score) {
      existing.duplicateCount += 1;
    }
  }
  const usedWids = new Set();
  const identityToWid = new Map();
  const windows = Array.from(grouped.values()).sort((left, right) => right.score - left.score || left.identityKey.localeCompare(right.identityKey)).map(window => {
    const previousWid = previousWidByIdentity.get(window.identityKey);
    const wid = previousWid && !usedWids.has(previousWid) ? (usedWids.add(previousWid), previousWid) : nextWindowHandle(window.identityKey, usedWids);
    identityToWid.set(window.identityKey, wid);
    return {
      ...window,
      inputOutput: 'true',
      wid
    };
  }).sort((left, right) => left.wid - right.wid);
  return {
    windows,
    identityToWid
  };
}
function scopedWindowResolutionScore(candidate, targetWindow) {
  var _candidate$pid2, _targetWindow$pid, _candidate$states3, _candidate$states4, _candidate$states5, _candidate$states6, _candidate$states7;
  if (!candidate || !targetWindow) {
    return Number.NEGATIVE_INFINITY;
  }
  if (Number.parseInt(`${(_candidate$pid2 = candidate.pid) !== null && _candidate$pid2 !== void 0 ? _candidate$pid2 : ''}`, 10) !== Number.parseInt(`${(_targetWindow$pid = targetWindow.pid) !== null && _targetWindow$pid !== void 0 ? _targetWindow$pid : ''}`, 10)) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = 0;
  if (candidate.identityKey && candidate.identityKey === targetWindow.identityKey) {
    score += 1000;
  }
  const candidateName = normalizeText(candidate.name);
  const targetName = normalizeText(targetWindow.name);
  if (candidateName && targetName && candidateName === targetName) {
    score += 250;
  }
  const candidateClass = primaryClassName(candidate.className);
  const targetClass = primaryClassName(targetWindow.className);
  if (candidateClass && targetClass && candidateClass === targetClass) {
    score += 90;
  }
  if (normalizeText(candidate.nodeTag) && normalizeText(candidate.nodeTag) === normalizeText(targetWindow.nodeTag)) {
    score += 70;
  }
  if (normalizeText(candidate.windowType) && normalizeText(candidate.windowType) === normalizeText(targetWindow.windowType)) {
    score += 60;
  }
  const candidateRect = candidate.rect;
  const targetRect = targetWindow.rect;
  if (candidateRect && targetRect) {
    if (candidateRect.width === targetRect.width && candidateRect.height === targetRect.height) {
      score += 80;
    }
    if (candidateRect.x === targetRect.x && candidateRect.y === targetRect.y) {
      score += 40;
    }
    const overlapArea = rectOverlapArea(candidateRect, targetRect);
    if (overlapArea > 0) {
      score += Math.round(overlapArea / Math.max(rectArea(targetRect), 1) * 100);
    }
    const centerDistance = rectCenterDistance(candidateRect, targetRect);
    if (Number.isFinite(centerDistance)) {
      score += Math.max(0, 30 - Math.min(centerDistance, 300) / 10);
    }
  }
  if (candidate.windowLike) {
    score += 40;
  }
  if (`${(_candidate$states3 = candidate.states) !== null && _candidate$states3 !== void 0 ? _candidate$states3 : ''}`.includes('ACTIVE')) {
    score += 30;
  }
  if (`${(_candidate$states4 = candidate.states) !== null && _candidate$states4 !== void 0 ? _candidate$states4 : ''}`.includes('SHOWING') || `${(_candidate$states5 = candidate.states) !== null && _candidate$states5 !== void 0 ? _candidate$states5 : ''}`.includes('VISIBLE')) {
    score += 25;
  }
  if (`${(_candidate$states6 = candidate.states) !== null && _candidate$states6 !== void 0 ? _candidate$states6 : ''}`.includes('ENABLED') || `${(_candidate$states7 = candidate.states) !== null && _candidate$states7 !== void 0 ? _candidate$states7 : ''}`.includes('SENSITIVE')) {
    score += 10;
  }
  return score;
}
function transientOverlayResolutionScore(candidate, targetWindow) {
  var _candidate$pid3, _targetWindow$pid2, _candidate$states8;
  if (!candidate || !targetWindow || !isTransientWindowCandidate(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (Number.parseInt(`${(_candidate$pid3 = candidate.pid) !== null && _candidate$pid3 !== void 0 ? _candidate$pid3 : ''}`, 10) !== Number.parseInt(`${(_targetWindow$pid2 = targetWindow.pid) !== null && _targetWindow$pid2 !== void 0 ? _targetWindow$pid2 : ''}`, 10)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (candidate.identityKey && targetWindow.identityKey && candidate.identityKey === targetWindow.identityKey) {
    return Number.NEGATIVE_INFINITY;
  }
  const candidateRect = candidate.rect;
  const targetRect = targetWindow.rect;
  const overlapArea = rectOverlapArea(candidateRect, targetRect);
  const candidateArea = rectArea(candidateRect);
  const targetArea = rectArea(targetRect);
  if (!candidateArea || !targetArea || overlapArea <= 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const overlapRatio = overlapArea / Math.max(candidateArea, 1);
  const coverageRatio = overlapArea / Math.max(targetArea, 1);
  if (overlapRatio < 0.5 && coverageRatio < 0.1) {
    return Number.NEGATIVE_INFINITY;
  }
  let score = transientWindowBonus(candidate);
  const states = `${(_candidate$states8 = candidate.states) !== null && _candidate$states8 !== void 0 ? _candidate$states8 : ''}`.toUpperCase();
  if (states.includes('MODAL')) {
    score += 150;
  }
  if (states.includes('ACTIVE')) {
    score += 120;
  }
  if (states.includes('SHOWING') || states.includes('VISIBLE')) {
    score += 80;
  }
  if (candidateArea <= targetArea) {
    score += 40;
  }
  score += Math.round(overlapRatio * 100);
  score += Math.round(coverageRatio * 100);
  const centerDistance = rectCenterDistance(candidateRect, targetRect);
  if (Number.isFinite(centerDistance)) {
    score += Math.max(0, 40 - Math.min(centerDistance, 400) / 10);
  }
  return score;
}
function resolveWaylandTransientOverlayCandidate(candidates, targetWindow) {
  if (!targetWindow || isTransientWindowCandidate(targetWindow)) {
    return null;
  }
  const scored = candidates.map(candidate => ({
    candidate,
    score: transientOverlayResolutionScore(candidate, targetWindow)
  })).filter(item => Number.isFinite(item.score) && item.score > 0).sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    return null;
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return null;
  }
  return scored[0].candidate;
}
function resolveWaylandScopedWindowXml(desktopXml, pids, targetWindow, options = {}) {
  const {
    allowTransientOverlay = false
  } = options;
  const candidates = extractWaylandWindowCandidates(desktopXml, pids);
  if (allowTransientOverlay) {
    const transientOverlay = resolveWaylandTransientOverlayCandidate(candidates, targetWindow);
    if (transientOverlay !== null && transientOverlay !== void 0 && transientOverlay.xml) {
      return {
        xml: transientOverlay.xml,
        reason: 'ok',
        candidate: transientOverlay,
        redirectedToTransientOverlay: true
      };
    }
  }
  const scored = candidates.map(candidate => ({
    candidate,
    score: scopedWindowResolutionScore(candidate, targetWindow)
  })).filter(item => Number.isFinite(item.score) && item.score > 0).sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    return {
      xml: '',
      reason: 'not_found'
    };
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return {
      xml: '',
      reason: 'ambiguous'
    };
  }
  return {
    xml: scored[0].candidate.xml,
    reason: 'ok',
    candidate: scored[0].candidate
  };
}require('source-map-support').install();


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2JhY2tlbmRzL3dheWxhbmQtd2luZG93LXV0aWxzLmpzIiwibmFtZXMiOlsiX2NyeXB0byIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3hwYXRoIiwiX3htbGRvbSIsInBhcnNlUmVjdCIsInJlY3QiLCJtYXRjaCIsImV4ZWMiLCJ4IiwieSIsIndpZHRoIiwiaGVpZ2h0IiwiZ3JvdXBzIiwiTnVtYmVyIiwicGFyc2VJbnQiLCJhdHRyc1RvT2JqZWN0Iiwibm9kZSIsImF0dHJpYnV0ZXMiLCJhdHRycyIsImF0dHIiLCJBcnJheSIsImZyb20iLCJuYW1lIiwidmFsdWUiLCJXSU5ET1dfTElLRV9UT0tFTlMiLCJUUkFOU0lFTlRfV0lORE9XX1RPS0VOUyIsImluY2x1ZGVzV2luZG93VG9rZW4iLCJ0b2tlbnMiLCJub3JtYWxpemVkIiwidG9Mb3dlckNhc2UiLCJzb21lIiwidG9rZW4iLCJpbmNsdWRlcyIsImlzV2luZG93TGlrZU5vZGUiLCJfcmVmIiwiX25vZGUkbm9kZU5hbWUiLCJfYXR0cnMkcm9sZSIsIl9hdHRycyR4bWxSb2xlcyIsIl9hdHRycyR3aW5kb3dUeXBlIiwidGFnIiwibm9kZU5hbWUiLCJ0YWdOYW1lIiwicm9sZU5hbWUiLCJyb2xlIiwieG1sUm9sZXMiLCJ3aW5kb3dUeXBlIiwidHJhbnNpZW50V2luZG93Qm9udXMiLCJjYW5kaWRhdGUiLCJfY2FuZGlkYXRlJG5vZGVUYWciLCJfY2FuZGlkYXRlJHdpbmRvd1R5cGUiLCJub2RlVGFnIiwiaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUiLCJfY2FuZGlkYXRlJG5vZGVUYWcyIiwiX2NhbmRpZGF0ZSR3aW5kb3dUeXBlMiIsIl9jYW5kaWRhdGUkc3RhdGVzIiwic3RhdGVzIiwidG9VcHBlckNhc2UiLCJub3JtYWxpemVUZXh0IiwidHJpbSIsInByaW1hcnlDbGFzc05hbWUiLCJjbGFzc05hbWUiLCJzcGxpdCIsImZpbHRlciIsIkJvb2xlYW4iLCJyZWN0QXJlYSIsInJlY3RPdmVybGFwQXJlYSIsImxlZnQiLCJyaWdodCIsIngxIiwiTWF0aCIsIm1heCIsInkxIiwieDIiLCJtaW4iLCJ5MiIsInJlY3RDZW50ZXJEaXN0YW5jZSIsIlBPU0lUSVZFX0lORklOSVRZIiwibGVmdEN4IiwibGVmdEN5IiwicmlnaHRDeCIsInJpZ2h0Q3kiLCJoeXBvdCIsImJ1aWxkV2luZG93SWRlbnRpdHkiLCJfY2FuZGlkYXRlJHBpZCIsIl9jYW5kaWRhdGUkbm9kZVRhZzMiLCJfY2FuZGlkYXRlJHdpbmRvd1R5cGUzIiwiX2NhbmRpZGF0ZSRuYW1lIiwicGlkIiwiam9pbiIsIndpbmRvd0NhbmRpZGF0ZVNjb3JlIiwiX2NhbmRpZGF0ZSRzdGF0ZXMyIiwic2NvcmUiLCJ3aW5kb3dMaWtlIiwicGFyc2VQaWQiLCJpc0Zpbml0ZSIsInJlc29sdmVOb2RlUGlkIiwicGlkU2V0Iiwib3duUGlkIiwiaGFzIiwic3RhY2siLCJwdXNoIiwiY2hpbGROb2RlcyIsImxlbmd0aCIsInBvcCIsIm5vZGVUeXBlIiwiY2FuZGlkYXRlQXR0cnMiLCJjYW5kaWRhdGVQaWQiLCJleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMiLCJkZXNrdG9wWG1sIiwicGlkcyIsIm5vcm1hbGl6ZWRQaWRzIiwibWFwIiwiU2V0Iiwic2VyaWFsaXplciIsIlhNTFNlcmlhbGl6ZXIiLCJkb2MiLCJkb20iLCJwYXJzZUZyb21TdHJpbmciLCJub2RlcyIsInNlbGVjdCIsImFsbENhbmRpZGF0ZXMiLCJleHBsaWNpdFdpbmRvd3MiLCJfYXR0cnMkbmFtZSIsIl9hdHRycyRjbGFzcyIsIl9yZWYyIiwiX25vZGUkbm9kZU5hbWUyIiwiX2F0dHJzJHdpbmRvd1R5cGUyIiwiX2F0dHJzJHN0YXRlcyIsInJhd05hbWUiLCJjbGFzcyIsInhtbCIsInNlcmlhbGl6ZVRvU3RyaW5nIiwiY2hvc2VuQ2FuZGlkYXRlcyIsImlkZW50aXR5S2V5IiwibmV4dFdpbmRvd0hhbmRsZSIsInVzZWRXaWRzIiwiZGlnZXN0IiwiY3J5cHRvIiwiY3JlYXRlSGFzaCIsInVwZGF0ZSIsInNsaWNlIiwid2lkIiwiYWRkIiwibWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyIsImNhbmRpZGF0ZXMiLCJwcmV2aW91c1dpZEJ5SWRlbnRpdHkiLCJNYXAiLCJncm91cGVkIiwiZXhpc3RpbmciLCJnZXQiLCJfZXhpc3RpbmckZHVwbGljYXRlQ28iLCJzZXQiLCJkdXBsaWNhdGVDb3VudCIsImlkZW50aXR5VG9XaWQiLCJ3aW5kb3dzIiwidmFsdWVzIiwic29ydCIsImxvY2FsZUNvbXBhcmUiLCJ3aW5kb3ciLCJwcmV2aW91c1dpZCIsImlucHV0T3V0cHV0Iiwic2NvcGVkV2luZG93UmVzb2x1dGlvblNjb3JlIiwidGFyZ2V0V2luZG93IiwiX2NhbmRpZGF0ZSRwaWQyIiwiX3RhcmdldFdpbmRvdyRwaWQiLCJfY2FuZGlkYXRlJHN0YXRlczMiLCJfY2FuZGlkYXRlJHN0YXRlczQiLCJfY2FuZGlkYXRlJHN0YXRlczUiLCJfY2FuZGlkYXRlJHN0YXRlczYiLCJfY2FuZGlkYXRlJHN0YXRlczciLCJORUdBVElWRV9JTkZJTklUWSIsImNhbmRpZGF0ZU5hbWUiLCJ0YXJnZXROYW1lIiwiY2FuZGlkYXRlQ2xhc3MiLCJ0YXJnZXRDbGFzcyIsImNhbmRpZGF0ZVJlY3QiLCJ0YXJnZXRSZWN0Iiwib3ZlcmxhcEFyZWEiLCJyb3VuZCIsImNlbnRlckRpc3RhbmNlIiwidHJhbnNpZW50T3ZlcmxheVJlc29sdXRpb25TY29yZSIsIl9jYW5kaWRhdGUkcGlkMyIsIl90YXJnZXRXaW5kb3ckcGlkMiIsIl9jYW5kaWRhdGUkc3RhdGVzOCIsImNhbmRpZGF0ZUFyZWEiLCJ0YXJnZXRBcmVhIiwib3ZlcmxhcFJhdGlvIiwiY292ZXJhZ2VSYXRpbyIsInJlc29sdmVXYXlsYW5kVHJhbnNpZW50T3ZlcmxheUNhbmRpZGF0ZSIsInNjb3JlZCIsIml0ZW0iLCJyZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbCIsIm9wdGlvbnMiLCJhbGxvd1RyYW5zaWVudE92ZXJsYXkiLCJ0cmFuc2llbnRPdmVybGF5IiwicmVhc29uIiwicmVkaXJlY3RlZFRvVHJhbnNpZW50T3ZlcmxheSJdLCJzb3VyY2VSb290IjoiLi4vLi4vLi4iLCJzb3VyY2VzIjpbImxpYi9iYWNrZW5kcy93YXlsYW5kLXdpbmRvdy11dGlscy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgY3J5cHRvIGZyb20gJ2NyeXB0byc7XG5pbXBvcnQgc2VsZWN0IGZyb20gJ3hwYXRoLmpzJztcbmltcG9ydCB7IERPTVBhcnNlciBhcyBkb20sIFhNTFNlcmlhbGl6ZXIgfSBmcm9tICd4bWxkb20nO1xuXG5mdW5jdGlvbiBwYXJzZVJlY3QgKHJlY3QpIHtcbiAgY29uc3QgbWF0Y2ggPSAvXlxcWyg/PHg+LT9cXGQrKSwoPzx5Pi0/XFxkKyksKD88d2lkdGg+XFxkKyksKD88aGVpZ2h0PlxcZCspXFxdJC8uZXhlYyhgJHtyZWN0ID8/ICcnfWApO1xuICBpZiAoIW1hdGNoKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3Qge3gsIHksIHdpZHRoLCBoZWlnaHR9ID0gbWF0Y2guZ3JvdXBzO1xuICByZXR1cm4ge1xuICAgIHg6IE51bWJlci5wYXJzZUludCh4LCAxMCksXG4gICAgeTogTnVtYmVyLnBhcnNlSW50KHksIDEwKSxcbiAgICB3aWR0aDogTnVtYmVyLnBhcnNlSW50KHdpZHRoLCAxMCksXG4gICAgaGVpZ2h0OiBOdW1iZXIucGFyc2VJbnQoaGVpZ2h0LCAxMCksXG4gIH07XG59XG5cbmZ1bmN0aW9uIGF0dHJzVG9PYmplY3QgKG5vZGUpIHtcbiAgaWYgKCFub2RlPy5hdHRyaWJ1dGVzKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG4gIGNvbnN0IGF0dHJzID0ge307XG4gIGZvciAoY29uc3QgYXR0ciBvZiBBcnJheS5mcm9tKG5vZGUuYXR0cmlidXRlcykpIHtcbiAgICBhdHRyc1thdHRyLm5hbWVdID0gYXR0ci52YWx1ZTtcbiAgfVxuICByZXR1cm4gYXR0cnM7XG59XG5cbmNvbnN0IFdJTkRPV19MSUtFX1RPS0VOUyA9IFsnd2luZG93JywgJ2ZyYW1lJywgJ2RpYWxvZycsICdhbGVydCcsICdub3RpZmljYXRpb24nLCAncG9wb3ZlciddO1xuY29uc3QgVFJBTlNJRU5UX1dJTkRPV19UT0tFTlMgPSBbJ2FsZXJ0JywgJ2RpYWxvZycsICdtb2RhbCcsICdub3RpZmljYXRpb24nLCAncG9wb3ZlcicsICdwb3B1cCcsICd0b29sdGlwJ107XG5cbmZ1bmN0aW9uIGluY2x1ZGVzV2luZG93VG9rZW4gKHZhbHVlLCB0b2tlbnMpIHtcbiAgY29uc3Qgbm9ybWFsaXplZCA9IGAke3ZhbHVlID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgaWYgKCFub3JtYWxpemVkKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0b2tlbnMuc29tZSgodG9rZW4pID0+IG5vcm1hbGl6ZWQuaW5jbHVkZXModG9rZW4pKTtcbn1cblxuZnVuY3Rpb24gaXNXaW5kb3dMaWtlTm9kZSAobm9kZSwgYXR0cnMpIHtcbiAgY29uc3QgdGFnID0gYCR7bm9kZT8ubm9kZU5hbWUgPz8gbm9kZT8udGFnTmFtZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHJvbGVOYW1lID0gYCR7YXR0cnM/LnJvbGUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCB4bWxSb2xlcyA9IGAke2F0dHJzPy5bJ3htbC1yb2xlcyddID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3Qgd2luZG93VHlwZSA9IGAke2F0dHJzPy5bJ3dpbmRvdy10eXBlJ10gPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICByZXR1cm4gW3RhZywgcm9sZU5hbWUsIHhtbFJvbGVzLCB3aW5kb3dUeXBlXS5zb21lKCh2YWx1ZSkgPT4gaW5jbHVkZXNXaW5kb3dUb2tlbih2YWx1ZSwgV0lORE9XX0xJS0VfVE9LRU5TKSk7XG59XG5cbmZ1bmN0aW9uIHRyYW5zaWVudFdpbmRvd0JvbnVzIChjYW5kaWRhdGUpIHtcbiAgY29uc3Qgbm9kZVRhZyA9IGAke2NhbmRpZGF0ZT8ubm9kZVRhZyA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHdpbmRvd1R5cGUgPSBgJHtjYW5kaWRhdGU/LndpbmRvd1R5cGUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBpZiAoW25vZGVUYWcsIHdpbmRvd1R5cGVdLnNvbWUoKHZhbHVlKSA9PiBpbmNsdWRlc1dpbmRvd1Rva2VuKHZhbHVlLCBbJ2FsZXJ0J10pKSkge1xuICAgIHJldHVybiAxMDAwMDAwMDA7XG4gIH1cbiAgaWYgKFtub2RlVGFnLCB3aW5kb3dUeXBlXS5zb21lKCh2YWx1ZSkgPT4gaW5jbHVkZXNXaW5kb3dUb2tlbih2YWx1ZSwgWydkaWFsb2cnLCAnbW9kYWwnXSkpKSB7XG4gICAgcmV0dXJuIDgwMDAwMDAwO1xuICB9XG4gIGlmIChbbm9kZVRhZywgd2luZG93VHlwZV0uc29tZSgodmFsdWUpID0+IGluY2x1ZGVzV2luZG93VG9rZW4odmFsdWUsIFRSQU5TSUVOVF9XSU5ET1dfVE9LRU5TKSkpIHtcbiAgICByZXR1cm4gNjAwMDAwMDA7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbmZ1bmN0aW9uIGlzVHJhbnNpZW50V2luZG93Q2FuZGlkYXRlIChjYW5kaWRhdGUpIHtcbiAgY29uc3Qgbm9kZVRhZyA9IGAke2NhbmRpZGF0ZT8ubm9kZVRhZyA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHdpbmRvd1R5cGUgPSBgJHtjYW5kaWRhdGU/LndpbmRvd1R5cGUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCBzdGF0ZXMgPSBgJHtjYW5kaWRhdGU/LnN0YXRlcyA/PyAnJ31gLnRvVXBwZXJDYXNlKCk7XG4gIHJldHVybiAoXG4gICAgW25vZGVUYWcsIHdpbmRvd1R5cGVdLnNvbWUoKHZhbHVlKSA9PiBpbmNsdWRlc1dpbmRvd1Rva2VuKHZhbHVlLCBUUkFOU0lFTlRfV0lORE9XX1RPS0VOUykpXG4gICAgfHwgc3RhdGVzLmluY2x1ZGVzKCdNT0RBTCcpXG4gICk7XG59XG5cbmZ1bmN0aW9uIG5vcm1hbGl6ZVRleHQgKHZhbHVlKSB7XG4gIHJldHVybiBgJHt2YWx1ZSA/PyAnJ31gLnRyaW0oKS50b0xvd2VyQ2FzZSgpO1xufVxuXG5mdW5jdGlvbiBwcmltYXJ5Q2xhc3NOYW1lIChjbGFzc05hbWUpIHtcbiAgcmV0dXJuIGAke2NsYXNzTmFtZSA/PyAnJ31gLnNwbGl0KC9cXHMrLykuZmlsdGVyKEJvb2xlYW4pWzBdIHx8ICcnO1xufVxuXG5mdW5jdGlvbiByZWN0QXJlYSAocmVjdCkge1xuICBpZiAoIXJlY3QgfHwgcmVjdC53aWR0aCA8PSAwIHx8IHJlY3QuaGVpZ2h0IDw9IDApIHtcbiAgICByZXR1cm4gMDtcbiAgfVxuICByZXR1cm4gcmVjdC53aWR0aCAqIHJlY3QuaGVpZ2h0O1xufVxuXG5mdW5jdGlvbiByZWN0T3ZlcmxhcEFyZWEgKGxlZnQsIHJpZ2h0KSB7XG4gIGlmICghbGVmdCB8fCAhcmlnaHQpIHtcbiAgICByZXR1cm4gMDtcbiAgfVxuICBjb25zdCB4MSA9IE1hdGgubWF4KGxlZnQueCwgcmlnaHQueCk7XG4gIGNvbnN0IHkxID0gTWF0aC5tYXgobGVmdC55LCByaWdodC55KTtcbiAgY29uc3QgeDIgPSBNYXRoLm1pbihsZWZ0LnggKyBsZWZ0LndpZHRoLCByaWdodC54ICsgcmlnaHQud2lkdGgpO1xuICBjb25zdCB5MiA9IE1hdGgubWluKGxlZnQueSArIGxlZnQuaGVpZ2h0LCByaWdodC55ICsgcmlnaHQuaGVpZ2h0KTtcbiAgY29uc3Qgd2lkdGggPSB4MiAtIHgxO1xuICBjb25zdCBoZWlnaHQgPSB5MiAtIHkxO1xuICBpZiAod2lkdGggPD0gMCB8fCBoZWlnaHQgPD0gMCkge1xuICAgIHJldHVybiAwO1xuICB9XG4gIHJldHVybiB3aWR0aCAqIGhlaWdodDtcbn1cblxuZnVuY3Rpb24gcmVjdENlbnRlckRpc3RhbmNlIChsZWZ0LCByaWdodCkge1xuICBpZiAoIWxlZnQgfHwgIXJpZ2h0KSB7XG4gICAgcmV0dXJuIE51bWJlci5QT1NJVElWRV9JTkZJTklUWTtcbiAgfVxuICBjb25zdCBsZWZ0Q3ggPSBsZWZ0LnggKyAobGVmdC53aWR0aCAvIDIpO1xuICBjb25zdCBsZWZ0Q3kgPSBsZWZ0LnkgKyAobGVmdC5oZWlnaHQgLyAyKTtcbiAgY29uc3QgcmlnaHRDeCA9IHJpZ2h0LnggKyAocmlnaHQud2lkdGggLyAyKTtcbiAgY29uc3QgcmlnaHRDeSA9IHJpZ2h0LnkgKyAocmlnaHQuaGVpZ2h0IC8gMik7XG4gIHJldHVybiBNYXRoLmh5cG90KGxlZnRDeCAtIHJpZ2h0Q3gsIGxlZnRDeSAtIHJpZ2h0Q3kpO1xufVxuXG5mdW5jdGlvbiBidWlsZFdpbmRvd0lkZW50aXR5IChjYW5kaWRhdGUpIHtcbiAgLy8gSW50ZW50aW9uYWxseSBleGNsdWRlcyByZWN0IGRpbWVuc2lvbnM6IHdpbmRvdyBnZW9tZXRyeSBjYW4gY2hhbmdlIChyZXNpemUsXG4gIC8vIGZvY3VzLCBHTk9NRSBsYXlvdXQgc2hpZnQpIHdpdGhvdXQgdGhlIHdpbmRvdyBpdHNlbGYgY2hhbmdpbmcgaWRlbnRpdHkuXG4gIC8vIEluY2x1ZGluZyBzaXplIGNhdXNlZCB0aGUgV2F5bGFuZCB3aWQgdG8gY2hhbmdlIG1pZC1zZXNzaW9uIG9uIFJIRUwvR05PTUUsXG4gIC8vIG1ha2luZyBwcmV2aW91c2x5LXZhbGlkIGhhbmRsZXMgc3RhbGUgYWZ0ZXIgdGhlIGZpcnN0IGNsaWNrIG9yIHRleHQgaW5wdXQuXG4gIHJldHVybiBbXG4gICAgTnVtYmVyLnBhcnNlSW50KGAke2NhbmRpZGF0ZT8ucGlkID8/ICcnfWAsIDEwKSB8fCAwLFxuICAgIGAke2NhbmRpZGF0ZT8ubm9kZVRhZyA/PyAnJ31gLnRvTG93ZXJDYXNlKCksXG4gICAgYCR7Y2FuZGlkYXRlPy53aW5kb3dUeXBlID8/ICcnfWAudG9Mb3dlckNhc2UoKSxcbiAgICBgJHtjYW5kaWRhdGU/Lm5hbWUgPz8gJyd9YC50cmltKCksXG4gICAgcHJpbWFyeUNsYXNzTmFtZShjYW5kaWRhdGU/LmNsYXNzTmFtZSksXG4gIF0uam9pbignfCcpO1xufVxuXG5mdW5jdGlvbiB3aW5kb3dDYW5kaWRhdGVTY29yZSAoY2FuZGlkYXRlKSB7XG4gIGNvbnN0IHN0YXRlcyA9IGAke2NhbmRpZGF0ZT8uc3RhdGVzID8/ICcnfWAudG9VcHBlckNhc2UoKTtcbiAgbGV0IHNjb3JlID0gcmVjdEFyZWEoY2FuZGlkYXRlPy5yZWN0KTtcbiAgaWYgKGNhbmRpZGF0ZT8ud2luZG93TGlrZSkge1xuICAgIHNjb3JlICs9IDEyMDAwMDAwMDtcbiAgfVxuICBzY29yZSArPSB0cmFuc2llbnRXaW5kb3dCb251cyhjYW5kaWRhdGUpO1xuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdBQ1RJVkUnKSkge1xuICAgIHNjb3JlICs9IDUwMDAwMDAwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ1NIT1dJTkcnKSB8fCBzdGF0ZXMuaW5jbHVkZXMoJ1ZJU0lCTEUnKSkge1xuICAgIHNjb3JlICs9IDIwMDAwMDAwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ0VOQUJMRUQnKSB8fCBzdGF0ZXMuaW5jbHVkZXMoJ1NFTlNJVElWRScpKSB7XG4gICAgc2NvcmUgKz0gNTAwMDAwMDtcbiAgfVxuICByZXR1cm4gc2NvcmU7XG59XG5cbmZ1bmN0aW9uIHBhcnNlUGlkICh2YWx1ZSkge1xuICBjb25zdCBwaWQgPSBOdW1iZXIucGFyc2VJbnQoYCR7dmFsdWUgPz8gJyd9YCwgMTApO1xuICByZXR1cm4gTnVtYmVyLmlzRmluaXRlKHBpZCkgPyBwaWQgOiBudWxsO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlTm9kZVBpZCAobm9kZSwgYXR0cnMsIHBpZFNldCkge1xuICBjb25zdCBvd25QaWQgPSBwYXJzZVBpZChhdHRycz8ucGlkKTtcbiAgaWYgKG93blBpZCAhPT0gbnVsbCAmJiBwaWRTZXQuaGFzKG93blBpZCkpIHtcbiAgICByZXR1cm4gb3duUGlkO1xuICB9XG5cbiAgY29uc3Qgc3RhY2sgPSBbXTtcbiAgdHJ5IHtcbiAgICBzdGFjay5wdXNoKC4uLkFycmF5LmZyb20obm9kZT8uY2hpbGROb2RlcyB8fCBbXSkpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICB3aGlsZSAoc3RhY2subGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHN0YWNrLnBvcCgpO1xuICAgIGlmICghY2FuZGlkYXRlIHx8IGNhbmRpZGF0ZS5ub2RlVHlwZSAhPT0gMSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGNhbmRpZGF0ZUF0dHJzID0gYXR0cnNUb09iamVjdChjYW5kaWRhdGUpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZVBpZCA9IHBhcnNlUGlkKGNhbmRpZGF0ZUF0dHJzLnBpZCk7XG4gICAgaWYgKGNhbmRpZGF0ZVBpZCAhPT0gbnVsbCAmJiBwaWRTZXQuaGFzKGNhbmRpZGF0ZVBpZCkpIHtcbiAgICAgIHJldHVybiBjYW5kaWRhdGVQaWQ7XG4gICAgfVxuICAgIHRyeSB7XG4gICAgICBzdGFjay5wdXNoKC4uLkFycmF5LmZyb20oY2FuZGlkYXRlLmNoaWxkTm9kZXMgfHwgW10pKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gZXh0cmFjdFdheWxhbmRXaW5kb3dDYW5kaWRhdGVzIChkZXNrdG9wWG1sLCBwaWRzKSB7XG4gIGlmICghYCR7ZGVza3RvcFhtbCA/PyAnJ31gLnRyaW0oKSkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBub3JtYWxpemVkUGlkcyA9IChwaWRzIHx8IFtdKVxuICAgIC5tYXAoKHBpZCkgPT4gTnVtYmVyLnBhcnNlSW50KGAke3BpZH1gLCAxMCkpXG4gICAgLmZpbHRlcigocGlkKSA9PiBOdW1iZXIuaXNGaW5pdGUocGlkKSk7XG4gIGlmIChub3JtYWxpemVkUGlkcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gW107XG4gIH1cbiAgY29uc3QgcGlkU2V0ID0gbmV3IFNldChub3JtYWxpemVkUGlkcyk7XG5cbiAgY29uc3Qgc2VyaWFsaXplciA9IG5ldyBYTUxTZXJpYWxpemVyKCk7XG4gIGNvbnN0IGRvYyA9IG5ldyBkb20oKS5wYXJzZUZyb21TdHJpbmcoZGVza3RvcFhtbCk7XG4gIGxldCBub2RlcyA9IFtdO1xuICB0cnkge1xuICAgIG5vZGVzID0gc2VsZWN0KGRvYywgJy8vKicpO1xuICB9IGNhdGNoIHtcbiAgICBub2RlcyA9IFtdO1xuICB9XG5cbiAgY29uc3QgYWxsQ2FuZGlkYXRlcyA9IFtdO1xuICBjb25zdCBleHBsaWNpdFdpbmRvd3MgPSBbXTtcbiAgZm9yIChjb25zdCBub2RlIG9mIG5vZGVzKSB7XG4gICAgY29uc3QgYXR0cnMgPSBhdHRyc1RvT2JqZWN0KG5vZGUpO1xuICAgIGNvbnN0IHdpbmRvd0xpa2UgPSBpc1dpbmRvd0xpa2VOb2RlKG5vZGUsIGF0dHJzKTtcbiAgICBjb25zdCBvd25QaWQgPSBwYXJzZVBpZChhdHRycy5waWQpO1xuICAgIGNvbnN0IHBpZCA9IG93blBpZCAhPT0gbnVsbCAmJiBwaWRTZXQuaGFzKG93blBpZClcbiAgICAgID8gb3duUGlkXG4gICAgICA6ICh3aW5kb3dMaWtlID8gcmVzb2x2ZU5vZGVQaWQobm9kZSwgYXR0cnMsIHBpZFNldCkgOiBudWxsKTtcbiAgICBpZiAoIU51bWJlci5pc0Zpbml0ZShwaWQpKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKG93blBpZCA9PT0gbnVsbCAmJiAhd2luZG93TGlrZSkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHJlY3QgPSBwYXJzZVJlY3QoYXR0cnMucmVjdCk7XG4gICAgaWYgKCFyZWN0IHx8IHJlY3Qud2lkdGggPD0gMCB8fCByZWN0LmhlaWdodCA8PSAwKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBjb25zdCByYXdOYW1lID0gYCR7YXR0cnMubmFtZSA/PyAnJ31gLnRyaW0oKTtcbiAgICBjb25zdCBjbGFzc05hbWUgPSBgJHthdHRycy5jbGFzcyA/PyAnJ31gLnRyaW0oKTtcbiAgICBjb25zdCBjYW5kaWRhdGUgPSB7XG4gICAgICBwaWQsXG4gICAgICBuYW1lOiByYXdOYW1lIHx8IHByaW1hcnlDbGFzc05hbWUoY2xhc3NOYW1lKSB8fCBgd2luZG93LSR7cGlkfWAsXG4gICAgICBjbGFzc05hbWUsXG4gICAgICBub2RlVGFnOiBgJHtub2RlPy5ub2RlTmFtZSA/PyBub2RlPy50YWdOYW1lID8/ICcnfWAudG9Mb3dlckNhc2UoKSxcbiAgICAgIHdpbmRvd1R5cGU6IGAke2F0dHJzWyd3aW5kb3ctdHlwZSddID8/ICcnfWAudHJpbSgpLFxuICAgICAgcmVjdCxcbiAgICAgIHN0YXRlczogYCR7YXR0cnMuc3RhdGVzID8/ICcnfWAudG9VcHBlckNhc2UoKSxcbiAgICAgIHdpbmRvd0xpa2UsXG4gICAgICB4bWw6IHNlcmlhbGl6ZXIuc2VyaWFsaXplVG9TdHJpbmcobm9kZSksXG4gICAgfTtcbiAgICBhbGxDYW5kaWRhdGVzLnB1c2goY2FuZGlkYXRlKTtcbiAgICBpZiAoY2FuZGlkYXRlLndpbmRvd0xpa2UpIHtcbiAgICAgIGV4cGxpY2l0V2luZG93cy5wdXNoKGNhbmRpZGF0ZSk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgY2hvc2VuQ2FuZGlkYXRlcyA9IGV4cGxpY2l0V2luZG93cy5sZW5ndGggPiAwID8gZXhwbGljaXRXaW5kb3dzIDogYWxsQ2FuZGlkYXRlcztcbiAgcmV0dXJuIGNob3NlbkNhbmRpZGF0ZXMubWFwKChjYW5kaWRhdGUpID0+ICh7XG4gICAgLi4uY2FuZGlkYXRlLFxuICAgIGlkZW50aXR5S2V5OiBidWlsZFdpbmRvd0lkZW50aXR5KGNhbmRpZGF0ZSksXG4gICAgc2NvcmU6IHdpbmRvd0NhbmRpZGF0ZVNjb3JlKGNhbmRpZGF0ZSksXG4gIH0pKTtcbn1cblxuZnVuY3Rpb24gbmV4dFdpbmRvd0hhbmRsZSAoaWRlbnRpdHlLZXksIHVzZWRXaWRzKSB7XG4gIGNvbnN0IGRpZ2VzdCA9IGNyeXB0by5jcmVhdGVIYXNoKCdzaGExJykudXBkYXRlKGlkZW50aXR5S2V5KS5kaWdlc3QoJ2hleCcpLnNsaWNlKDAsIDgpO1xuICBsZXQgd2lkID0gKE51bWJlci5wYXJzZUludChkaWdlc3QsIDE2KSAlIDIwMDAwMDAwMDApICsgMTAwMDtcbiAgd2hpbGUgKHVzZWRXaWRzLmhhcyh3aWQpKSB7XG4gICAgd2lkICs9IDE7XG4gIH1cbiAgdXNlZFdpZHMuYWRkKHdpZCk7XG4gIHJldHVybiB3aWQ7XG59XG5cbmZ1bmN0aW9uIG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MgKGNhbmRpZGF0ZXMsIHByZXZpb3VzV2lkQnlJZGVudGl0eSA9IG5ldyBNYXAoKSkge1xuICBjb25zdCBncm91cGVkID0gbmV3IE1hcCgpO1xuICBmb3IgKGNvbnN0IGNhbmRpZGF0ZSBvZiBjYW5kaWRhdGVzKSB7XG4gICAgY29uc3QgZXhpc3RpbmcgPSBncm91cGVkLmdldChjYW5kaWRhdGUuaWRlbnRpdHlLZXkpO1xuICAgIGlmICghZXhpc3RpbmcgfHwgZXhpc3Rpbmcuc2NvcmUgPCBjYW5kaWRhdGUuc2NvcmUpIHtcbiAgICAgIGdyb3VwZWQuc2V0KGNhbmRpZGF0ZS5pZGVudGl0eUtleSwge1xuICAgICAgICAuLi5jYW5kaWRhdGUsXG4gICAgICAgIGR1cGxpY2F0ZUNvdW50OiBleGlzdGluZz8uZHVwbGljYXRlQ291bnQgPz8gMSxcbiAgICAgIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChleGlzdGluZy5zY29yZSA9PT0gY2FuZGlkYXRlLnNjb3JlKSB7XG4gICAgICBleGlzdGluZy5kdXBsaWNhdGVDb3VudCArPSAxO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IHVzZWRXaWRzID0gbmV3IFNldCgpO1xuICBjb25zdCBpZGVudGl0eVRvV2lkID0gbmV3IE1hcCgpO1xuICBjb25zdCB3aW5kb3dzID0gQXJyYXkuZnJvbShncm91cGVkLnZhbHVlcygpKVxuICAgIC5zb3J0KChsZWZ0LCByaWdodCkgPT4gKFxuICAgICAgcmlnaHQuc2NvcmUgLSBsZWZ0LnNjb3JlXG4gICAgICB8fCBsZWZ0LmlkZW50aXR5S2V5LmxvY2FsZUNvbXBhcmUocmlnaHQuaWRlbnRpdHlLZXkpXG4gICAgKSlcbiAgICAubWFwKCh3aW5kb3cpID0+IHtcbiAgICAgIGNvbnN0IHByZXZpb3VzV2lkID0gcHJldmlvdXNXaWRCeUlkZW50aXR5LmdldCh3aW5kb3cuaWRlbnRpdHlLZXkpO1xuICAgICAgY29uc3Qgd2lkID0gcHJldmlvdXNXaWQgJiYgIXVzZWRXaWRzLmhhcyhwcmV2aW91c1dpZClcbiAgICAgICAgPyAodXNlZFdpZHMuYWRkKHByZXZpb3VzV2lkKSwgcHJldmlvdXNXaWQpXG4gICAgICAgIDogbmV4dFdpbmRvd0hhbmRsZSh3aW5kb3cuaWRlbnRpdHlLZXksIHVzZWRXaWRzKTtcbiAgICAgIGlkZW50aXR5VG9XaWQuc2V0KHdpbmRvdy5pZGVudGl0eUtleSwgd2lkKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIC4uLndpbmRvdyxcbiAgICAgICAgaW5wdXRPdXRwdXQ6ICd0cnVlJyxcbiAgICAgICAgd2lkLFxuICAgICAgfTtcbiAgICB9KVxuICAgIC5zb3J0KChsZWZ0LCByaWdodCkgPT4gbGVmdC53aWQgLSByaWdodC53aWQpO1xuXG4gIHJldHVybiB7XG4gICAgd2luZG93cyxcbiAgICBpZGVudGl0eVRvV2lkLFxuICB9O1xufVxuXG5mdW5jdGlvbiBzY29wZWRXaW5kb3dSZXNvbHV0aW9uU2NvcmUgKGNhbmRpZGF0ZSwgdGFyZ2V0V2luZG93KSB7XG4gIGlmICghY2FuZGlkYXRlIHx8ICF0YXJnZXRXaW5kb3cpIHtcbiAgICByZXR1cm4gTnVtYmVyLk5FR0FUSVZFX0lORklOSVRZO1xuICB9XG4gIGlmIChOdW1iZXIucGFyc2VJbnQoYCR7Y2FuZGlkYXRlLnBpZCA/PyAnJ31gLCAxMCkgIT09IE51bWJlci5wYXJzZUludChgJHt0YXJnZXRXaW5kb3cucGlkID8/ICcnfWAsIDEwKSkge1xuICAgIHJldHVybiBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIH1cblxuICBsZXQgc2NvcmUgPSAwO1xuICBpZiAoY2FuZGlkYXRlLmlkZW50aXR5S2V5ICYmIGNhbmRpZGF0ZS5pZGVudGl0eUtleSA9PT0gdGFyZ2V0V2luZG93LmlkZW50aXR5S2V5KSB7XG4gICAgc2NvcmUgKz0gMTAwMDtcbiAgfVxuXG4gIGNvbnN0IGNhbmRpZGF0ZU5hbWUgPSBub3JtYWxpemVUZXh0KGNhbmRpZGF0ZS5uYW1lKTtcbiAgY29uc3QgdGFyZ2V0TmFtZSA9IG5vcm1hbGl6ZVRleHQodGFyZ2V0V2luZG93Lm5hbWUpO1xuICBpZiAoY2FuZGlkYXRlTmFtZSAmJiB0YXJnZXROYW1lICYmIGNhbmRpZGF0ZU5hbWUgPT09IHRhcmdldE5hbWUpIHtcbiAgICBzY29yZSArPSAyNTA7XG4gIH1cblxuICBjb25zdCBjYW5kaWRhdGVDbGFzcyA9IHByaW1hcnlDbGFzc05hbWUoY2FuZGlkYXRlLmNsYXNzTmFtZSk7XG4gIGNvbnN0IHRhcmdldENsYXNzID0gcHJpbWFyeUNsYXNzTmFtZSh0YXJnZXRXaW5kb3cuY2xhc3NOYW1lKTtcbiAgaWYgKGNhbmRpZGF0ZUNsYXNzICYmIHRhcmdldENsYXNzICYmIGNhbmRpZGF0ZUNsYXNzID09PSB0YXJnZXRDbGFzcykge1xuICAgIHNjb3JlICs9IDkwO1xuICB9XG5cbiAgaWYgKG5vcm1hbGl6ZVRleHQoY2FuZGlkYXRlLm5vZGVUYWcpICYmIG5vcm1hbGl6ZVRleHQoY2FuZGlkYXRlLm5vZGVUYWcpID09PSBub3JtYWxpemVUZXh0KHRhcmdldFdpbmRvdy5ub2RlVGFnKSkge1xuICAgIHNjb3JlICs9IDcwO1xuICB9XG4gIGlmIChub3JtYWxpemVUZXh0KGNhbmRpZGF0ZS53aW5kb3dUeXBlKSAmJiBub3JtYWxpemVUZXh0KGNhbmRpZGF0ZS53aW5kb3dUeXBlKSA9PT0gbm9ybWFsaXplVGV4dCh0YXJnZXRXaW5kb3cud2luZG93VHlwZSkpIHtcbiAgICBzY29yZSArPSA2MDtcbiAgfVxuXG4gIGNvbnN0IGNhbmRpZGF0ZVJlY3QgPSBjYW5kaWRhdGUucmVjdDtcbiAgY29uc3QgdGFyZ2V0UmVjdCA9IHRhcmdldFdpbmRvdy5yZWN0O1xuICBpZiAoY2FuZGlkYXRlUmVjdCAmJiB0YXJnZXRSZWN0KSB7XG4gICAgaWYgKGNhbmRpZGF0ZVJlY3Qud2lkdGggPT09IHRhcmdldFJlY3Qud2lkdGggJiYgY2FuZGlkYXRlUmVjdC5oZWlnaHQgPT09IHRhcmdldFJlY3QuaGVpZ2h0KSB7XG4gICAgICBzY29yZSArPSA4MDtcbiAgICB9XG4gICAgaWYgKGNhbmRpZGF0ZVJlY3QueCA9PT0gdGFyZ2V0UmVjdC54ICYmIGNhbmRpZGF0ZVJlY3QueSA9PT0gdGFyZ2V0UmVjdC55KSB7XG4gICAgICBzY29yZSArPSA0MDtcbiAgICB9XG4gICAgY29uc3Qgb3ZlcmxhcEFyZWEgPSByZWN0T3ZlcmxhcEFyZWEoY2FuZGlkYXRlUmVjdCwgdGFyZ2V0UmVjdCk7XG4gICAgaWYgKG92ZXJsYXBBcmVhID4gMCkge1xuICAgICAgc2NvcmUgKz0gTWF0aC5yb3VuZCgob3ZlcmxhcEFyZWEgLyBNYXRoLm1heChyZWN0QXJlYSh0YXJnZXRSZWN0KSwgMSkpICogMTAwKTtcbiAgICB9XG4gICAgY29uc3QgY2VudGVyRGlzdGFuY2UgPSByZWN0Q2VudGVyRGlzdGFuY2UoY2FuZGlkYXRlUmVjdCwgdGFyZ2V0UmVjdCk7XG4gICAgaWYgKE51bWJlci5pc0Zpbml0ZShjZW50ZXJEaXN0YW5jZSkpIHtcbiAgICAgIHNjb3JlICs9IE1hdGgubWF4KDAsIDMwIC0gTWF0aC5taW4oY2VudGVyRGlzdGFuY2UsIDMwMCkgLyAxMCk7XG4gICAgfVxuICB9XG5cbiAgaWYgKGNhbmRpZGF0ZS53aW5kb3dMaWtlKSB7XG4gICAgc2NvcmUgKz0gNDA7XG4gIH1cbiAgaWYgKGAke2NhbmRpZGF0ZS5zdGF0ZXMgPz8gJyd9YC5pbmNsdWRlcygnQUNUSVZFJykpIHtcbiAgICBzY29yZSArPSAzMDtcbiAgfVxuICBpZiAoYCR7Y2FuZGlkYXRlLnN0YXRlcyA/PyAnJ31gLmluY2x1ZGVzKCdTSE9XSU5HJykgfHwgYCR7Y2FuZGlkYXRlLnN0YXRlcyA/PyAnJ31gLmluY2x1ZGVzKCdWSVNJQkxFJykpIHtcbiAgICBzY29yZSArPSAyNTtcbiAgfVxuICBpZiAoYCR7Y2FuZGlkYXRlLnN0YXRlcyA/PyAnJ31gLmluY2x1ZGVzKCdFTkFCTEVEJykgfHwgYCR7Y2FuZGlkYXRlLnN0YXRlcyA/PyAnJ31gLmluY2x1ZGVzKCdTRU5TSVRJVkUnKSkge1xuICAgIHNjb3JlICs9IDEwO1xuICB9XG4gIHJldHVybiBzY29yZTtcbn1cblxuZnVuY3Rpb24gdHJhbnNpZW50T3ZlcmxheVJlc29sdXRpb25TY29yZSAoY2FuZGlkYXRlLCB0YXJnZXRXaW5kb3cpIHtcbiAgaWYgKCFjYW5kaWRhdGUgfHwgIXRhcmdldFdpbmRvdyB8fCAhaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUoY2FuZGlkYXRlKSkge1xuICAgIHJldHVybiBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIH1cbiAgaWYgKE51bWJlci5wYXJzZUludChgJHtjYW5kaWRhdGUucGlkID8/ICcnfWAsIDEwKSAhPT0gTnVtYmVyLnBhcnNlSW50KGAke3RhcmdldFdpbmRvdy5waWQgPz8gJyd9YCwgMTApKSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuICBpZiAoY2FuZGlkYXRlLmlkZW50aXR5S2V5ICYmIHRhcmdldFdpbmRvdy5pZGVudGl0eUtleSAmJiBjYW5kaWRhdGUuaWRlbnRpdHlLZXkgPT09IHRhcmdldFdpbmRvdy5pZGVudGl0eUtleSkge1xuICAgIHJldHVybiBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIH1cblxuICBjb25zdCBjYW5kaWRhdGVSZWN0ID0gY2FuZGlkYXRlLnJlY3Q7XG4gIGNvbnN0IHRhcmdldFJlY3QgPSB0YXJnZXRXaW5kb3cucmVjdDtcbiAgY29uc3Qgb3ZlcmxhcEFyZWEgPSByZWN0T3ZlcmxhcEFyZWEoY2FuZGlkYXRlUmVjdCwgdGFyZ2V0UmVjdCk7XG4gIGNvbnN0IGNhbmRpZGF0ZUFyZWEgPSByZWN0QXJlYShjYW5kaWRhdGVSZWN0KTtcbiAgY29uc3QgdGFyZ2V0QXJlYSA9IHJlY3RBcmVhKHRhcmdldFJlY3QpO1xuICBpZiAoIWNhbmRpZGF0ZUFyZWEgfHwgIXRhcmdldEFyZWEgfHwgb3ZlcmxhcEFyZWEgPD0gMCkge1xuICAgIHJldHVybiBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIH1cblxuICBjb25zdCBvdmVybGFwUmF0aW8gPSBvdmVybGFwQXJlYSAvIE1hdGgubWF4KGNhbmRpZGF0ZUFyZWEsIDEpO1xuICBjb25zdCBjb3ZlcmFnZVJhdGlvID0gb3ZlcmxhcEFyZWEgLyBNYXRoLm1heCh0YXJnZXRBcmVhLCAxKTtcbiAgaWYgKG92ZXJsYXBSYXRpbyA8IDAuNSAmJiBjb3ZlcmFnZVJhdGlvIDwgMC4xKSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuXG4gIGxldCBzY29yZSA9IHRyYW5zaWVudFdpbmRvd0JvbnVzKGNhbmRpZGF0ZSk7XG4gIGNvbnN0IHN0YXRlcyA9IGAke2NhbmRpZGF0ZS5zdGF0ZXMgPz8gJyd9YC50b1VwcGVyQ2FzZSgpO1xuICBpZiAoc3RhdGVzLmluY2x1ZGVzKCdNT0RBTCcpKSB7XG4gICAgc2NvcmUgKz0gMTUwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ0FDVElWRScpKSB7XG4gICAgc2NvcmUgKz0gMTIwO1xuICB9XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ1NIT1dJTkcnKSB8fCBzdGF0ZXMuaW5jbHVkZXMoJ1ZJU0lCTEUnKSkge1xuICAgIHNjb3JlICs9IDgwO1xuICB9XG4gIGlmIChjYW5kaWRhdGVBcmVhIDw9IHRhcmdldEFyZWEpIHtcbiAgICBzY29yZSArPSA0MDtcbiAgfVxuICBzY29yZSArPSBNYXRoLnJvdW5kKG92ZXJsYXBSYXRpbyAqIDEwMCk7XG4gIHNjb3JlICs9IE1hdGgucm91bmQoY292ZXJhZ2VSYXRpbyAqIDEwMCk7XG4gIGNvbnN0IGNlbnRlckRpc3RhbmNlID0gcmVjdENlbnRlckRpc3RhbmNlKGNhbmRpZGF0ZVJlY3QsIHRhcmdldFJlY3QpO1xuICBpZiAoTnVtYmVyLmlzRmluaXRlKGNlbnRlckRpc3RhbmNlKSkge1xuICAgIHNjb3JlICs9IE1hdGgubWF4KDAsIDQwIC0gTWF0aC5taW4oY2VudGVyRGlzdGFuY2UsIDQwMCkgLyAxMCk7XG4gIH1cbiAgcmV0dXJuIHNjb3JlO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlV2F5bGFuZFRyYW5zaWVudE92ZXJsYXlDYW5kaWRhdGUgKGNhbmRpZGF0ZXMsIHRhcmdldFdpbmRvdykge1xuICBpZiAoIXRhcmdldFdpbmRvdyB8fCBpc1RyYW5zaWVudFdpbmRvd0NhbmRpZGF0ZSh0YXJnZXRXaW5kb3cpKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3Qgc2NvcmVkID0gY2FuZGlkYXRlc1xuICAgIC5tYXAoKGNhbmRpZGF0ZSkgPT4gKHtcbiAgICAgIGNhbmRpZGF0ZSxcbiAgICAgIHNjb3JlOiB0cmFuc2llbnRPdmVybGF5UmVzb2x1dGlvblNjb3JlKGNhbmRpZGF0ZSwgdGFyZ2V0V2luZG93KSxcbiAgICB9KSlcbiAgICAuZmlsdGVyKChpdGVtKSA9PiBOdW1iZXIuaXNGaW5pdGUoaXRlbS5zY29yZSkgJiYgaXRlbS5zY29yZSA+IDApXG4gICAgLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiByaWdodC5zY29yZSAtIGxlZnQuc2NvcmUpO1xuICBpZiAoc2NvcmVkLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmIChzY29yZWQubGVuZ3RoID4gMSAmJiBzY29yZWRbMF0uc2NvcmUgPT09IHNjb3JlZFsxXS5zY29yZSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiBzY29yZWRbMF0uY2FuZGlkYXRlO1xufVxuXG5mdW5jdGlvbiByZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbCAoZGVza3RvcFhtbCwgcGlkcywgdGFyZ2V0V2luZG93LCBvcHRpb25zID0ge30pIHtcbiAgY29uc3Qge2FsbG93VHJhbnNpZW50T3ZlcmxheSA9IGZhbHNlfSA9IG9wdGlvbnM7XG4gIGNvbnN0IGNhbmRpZGF0ZXMgPSBleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMoZGVza3RvcFhtbCwgcGlkcyk7XG4gIGlmIChhbGxvd1RyYW5zaWVudE92ZXJsYXkpIHtcbiAgICBjb25zdCB0cmFuc2llbnRPdmVybGF5ID0gcmVzb2x2ZVdheWxhbmRUcmFuc2llbnRPdmVybGF5Q2FuZGlkYXRlKGNhbmRpZGF0ZXMsIHRhcmdldFdpbmRvdyk7XG4gICAgaWYgKHRyYW5zaWVudE92ZXJsYXk/LnhtbCkge1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgeG1sOiB0cmFuc2llbnRPdmVybGF5LnhtbCxcbiAgICAgICAgcmVhc29uOiAnb2snLFxuICAgICAgICBjYW5kaWRhdGU6IHRyYW5zaWVudE92ZXJsYXksXG4gICAgICAgIHJlZGlyZWN0ZWRUb1RyYW5zaWVudE92ZXJsYXk6IHRydWUsXG4gICAgICB9O1xuICAgIH1cbiAgfVxuICBjb25zdCBzY29yZWQgPSBjYW5kaWRhdGVzXG4gICAgLm1hcCgoY2FuZGlkYXRlKSA9PiAoe1xuICAgICAgY2FuZGlkYXRlLFxuICAgICAgc2NvcmU6IHNjb3BlZFdpbmRvd1Jlc29sdXRpb25TY29yZShjYW5kaWRhdGUsIHRhcmdldFdpbmRvdyksXG4gICAgfSkpXG4gICAgLmZpbHRlcigoaXRlbSkgPT4gTnVtYmVyLmlzRmluaXRlKGl0ZW0uc2NvcmUpICYmIGl0ZW0uc2NvcmUgPiAwKVxuICAgIC5zb3J0KChsZWZ0LCByaWdodCkgPT4gcmlnaHQuc2NvcmUgLSBsZWZ0LnNjb3JlKTtcblxuICBpZiAoc2NvcmVkLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICB4bWw6ICcnLFxuICAgICAgcmVhc29uOiAnbm90X2ZvdW5kJyxcbiAgICB9O1xuICB9XG4gIGlmIChzY29yZWQubGVuZ3RoID4gMSAmJiBzY29yZWRbMF0uc2NvcmUgPT09IHNjb3JlZFsxXS5zY29yZSkge1xuICAgIHJldHVybiB7XG4gICAgICB4bWw6ICcnLFxuICAgICAgcmVhc29uOiAnYW1iaWd1b3VzJyxcbiAgICB9O1xuICB9XG4gIHJldHVybiB7XG4gICAgeG1sOiBzY29yZWRbMF0uY2FuZGlkYXRlLnhtbCxcbiAgICByZWFzb246ICdvaycsXG4gICAgY2FuZGlkYXRlOiBzY29yZWRbMF0uY2FuZGlkYXRlLFxuICB9O1xufVxuXG5leHBvcnQge1xuICBhdHRyc1RvT2JqZWN0LFxuICBidWlsZFdpbmRvd0lkZW50aXR5LFxuICBleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMsXG4gIGlzV2luZG93TGlrZU5vZGUsXG4gIGlzVHJhbnNpZW50V2luZG93Q2FuZGlkYXRlLFxuICBtYXRlcmlhbGl6ZVdheWxhbmRXaW5kb3dzLFxuICBwYXJzZVJlY3QsXG4gIHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sLFxuICBzY29wZWRXaW5kb3dSZXNvbHV0aW9uU2NvcmUsXG4gIHdpbmRvd0NhbmRpZGF0ZVNjb3JlLFxufTtcbiJdLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7Ozs7Ozs7Ozs7QUFBQSxJQUFBQSxPQUFBLEdBQUFDLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBQyxNQUFBLEdBQUFGLHNCQUFBLENBQUFDLE9BQUE7QUFDQSxJQUFBRSxPQUFBLEdBQUFGLE9BQUE7QUFFQSxTQUFTRyxTQUFTQSxDQUFFQyxJQUFJLEVBQUU7RUFDeEIsTUFBTUMsS0FBSyxHQUFHLDREQUE0RCxDQUFDQyxJQUFJLENBQUMsR0FBR0YsSUFBSSxhQUFKQSxJQUFJLGNBQUpBLElBQUksR0FBSSxFQUFFLEVBQUUsQ0FBQztFQUNoRyxJQUFJLENBQUNDLEtBQUssRUFBRTtJQUNWLE9BQU8sSUFBSTtFQUNiO0VBQ0EsTUFBTTtJQUFDRSxDQUFDO0lBQUVDLENBQUM7SUFBRUMsS0FBSztJQUFFQztFQUFNLENBQUMsR0FBR0wsS0FBSyxDQUFDTSxNQUFNO0VBQzFD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
