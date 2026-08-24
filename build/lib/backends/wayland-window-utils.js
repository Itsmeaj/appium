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
var _xmldom = require("@xmldom/xmldom");
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibGliL2JhY2tlbmRzL3dheWxhbmQtd2luZG93LXV0aWxzLmpzIiwibmFtZXMiOlsiX2NyeXB0byIsIl9pbnRlcm9wUmVxdWlyZURlZmF1bHQiLCJyZXF1aXJlIiwiX3hwYXRoIiwiX3htbGRvbSIsInBhcnNlUmVjdCIsInJlY3QiLCJtYXRjaCIsImV4ZWMiLCJ4IiwieSIsIndpZHRoIiwiaGVpZ2h0IiwiZ3JvdXBzIiwiTnVtYmVyIiwicGFyc2VJbnQiLCJhdHRyc1RvT2JqZWN0Iiwibm9kZSIsImF0dHJpYnV0ZXMiLCJhdHRycyIsImF0dHIiLCJBcnJheSIsImZyb20iLCJuYW1lIiwidmFsdWUiLCJXSU5ET1dfTElLRV9UT0tFTlMiLCJUUkFOU0lFTlRfV0lORE9XX1RPS0VOUyIsImluY2x1ZGVzV2luZG93VG9rZW4iLCJ0b2tlbnMiLCJub3JtYWxpemVkIiwidG9Mb3dlckNhc2UiLCJzb21lIiwidG9rZW4iLCJpbmNsdWRlcyIsImlzV2luZG93TGlrZU5vZGUiLCJfcmVmIiwiX25vZGUkbm9kZU5hbWUiLCJfYXR0cnMkcm9sZSIsIl9hdHRycyR4bWxSb2xlcyIsIl9hdHRycyR3aW5kb3dUeXBlIiwidGFnIiwibm9kZU5hbWUiLCJ0YWdOYW1lIiwicm9sZU5hbWUiLCJyb2xlIiwieG1sUm9sZXMiLCJ3aW5kb3dUeXBlIiwidHJhbnNpZW50V2luZG93Qm9udXMiLCJjYW5kaWRhdGUiLCJfY2FuZGlkYXRlJG5vZGVUYWciLCJfY2FuZGlkYXRlJHdpbmRvd1R5cGUiLCJub2RlVGFnIiwiaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUiLCJfY2FuZGlkYXRlJG5vZGVUYWcyIiwiX2NhbmRpZGF0ZSR3aW5kb3dUeXBlMiIsIl9jYW5kaWRhdGUkc3RhdGVzIiwic3RhdGVzIiwidG9VcHBlckNhc2UiLCJub3JtYWxpemVUZXh0IiwidHJpbSIsInByaW1hcnlDbGFzc05hbWUiLCJjbGFzc05hbWUiLCJzcGxpdCIsImZpbHRlciIsIkJvb2xlYW4iLCJyZWN0QXJlYSIsInJlY3RPdmVybGFwQXJlYSIsImxlZnQiLCJyaWdodCIsIngxIiwiTWF0aCIsIm1heCIsInkxIiwieDIiLCJtaW4iLCJ5MiIsInJlY3RDZW50ZXJEaXN0YW5jZSIsIlBPU0lUSVZFX0lORklOSVRZIiwibGVmdEN4IiwibGVmdEN5IiwicmlnaHRDeCIsInJpZ2h0Q3kiLCJoeXBvdCIsImJ1aWxkV2luZG93SWRlbnRpdHkiLCJfY2FuZGlkYXRlJHBpZCIsIl9jYW5kaWRhdGUkbm9kZVRhZzMiLCJfY2FuZGlkYXRlJHdpbmRvd1R5cGUzIiwiX2NhbmRpZGF0ZSRuYW1lIiwicGlkIiwiam9pbiIsIndpbmRvd0NhbmRpZGF0ZVNjb3JlIiwiX2NhbmRpZGF0ZSRzdGF0ZXMyIiwic2NvcmUiLCJ3aW5kb3dMaWtlIiwicGFyc2VQaWQiLCJpc0Zpbml0ZSIsInJlc29sdmVOb2RlUGlkIiwicGlkU2V0Iiwib3duUGlkIiwiaGFzIiwic3RhY2siLCJwdXNoIiwiY2hpbGROb2RlcyIsImxlbmd0aCIsInBvcCIsIm5vZGVUeXBlIiwiY2FuZGlkYXRlQXR0cnMiLCJjYW5kaWRhdGVQaWQiLCJleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMiLCJkZXNrdG9wWG1sIiwicGlkcyIsIm5vcm1hbGl6ZWRQaWRzIiwibWFwIiwiU2V0Iiwic2VyaWFsaXplciIsIlhNTFNlcmlhbGl6ZXIiLCJkb2MiLCJkb20iLCJwYXJzZUZyb21TdHJpbmciLCJub2RlcyIsInNlbGVjdCIsImFsbENhbmRpZGF0ZXMiLCJleHBsaWNpdFdpbmRvd3MiLCJfYXR0cnMkbmFtZSIsIl9hdHRycyRjbGFzcyIsIl9yZWYyIiwiX25vZGUkbm9kZU5hbWUyIiwiX2F0dHJzJHdpbmRvd1R5cGUyIiwiX2F0dHJzJHN0YXRlcyIsInJhd05hbWUiLCJjbGFzcyIsInhtbCIsInNlcmlhbGl6ZVRvU3RyaW5nIiwiY2hvc2VuQ2FuZGlkYXRlcyIsImlkZW50aXR5S2V5IiwibmV4dFdpbmRvd0hhbmRsZSIsInVzZWRXaWRzIiwiZGlnZXN0IiwiY3J5cHRvIiwiY3JlYXRlSGFzaCIsInVwZGF0ZSIsInNsaWNlIiwid2lkIiwiYWRkIiwibWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyIsImNhbmRpZGF0ZXMiLCJwcmV2aW91c1dpZEJ5SWRlbnRpdHkiLCJNYXAiLCJncm91cGVkIiwiZXhpc3RpbmciLCJnZXQiLCJfZXhpc3RpbmckZHVwbGljYXRlQ28iLCJzZXQiLCJkdXBsaWNhdGVDb3VudCIsImlkZW50aXR5VG9XaWQiLCJ3aW5kb3dzIiwidmFsdWVzIiwic29ydCIsImxvY2FsZUNvbXBhcmUiLCJ3aW5kb3ciLCJwcmV2aW91c1dpZCIsImlucHV0T3V0cHV0Iiwic2NvcGVkV2luZG93UmVzb2x1dGlvblNjb3JlIiwidGFyZ2V0V2luZG93IiwiX2NhbmRpZGF0ZSRwaWQyIiwiX3RhcmdldFdpbmRvdyRwaWQiLCJfY2FuZGlkYXRlJHN0YXRlczMiLCJfY2FuZGlkYXRlJHN0YXRlczQiLCJfY2FuZGlkYXRlJHN0YXRlczUiLCJfY2FuZGlkYXRlJHN0YXRlczYiLCJfY2FuZGlkYXRlJHN0YXRlczciLCJORUdBVElWRV9JTkZJTklUWSIsImNhbmRpZGF0ZU5hbWUiLCJ0YXJnZXROYW1lIiwiY2FuZGlkYXRlQ2xhc3MiLCJ0YXJnZXRDbGFzcyIsImNhbmRpZGF0ZVJlY3QiLCJ0YXJnZXRSZWN0Iiwib3ZlcmxhcEFyZWEiLCJyb3VuZCIsImNlbnRlckRpc3RhbmNlIiwidHJhbnNpZW50T3ZlcmxheVJlc29sdXRpb25TY29yZSIsIl9jYW5kaWRhdGUkcGlkMyIsIl90YXJnZXRXaW5kb3ckcGlkMiIsIl9jYW5kaWRhdGUkc3RhdGVzOCIsImNhbmRpZGF0ZUFyZWEiLCJ0YXJnZXRBcmVhIiwib3ZlcmxhcFJhdGlvIiwiY292ZXJhZ2VSYXRpbyIsInJlc29sdmVXYXlsYW5kVHJhbnNpZW50T3ZlcmxheUNhbmRpZGF0ZSIsInNjb3JlZCIsIml0ZW0iLCJyZXNvbHZlV2F5bGFuZFNjb3BlZFdpbmRvd1htbCIsIm9wdGlvbnMiLCJhbGxvd1RyYW5zaWVudE92ZXJsYXkiLCJ0cmFuc2llbnRPdmVybGF5IiwicmVhc29uIiwicmVkaXJlY3RlZFRvVHJhbnNpZW50T3ZlcmxheSJdLCJzb3VyY2VSb290IjoiLi4vLi4vLi4iLCJzb3VyY2VzIjpbImxpYi9iYWNrZW5kcy93YXlsYW5kLXdpbmRvdy11dGlscy5qcyJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgY3J5cHRvIGZyb20gJ2NyeXB0byc7XG5pbXBvcnQgc2VsZWN0IGZyb20gJ3hwYXRoLmpzJztcbmltcG9ydCB7IERPTVBhcnNlciBhcyBkb20sIFhNTFNlcmlhbGl6ZXIgfSBmcm9tICdAeG1sZG9tL3htbGRvbSc7XG5cbmZ1bmN0aW9uIHBhcnNlUmVjdCAocmVjdCkge1xuICBjb25zdCBtYXRjaCA9IC9eXFxbKD88eD4tP1xcZCspLCg/PHk+LT9cXGQrKSwoPzx3aWR0aD5cXGQrKSwoPzxoZWlnaHQ+XFxkKylcXF0kLy5leGVjKGAke3JlY3QgPz8gJyd9YCk7XG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCB7eCwgeSwgd2lkdGgsIGhlaWdodH0gPSBtYXRjaC5ncm91cHM7XG4gIHJldHVybiB7XG4gICAgeDogTnVtYmVyLnBhcnNlSW50KHgsIDEwKSxcbiAgICB5OiBOdW1iZXIucGFyc2VJbnQoeSwgMTApLFxuICAgIHdpZHRoOiBOdW1iZXIucGFyc2VJbnQod2lkdGgsIDEwKSxcbiAgICBoZWlnaHQ6IE51bWJlci5wYXJzZUludChoZWlnaHQsIDEwKSxcbiAgfTtcbn1cblxuZnVuY3Rpb24gYXR0cnNUb09iamVjdCAobm9kZSkge1xuICBpZiAoIW5vZGU/LmF0dHJpYnV0ZXMpIHtcbiAgICByZXR1cm4ge307XG4gIH1cbiAgY29uc3QgYXR0cnMgPSB7fTtcbiAgZm9yIChjb25zdCBhdHRyIG9mIEFycmF5LmZyb20obm9kZS5hdHRyaWJ1dGVzKSkge1xuICAgIGF0dHJzW2F0dHIubmFtZV0gPSBhdHRyLnZhbHVlO1xuICB9XG4gIHJldHVybiBhdHRycztcbn1cblxuY29uc3QgV0lORE9XX0xJS0VfVE9LRU5TID0gWyd3aW5kb3cnLCAnZnJhbWUnLCAnZGlhbG9nJywgJ2FsZXJ0JywgJ25vdGlmaWNhdGlvbicsICdwb3BvdmVyJ107XG5jb25zdCBUUkFOU0lFTlRfV0lORE9XX1RPS0VOUyA9IFsnYWxlcnQnLCAnZGlhbG9nJywgJ21vZGFsJywgJ25vdGlmaWNhdGlvbicsICdwb3BvdmVyJywgJ3BvcHVwJywgJ3Rvb2x0aXAnXTtcblxuZnVuY3Rpb24gaW5jbHVkZXNXaW5kb3dUb2tlbiAodmFsdWUsIHRva2Vucykge1xuICBjb25zdCBub3JtYWxpemVkID0gYCR7dmFsdWUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBpZiAoIW5vcm1hbGl6ZWQpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgcmV0dXJuIHRva2Vucy5zb21lKCh0b2tlbikgPT4gbm9ybWFsaXplZC5pbmNsdWRlcyh0b2tlbikpO1xufVxuXG5mdW5jdGlvbiBpc1dpbmRvd0xpa2VOb2RlIChub2RlLCBhdHRycykge1xuICBjb25zdCB0YWcgPSBgJHtub2RlPy5ub2RlTmFtZSA/PyBub2RlPy50YWdOYW1lID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3Qgcm9sZU5hbWUgPSBgJHthdHRycz8ucm9sZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHhtbFJvbGVzID0gYCR7YXR0cnM/LlsneG1sLXJvbGVzJ10gPz8gJyd9YC50b0xvd2VyQ2FzZSgpO1xuICBjb25zdCB3aW5kb3dUeXBlID0gYCR7YXR0cnM/Llsnd2luZG93LXR5cGUnXSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIHJldHVybiBbdGFnLCByb2xlTmFtZSwgeG1sUm9sZXMsIHdpbmRvd1R5cGVdLnNvbWUoKHZhbHVlKSA9PiBpbmNsdWRlc1dpbmRvd1Rva2VuKHZhbHVlLCBXSU5ET1dfTElLRV9UT0tFTlMpKTtcbn1cblxuZnVuY3Rpb24gdHJhbnNpZW50V2luZG93Qm9udXMgKGNhbmRpZGF0ZSkge1xuICBjb25zdCBub2RlVGFnID0gYCR7Y2FuZGlkYXRlPy5ub2RlVGFnID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3Qgd2luZG93VHlwZSA9IGAke2NhbmRpZGF0ZT8ud2luZG93VHlwZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGlmIChbbm9kZVRhZywgd2luZG93VHlwZV0uc29tZSgodmFsdWUpID0+IGluY2x1ZGVzV2luZG93VG9rZW4odmFsdWUsIFsnYWxlcnQnXSkpKSB7XG4gICAgcmV0dXJuIDEwMDAwMDAwMDtcbiAgfVxuICBpZiAoW25vZGVUYWcsIHdpbmRvd1R5cGVdLnNvbWUoKHZhbHVlKSA9PiBpbmNsdWRlc1dpbmRvd1Rva2VuKHZhbHVlLCBbJ2RpYWxvZycsICdtb2RhbCddKSkpIHtcbiAgICByZXR1cm4gODAwMDAwMDA7XG4gIH1cbiAgaWYgKFtub2RlVGFnLCB3aW5kb3dUeXBlXS5zb21lKCh2YWx1ZSkgPT4gaW5jbHVkZXNXaW5kb3dUb2tlbih2YWx1ZSwgVFJBTlNJRU5UX1dJTkRPV19UT0tFTlMpKSkge1xuICAgIHJldHVybiA2MDAwMDAwMDtcbiAgfVxuICByZXR1cm4gMDtcbn1cblxuZnVuY3Rpb24gaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUgKGNhbmRpZGF0ZSkge1xuICBjb25zdCBub2RlVGFnID0gYCR7Y2FuZGlkYXRlPy5ub2RlVGFnID8/ICcnfWAudG9Mb3dlckNhc2UoKTtcbiAgY29uc3Qgd2luZG93VHlwZSA9IGAke2NhbmRpZGF0ZT8ud2luZG93VHlwZSA/PyAnJ31gLnRvTG93ZXJDYXNlKCk7XG4gIGNvbnN0IHN0YXRlcyA9IGAke2NhbmRpZGF0ZT8uc3RhdGVzID8/ICcnfWAudG9VcHBlckNhc2UoKTtcbiAgcmV0dXJuIChcbiAgICBbbm9kZVRhZywgd2luZG93VHlwZV0uc29tZSgodmFsdWUpID0+IGluY2x1ZGVzV2luZG93VG9rZW4odmFsdWUsIFRSQU5TSUVOVF9XSU5ET1dfVE9LRU5TKSlcbiAgICB8fCBzdGF0ZXMuaW5jbHVkZXMoJ01PREFMJylcbiAgKTtcbn1cblxuZnVuY3Rpb24gbm9ybWFsaXplVGV4dCAodmFsdWUpIHtcbiAgcmV0dXJuIGAke3ZhbHVlID8/ICcnfWAudHJpbSgpLnRvTG93ZXJDYXNlKCk7XG59XG5cbmZ1bmN0aW9uIHByaW1hcnlDbGFzc05hbWUgKGNsYXNzTmFtZSkge1xuICByZXR1cm4gYCR7Y2xhc3NOYW1lID8/ICcnfWAuc3BsaXQoL1xccysvKS5maWx0ZXIoQm9vbGVhbilbMF0gfHwgJyc7XG59XG5cbmZ1bmN0aW9uIHJlY3RBcmVhIChyZWN0KSB7XG4gIGlmICghcmVjdCB8fCByZWN0LndpZHRoIDw9IDAgfHwgcmVjdC5oZWlnaHQgPD0gMCkge1xuICAgIHJldHVybiAwO1xuICB9XG4gIHJldHVybiByZWN0LndpZHRoICogcmVjdC5oZWlnaHQ7XG59XG5cbmZ1bmN0aW9uIHJlY3RPdmVybGFwQXJlYSAobGVmdCwgcmlnaHQpIHtcbiAgaWYgKCFsZWZ0IHx8ICFyaWdodCkge1xuICAgIHJldHVybiAwO1xuICB9XG4gIGNvbnN0IHgxID0gTWF0aC5tYXgobGVmdC54LCByaWdodC54KTtcbiAgY29uc3QgeTEgPSBNYXRoLm1heChsZWZ0LnksIHJpZ2h0LnkpO1xuICBjb25zdCB4MiA9IE1hdGgubWluKGxlZnQueCArIGxlZnQud2lkdGgsIHJpZ2h0LnggKyByaWdodC53aWR0aCk7XG4gIGNvbnN0IHkyID0gTWF0aC5taW4obGVmdC55ICsgbGVmdC5oZWlnaHQsIHJpZ2h0LnkgKyByaWdodC5oZWlnaHQpO1xuICBjb25zdCB3aWR0aCA9IHgyIC0geDE7XG4gIGNvbnN0IGhlaWdodCA9IHkyIC0geTE7XG4gIGlmICh3aWR0aCA8PSAwIHx8IGhlaWdodCA8PSAwKSB7XG4gICAgcmV0dXJuIDA7XG4gIH1cbiAgcmV0dXJuIHdpZHRoICogaGVpZ2h0O1xufVxuXG5mdW5jdGlvbiByZWN0Q2VudGVyRGlzdGFuY2UgKGxlZnQsIHJpZ2h0KSB7XG4gIGlmICghbGVmdCB8fCAhcmlnaHQpIHtcbiAgICByZXR1cm4gTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZO1xuICB9XG4gIGNvbnN0IGxlZnRDeCA9IGxlZnQueCArIChsZWZ0LndpZHRoIC8gMik7XG4gIGNvbnN0IGxlZnRDeSA9IGxlZnQueSArIChsZWZ0LmhlaWdodCAvIDIpO1xuICBjb25zdCByaWdodEN4ID0gcmlnaHQueCArIChyaWdodC53aWR0aCAvIDIpO1xuICBjb25zdCByaWdodEN5ID0gcmlnaHQueSArIChyaWdodC5oZWlnaHQgLyAyKTtcbiAgcmV0dXJuIE1hdGguaHlwb3QobGVmdEN4IC0gcmlnaHRDeCwgbGVmdEN5IC0gcmlnaHRDeSk7XG59XG5cbmZ1bmN0aW9uIGJ1aWxkV2luZG93SWRlbnRpdHkgKGNhbmRpZGF0ZSkge1xuICAvLyBJbnRlbnRpb25hbGx5IGV4Y2x1ZGVzIHJlY3QgZGltZW5zaW9uczogd2luZG93IGdlb21ldHJ5IGNhbiBjaGFuZ2UgKHJlc2l6ZSxcbiAgLy8gZm9jdXMsIEdOT01FIGxheW91dCBzaGlmdCkgd2l0aG91dCB0aGUgd2luZG93IGl0c2VsZiBjaGFuZ2luZyBpZGVudGl0eS5cbiAgLy8gSW5jbHVkaW5nIHNpemUgY2F1c2VkIHRoZSBXYXlsYW5kIHdpZCB0byBjaGFuZ2UgbWlkLXNlc3Npb24gb24gUkhFTC9HTk9NRSxcbiAgLy8gbWFraW5nIHByZXZpb3VzbHktdmFsaWQgaGFuZGxlcyBzdGFsZSBhZnRlciB0aGUgZmlyc3QgY2xpY2sgb3IgdGV4dCBpbnB1dC5cbiAgcmV0dXJuIFtcbiAgICBOdW1iZXIucGFyc2VJbnQoYCR7Y2FuZGlkYXRlPy5waWQgPz8gJyd9YCwgMTApIHx8IDAsXG4gICAgYCR7Y2FuZGlkYXRlPy5ub2RlVGFnID8/ICcnfWAudG9Mb3dlckNhc2UoKSxcbiAgICBgJHtjYW5kaWRhdGU/LndpbmRvd1R5cGUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpLFxuICAgIGAke2NhbmRpZGF0ZT8ubmFtZSA/PyAnJ31gLnRyaW0oKSxcbiAgICBwcmltYXJ5Q2xhc3NOYW1lKGNhbmRpZGF0ZT8uY2xhc3NOYW1lKSxcbiAgXS5qb2luKCd8Jyk7XG59XG5cbmZ1bmN0aW9uIHdpbmRvd0NhbmRpZGF0ZVNjb3JlIChjYW5kaWRhdGUpIHtcbiAgY29uc3Qgc3RhdGVzID0gYCR7Y2FuZGlkYXRlPy5zdGF0ZXMgPz8gJyd9YC50b1VwcGVyQ2FzZSgpO1xuICBsZXQgc2NvcmUgPSByZWN0QXJlYShjYW5kaWRhdGU/LnJlY3QpO1xuICBpZiAoY2FuZGlkYXRlPy53aW5kb3dMaWtlKSB7XG4gICAgc2NvcmUgKz0gMTIwMDAwMDAwO1xuICB9XG4gIHNjb3JlICs9IHRyYW5zaWVudFdpbmRvd0JvbnVzKGNhbmRpZGF0ZSk7XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ0FDVElWRScpKSB7XG4gICAgc2NvcmUgKz0gNTAwMDAwMDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnU0hPV0lORycpIHx8IHN0YXRlcy5pbmNsdWRlcygnVklTSUJMRScpKSB7XG4gICAgc2NvcmUgKz0gMjAwMDAwMDA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnRU5BQkxFRCcpIHx8IHN0YXRlcy5pbmNsdWRlcygnU0VOU0lUSVZFJykpIHtcbiAgICBzY29yZSArPSA1MDAwMDAwO1xuICB9XG4gIHJldHVybiBzY29yZTtcbn1cblxuZnVuY3Rpb24gcGFyc2VQaWQgKHZhbHVlKSB7XG4gIGNvbnN0IHBpZCA9IE51bWJlci5wYXJzZUludChgJHt2YWx1ZSA/PyAnJ31gLCAxMCk7XG4gIHJldHVybiBOdW1iZXIuaXNGaW5pdGUocGlkKSA/IHBpZCA6IG51bGw7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVOb2RlUGlkIChub2RlLCBhdHRycywgcGlkU2V0KSB7XG4gIGNvbnN0IG93blBpZCA9IHBhcnNlUGlkKGF0dHJzPy5waWQpO1xuICBpZiAob3duUGlkICE9PSBudWxsICYmIHBpZFNldC5oYXMob3duUGlkKSkge1xuICAgIHJldHVybiBvd25QaWQ7XG4gIH1cblxuICBjb25zdCBzdGFjayA9IFtdO1xuICB0cnkge1xuICAgIHN0YWNrLnB1c2goLi4uQXJyYXkuZnJvbShub2RlPy5jaGlsZE5vZGVzIHx8IFtdKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHdoaWxlIChzdGFjay5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgY2FuZGlkYXRlID0gc3RhY2sucG9wKCk7XG4gICAgaWYgKCFjYW5kaWRhdGUgfHwgY2FuZGlkYXRlLm5vZGVUeXBlICE9PSAxKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgY2FuZGlkYXRlQXR0cnMgPSBhdHRyc1RvT2JqZWN0KGNhbmRpZGF0ZSk7XG4gICAgY29uc3QgY2FuZGlkYXRlUGlkID0gcGFyc2VQaWQoY2FuZGlkYXRlQXR0cnMucGlkKTtcbiAgICBpZiAoY2FuZGlkYXRlUGlkICE9PSBudWxsICYmIHBpZFNldC5oYXMoY2FuZGlkYXRlUGlkKSkge1xuICAgICAgcmV0dXJuIGNhbmRpZGF0ZVBpZDtcbiAgICB9XG4gICAgdHJ5IHtcbiAgICAgIHN0YWNrLnB1c2goLi4uQXJyYXkuZnJvbShjYW5kaWRhdGUuY2hpbGROb2RlcyB8fCBbXSkpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICB9XG4gIHJldHVybiBudWxsO1xufVxuXG5mdW5jdGlvbiBleHRyYWN0V2F5bGFuZFdpbmRvd0NhbmRpZGF0ZXMgKGRlc2t0b3BYbWwsIHBpZHMpIHtcbiAgaWYgKCFgJHtkZXNrdG9wWG1sID8/ICcnfWAudHJpbSgpKSB7XG4gICAgcmV0dXJuIFtdO1xuICB9XG4gIGNvbnN0IG5vcm1hbGl6ZWRQaWRzID0gKHBpZHMgfHwgW10pXG4gICAgLm1hcCgocGlkKSA9PiBOdW1iZXIucGFyc2VJbnQoYCR7cGlkfWAsIDEwKSlcbiAgICAuZmlsdGVyKChwaWQpID0+IE51bWJlci5pc0Zpbml0ZShwaWQpKTtcbiAgaWYgKG5vcm1hbGl6ZWRQaWRzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBbXTtcbiAgfVxuICBjb25zdCBwaWRTZXQgPSBuZXcgU2V0KG5vcm1hbGl6ZWRQaWRzKTtcblxuICBjb25zdCBzZXJpYWxpemVyID0gbmV3IFhNTFNlcmlhbGl6ZXIoKTtcbiAgY29uc3QgZG9jID0gbmV3IGRvbSgpLnBhcnNlRnJvbVN0cmluZyhkZXNrdG9wWG1sKTtcbiAgbGV0IG5vZGVzID0gW107XG4gIHRyeSB7XG4gICAgbm9kZXMgPSBzZWxlY3QoZG9jLCAnLy8qJyk7XG4gIH0gY2F0Y2gge1xuICAgIG5vZGVzID0gW107XG4gIH1cblxuICBjb25zdCBhbGxDYW5kaWRhdGVzID0gW107XG4gIGNvbnN0IGV4cGxpY2l0V2luZG93cyA9IFtdO1xuICBmb3IgKGNvbnN0IG5vZGUgb2Ygbm9kZXMpIHtcbiAgICBjb25zdCBhdHRycyA9IGF0dHJzVG9PYmplY3Qobm9kZSk7XG4gICAgY29uc3Qgd2luZG93TGlrZSA9IGlzV2luZG93TGlrZU5vZGUobm9kZSwgYXR0cnMpO1xuICAgIGNvbnN0IG93blBpZCA9IHBhcnNlUGlkKGF0dHJzLnBpZCk7XG4gICAgY29uc3QgcGlkID0gb3duUGlkICE9PSBudWxsICYmIHBpZFNldC5oYXMob3duUGlkKVxuICAgICAgPyBvd25QaWRcbiAgICAgIDogKHdpbmRvd0xpa2UgPyByZXNvbHZlTm9kZVBpZChub2RlLCBhdHRycywgcGlkU2V0KSA6IG51bGwpO1xuICAgIGlmICghTnVtYmVyLmlzRmluaXRlKHBpZCkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAob3duUGlkID09PSBudWxsICYmICF3aW5kb3dMaWtlKSB7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgcmVjdCA9IHBhcnNlUmVjdChhdHRycy5yZWN0KTtcbiAgICBpZiAoIXJlY3QgfHwgcmVjdC53aWR0aCA8PSAwIHx8IHJlY3QuaGVpZ2h0IDw9IDApIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIGNvbnN0IHJhd05hbWUgPSBgJHthdHRycy5uYW1lID8/ICcnfWAudHJpbSgpO1xuICAgIGNvbnN0IGNsYXNzTmFtZSA9IGAke2F0dHJzLmNsYXNzID8/ICcnfWAudHJpbSgpO1xuICAgIGNvbnN0IGNhbmRpZGF0ZSA9IHtcbiAgICAgIHBpZCxcbiAgICAgIG5hbWU6IHJhd05hbWUgfHwgcHJpbWFyeUNsYXNzTmFtZShjbGFzc05hbWUpIHx8IGB3aW5kb3ctJHtwaWR9YCxcbiAgICAgIGNsYXNzTmFtZSxcbiAgICAgIG5vZGVUYWc6IGAke25vZGU/Lm5vZGVOYW1lID8/IG5vZGU/LnRhZ05hbWUgPz8gJyd9YC50b0xvd2VyQ2FzZSgpLFxuICAgICAgd2luZG93VHlwZTogYCR7YXR0cnNbJ3dpbmRvdy10eXBlJ10gPz8gJyd9YC50cmltKCksXG4gICAgICByZWN0LFxuICAgICAgc3RhdGVzOiBgJHthdHRycy5zdGF0ZXMgPz8gJyd9YC50b1VwcGVyQ2FzZSgpLFxuICAgICAgd2luZG93TGlrZSxcbiAgICAgIHhtbDogc2VyaWFsaXplci5zZXJpYWxpemVUb1N0cmluZyhub2RlKSxcbiAgICB9O1xuICAgIGFsbENhbmRpZGF0ZXMucHVzaChjYW5kaWRhdGUpO1xuICAgIGlmIChjYW5kaWRhdGUud2luZG93TGlrZSkge1xuICAgICAgZXhwbGljaXRXaW5kb3dzLnB1c2goY2FuZGlkYXRlKTtcbiAgICB9XG4gIH1cblxuICBjb25zdCBjaG9zZW5DYW5kaWRhdGVzID0gZXhwbGljaXRXaW5kb3dzLmxlbmd0aCA+IDAgPyBleHBsaWNpdFdpbmRvd3MgOiBhbGxDYW5kaWRhdGVzO1xuICByZXR1cm4gY2hvc2VuQ2FuZGlkYXRlcy5tYXAoKGNhbmRpZGF0ZSkgPT4gKHtcbiAgICAuLi5jYW5kaWRhdGUsXG4gICAgaWRlbnRpdHlLZXk6IGJ1aWxkV2luZG93SWRlbnRpdHkoY2FuZGlkYXRlKSxcbiAgICBzY29yZTogd2luZG93Q2FuZGlkYXRlU2NvcmUoY2FuZGlkYXRlKSxcbiAgfSkpO1xufVxuXG5mdW5jdGlvbiBuZXh0V2luZG93SGFuZGxlIChpZGVudGl0eUtleSwgdXNlZFdpZHMpIHtcbiAgY29uc3QgZGlnZXN0ID0gY3J5cHRvLmNyZWF0ZUhhc2goJ3NoYTEnKS51cGRhdGUoaWRlbnRpdHlLZXkpLmRpZ2VzdCgnaGV4Jykuc2xpY2UoMCwgOCk7XG4gIGxldCB3aWQgPSAoTnVtYmVyLnBhcnNlSW50KGRpZ2VzdCwgMTYpICUgMjAwMDAwMDAwMCkgKyAxMDAwO1xuICB3aGlsZSAodXNlZFdpZHMuaGFzKHdpZCkpIHtcbiAgICB3aWQgKz0gMTtcbiAgfVxuICB1c2VkV2lkcy5hZGQod2lkKTtcbiAgcmV0dXJuIHdpZDtcbn1cblxuZnVuY3Rpb24gbWF0ZXJpYWxpemVXYXlsYW5kV2luZG93cyAoY2FuZGlkYXRlcywgcHJldmlvdXNXaWRCeUlkZW50aXR5ID0gbmV3IE1hcCgpKSB7XG4gIGNvbnN0IGdyb3VwZWQgPSBuZXcgTWFwKCk7XG4gIGZvciAoY29uc3QgY2FuZGlkYXRlIG9mIGNhbmRpZGF0ZXMpIHtcbiAgICBjb25zdCBleGlzdGluZyA9IGdyb3VwZWQuZ2V0KGNhbmRpZGF0ZS5pZGVudGl0eUtleSk7XG4gICAgaWYgKCFleGlzdGluZyB8fCBleGlzdGluZy5zY29yZSA8IGNhbmRpZGF0ZS5zY29yZSkge1xuICAgICAgZ3JvdXBlZC5zZXQoY2FuZGlkYXRlLmlkZW50aXR5S2V5LCB7XG4gICAgICAgIC4uLmNhbmRpZGF0ZSxcbiAgICAgICAgZHVwbGljYXRlQ291bnQ6IGV4aXN0aW5nPy5kdXBsaWNhdGVDb3VudCA/PyAxLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGV4aXN0aW5nLnNjb3JlID09PSBjYW5kaWRhdGUuc2NvcmUpIHtcbiAgICAgIGV4aXN0aW5nLmR1cGxpY2F0ZUNvdW50ICs9IDE7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgdXNlZFdpZHMgPSBuZXcgU2V0KCk7XG4gIGNvbnN0IGlkZW50aXR5VG9XaWQgPSBuZXcgTWFwKCk7XG4gIGNvbnN0IHdpbmRvd3MgPSBBcnJheS5mcm9tKGdyb3VwZWQudmFsdWVzKCkpXG4gICAgLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiAoXG4gICAgICByaWdodC5zY29yZSAtIGxlZnQuc2NvcmVcbiAgICAgIHx8IGxlZnQuaWRlbnRpdHlLZXkubG9jYWxlQ29tcGFyZShyaWdodC5pZGVudGl0eUtleSlcbiAgICApKVxuICAgIC5tYXAoKHdpbmRvdykgPT4ge1xuICAgICAgY29uc3QgcHJldmlvdXNXaWQgPSBwcmV2aW91c1dpZEJ5SWRlbnRpdHkuZ2V0KHdpbmRvdy5pZGVudGl0eUtleSk7XG4gICAgICBjb25zdCB3aWQgPSBwcmV2aW91c1dpZCAmJiAhdXNlZFdpZHMuaGFzKHByZXZpb3VzV2lkKVxuICAgICAgICA/ICh1c2VkV2lkcy5hZGQocHJldmlvdXNXaWQpLCBwcmV2aW91c1dpZClcbiAgICAgICAgOiBuZXh0V2luZG93SGFuZGxlKHdpbmRvdy5pZGVudGl0eUtleSwgdXNlZFdpZHMpO1xuICAgICAgaWRlbnRpdHlUb1dpZC5zZXQod2luZG93LmlkZW50aXR5S2V5LCB3aWQpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgLi4ud2luZG93LFxuICAgICAgICBpbnB1dE91dHB1dDogJ3RydWUnLFxuICAgICAgICB3aWQsXG4gICAgICB9O1xuICAgIH0pXG4gICAgLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiBsZWZ0LndpZCAtIHJpZ2h0LndpZCk7XG5cbiAgcmV0dXJuIHtcbiAgICB3aW5kb3dzLFxuICAgIGlkZW50aXR5VG9XaWQsXG4gIH07XG59XG5cbmZ1bmN0aW9uIHNjb3BlZFdpbmRvd1Jlc29sdXRpb25TY29yZSAoY2FuZGlkYXRlLCB0YXJnZXRXaW5kb3cpIHtcbiAgaWYgKCFjYW5kaWRhdGUgfHwgIXRhcmdldFdpbmRvdykge1xuICAgIHJldHVybiBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFk7XG4gIH1cbiAgaWYgKE51bWJlci5wYXJzZUludChgJHtjYW5kaWRhdGUucGlkID8/ICcnfWAsIDEwKSAhPT0gTnVtYmVyLnBhcnNlSW50KGAke3RhcmdldFdpbmRvdy5waWQgPz8gJyd9YCwgMTApKSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuXG4gIGxldCBzY29yZSA9IDA7XG4gIGlmIChjYW5kaWRhdGUuaWRlbnRpdHlLZXkgJiYgY2FuZGlkYXRlLmlkZW50aXR5S2V5ID09PSB0YXJnZXRXaW5kb3cuaWRlbnRpdHlLZXkpIHtcbiAgICBzY29yZSArPSAxMDAwO1xuICB9XG5cbiAgY29uc3QgY2FuZGlkYXRlTmFtZSA9IG5vcm1hbGl6ZVRleHQoY2FuZGlkYXRlLm5hbWUpO1xuICBjb25zdCB0YXJnZXROYW1lID0gbm9ybWFsaXplVGV4dCh0YXJnZXRXaW5kb3cubmFtZSk7XG4gIGlmIChjYW5kaWRhdGVOYW1lICYmIHRhcmdldE5hbWUgJiYgY2FuZGlkYXRlTmFtZSA9PT0gdGFyZ2V0TmFtZSkge1xuICAgIHNjb3JlICs9IDI1MDtcbiAgfVxuXG4gIGNvbnN0IGNhbmRpZGF0ZUNsYXNzID0gcHJpbWFyeUNsYXNzTmFtZShjYW5kaWRhdGUuY2xhc3NOYW1lKTtcbiAgY29uc3QgdGFyZ2V0Q2xhc3MgPSBwcmltYXJ5Q2xhc3NOYW1lKHRhcmdldFdpbmRvdy5jbGFzc05hbWUpO1xuICBpZiAoY2FuZGlkYXRlQ2xhc3MgJiYgdGFyZ2V0Q2xhc3MgJiYgY2FuZGlkYXRlQ2xhc3MgPT09IHRhcmdldENsYXNzKSB7XG4gICAgc2NvcmUgKz0gOTA7XG4gIH1cblxuICBpZiAobm9ybWFsaXplVGV4dChjYW5kaWRhdGUubm9kZVRhZykgJiYgbm9ybWFsaXplVGV4dChjYW5kaWRhdGUubm9kZVRhZykgPT09IG5vcm1hbGl6ZVRleHQodGFyZ2V0V2luZG93Lm5vZGVUYWcpKSB7XG4gICAgc2NvcmUgKz0gNzA7XG4gIH1cbiAgaWYgKG5vcm1hbGl6ZVRleHQoY2FuZGlkYXRlLndpbmRvd1R5cGUpICYmIG5vcm1hbGl6ZVRleHQoY2FuZGlkYXRlLndpbmRvd1R5cGUpID09PSBub3JtYWxpemVUZXh0KHRhcmdldFdpbmRvdy53aW5kb3dUeXBlKSkge1xuICAgIHNjb3JlICs9IDYwO1xuICB9XG5cbiAgY29uc3QgY2FuZGlkYXRlUmVjdCA9IGNhbmRpZGF0ZS5yZWN0O1xuICBjb25zdCB0YXJnZXRSZWN0ID0gdGFyZ2V0V2luZG93LnJlY3Q7XG4gIGlmIChjYW5kaWRhdGVSZWN0ICYmIHRhcmdldFJlY3QpIHtcbiAgICBpZiAoY2FuZGlkYXRlUmVjdC53aWR0aCA9PT0gdGFyZ2V0UmVjdC53aWR0aCAmJiBjYW5kaWRhdGVSZWN0LmhlaWdodCA9PT0gdGFyZ2V0UmVjdC5oZWlnaHQpIHtcbiAgICAgIHNjb3JlICs9IDgwO1xuICAgIH1cbiAgICBpZiAoY2FuZGlkYXRlUmVjdC54ID09PSB0YXJnZXRSZWN0LnggJiYgY2FuZGlkYXRlUmVjdC55ID09PSB0YXJnZXRSZWN0LnkpIHtcbiAgICAgIHNjb3JlICs9IDQwO1xuICAgIH1cbiAgICBjb25zdCBvdmVybGFwQXJlYSA9IHJlY3RPdmVybGFwQXJlYShjYW5kaWRhdGVSZWN0LCB0YXJnZXRSZWN0KTtcbiAgICBpZiAob3ZlcmxhcEFyZWEgPiAwKSB7XG4gICAgICBzY29yZSArPSBNYXRoLnJvdW5kKChvdmVybGFwQXJlYSAvIE1hdGgubWF4KHJlY3RBcmVhKHRhcmdldFJlY3QpLCAxKSkgKiAxMDApO1xuICAgIH1cbiAgICBjb25zdCBjZW50ZXJEaXN0YW5jZSA9IHJlY3RDZW50ZXJEaXN0YW5jZShjYW5kaWRhdGVSZWN0LCB0YXJnZXRSZWN0KTtcbiAgICBpZiAoTnVtYmVyLmlzRmluaXRlKGNlbnRlckRpc3RhbmNlKSkge1xuICAgICAgc2NvcmUgKz0gTWF0aC5tYXgoMCwgMzAgLSBNYXRoLm1pbihjZW50ZXJEaXN0YW5jZSwgMzAwKSAvIDEwKTtcbiAgICB9XG4gIH1cblxuICBpZiAoY2FuZGlkYXRlLndpbmRvd0xpa2UpIHtcbiAgICBzY29yZSArPSA0MDtcbiAgfVxuICBpZiAoYCR7Y2FuZGlkYXRlLnN0YXRlcyA/PyAnJ31gLmluY2x1ZGVzKCdBQ1RJVkUnKSkge1xuICAgIHNjb3JlICs9IDMwO1xuICB9XG4gIGlmIChgJHtjYW5kaWRhdGUuc3RhdGVzID8/ICcnfWAuaW5jbHVkZXMoJ1NIT1dJTkcnKSB8fCBgJHtjYW5kaWRhdGUuc3RhdGVzID8/ICcnfWAuaW5jbHVkZXMoJ1ZJU0lCTEUnKSkge1xuICAgIHNjb3JlICs9IDI1O1xuICB9XG4gIGlmIChgJHtjYW5kaWRhdGUuc3RhdGVzID8/ICcnfWAuaW5jbHVkZXMoJ0VOQUJMRUQnKSB8fCBgJHtjYW5kaWRhdGUuc3RhdGVzID8/ICcnfWAuaW5jbHVkZXMoJ1NFTlNJVElWRScpKSB7XG4gICAgc2NvcmUgKz0gMTA7XG4gIH1cbiAgcmV0dXJuIHNjb3JlO1xufVxuXG5mdW5jdGlvbiB0cmFuc2llbnRPdmVybGF5UmVzb2x1dGlvblNjb3JlIChjYW5kaWRhdGUsIHRhcmdldFdpbmRvdykge1xuICBpZiAoIWNhbmRpZGF0ZSB8fCAhdGFyZ2V0V2luZG93IHx8ICFpc1RyYW5zaWVudFdpbmRvd0NhbmRpZGF0ZShjYW5kaWRhdGUpKSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuICBpZiAoTnVtYmVyLnBhcnNlSW50KGAke2NhbmRpZGF0ZS5waWQgPz8gJyd9YCwgMTApICE9PSBOdW1iZXIucGFyc2VJbnQoYCR7dGFyZ2V0V2luZG93LnBpZCA/PyAnJ31gLCAxMCkpIHtcbiAgICByZXR1cm4gTnVtYmVyLk5FR0FUSVZFX0lORklOSVRZO1xuICB9XG4gIGlmIChjYW5kaWRhdGUuaWRlbnRpdHlLZXkgJiYgdGFyZ2V0V2luZG93LmlkZW50aXR5S2V5ICYmIGNhbmRpZGF0ZS5pZGVudGl0eUtleSA9PT0gdGFyZ2V0V2luZG93LmlkZW50aXR5S2V5KSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuXG4gIGNvbnN0IGNhbmRpZGF0ZVJlY3QgPSBjYW5kaWRhdGUucmVjdDtcbiAgY29uc3QgdGFyZ2V0UmVjdCA9IHRhcmdldFdpbmRvdy5yZWN0O1xuICBjb25zdCBvdmVybGFwQXJlYSA9IHJlY3RPdmVybGFwQXJlYShjYW5kaWRhdGVSZWN0LCB0YXJnZXRSZWN0KTtcbiAgY29uc3QgY2FuZGlkYXRlQXJlYSA9IHJlY3RBcmVhKGNhbmRpZGF0ZVJlY3QpO1xuICBjb25zdCB0YXJnZXRBcmVhID0gcmVjdEFyZWEodGFyZ2V0UmVjdCk7XG4gIGlmICghY2FuZGlkYXRlQXJlYSB8fCAhdGFyZ2V0QXJlYSB8fCBvdmVybGFwQXJlYSA8PSAwKSB7XG4gICAgcmV0dXJuIE51bWJlci5ORUdBVElWRV9JTkZJTklUWTtcbiAgfVxuXG4gIGNvbnN0IG92ZXJsYXBSYXRpbyA9IG92ZXJsYXBBcmVhIC8gTWF0aC5tYXgoY2FuZGlkYXRlQXJlYSwgMSk7XG4gIGNvbnN0IGNvdmVyYWdlUmF0aW8gPSBvdmVybGFwQXJlYSAvIE1hdGgubWF4KHRhcmdldEFyZWEsIDEpO1xuICBpZiAob3ZlcmxhcFJhdGlvIDwgMC41ICYmIGNvdmVyYWdlUmF0aW8gPCAwLjEpIHtcbiAgICByZXR1cm4gTnVtYmVyLk5FR0FUSVZFX0lORklOSVRZO1xuICB9XG5cbiAgbGV0IHNjb3JlID0gdHJhbnNpZW50V2luZG93Qm9udXMoY2FuZGlkYXRlKTtcbiAgY29uc3Qgc3RhdGVzID0gYCR7Y2FuZGlkYXRlLnN0YXRlcyA/PyAnJ31gLnRvVXBwZXJDYXNlKCk7XG4gIGlmIChzdGF0ZXMuaW5jbHVkZXMoJ01PREFMJykpIHtcbiAgICBzY29yZSArPSAxNTA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnQUNUSVZFJykpIHtcbiAgICBzY29yZSArPSAxMjA7XG4gIH1cbiAgaWYgKHN0YXRlcy5pbmNsdWRlcygnU0hPV0lORycpIHx8IHN0YXRlcy5pbmNsdWRlcygnVklTSUJMRScpKSB7XG4gICAgc2NvcmUgKz0gODA7XG4gIH1cbiAgaWYgKGNhbmRpZGF0ZUFyZWEgPD0gdGFyZ2V0QXJlYSkge1xuICAgIHNjb3JlICs9IDQwO1xuICB9XG4gIHNjb3JlICs9IE1hdGgucm91bmQob3ZlcmxhcFJhdGlvICogMTAwKTtcbiAgc2NvcmUgKz0gTWF0aC5yb3VuZChjb3ZlcmFnZVJhdGlvICogMTAwKTtcbiAgY29uc3QgY2VudGVyRGlzdGFuY2UgPSByZWN0Q2VudGVyRGlzdGFuY2UoY2FuZGlkYXRlUmVjdCwgdGFyZ2V0UmVjdCk7XG4gIGlmIChOdW1iZXIuaXNGaW5pdGUoY2VudGVyRGlzdGFuY2UpKSB7XG4gICAgc2NvcmUgKz0gTWF0aC5tYXgoMCwgNDAgLSBNYXRoLm1pbihjZW50ZXJEaXN0YW5jZSwgNDAwKSAvIDEwKTtcbiAgfVxuICByZXR1cm4gc2NvcmU7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVXYXlsYW5kVHJhbnNpZW50T3ZlcmxheUNhbmRpZGF0ZSAoY2FuZGlkYXRlcywgdGFyZ2V0V2luZG93KSB7XG4gIGlmICghdGFyZ2V0V2luZG93IHx8IGlzVHJhbnNpZW50V2luZG93Q2FuZGlkYXRlKHRhcmdldFdpbmRvdykpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuICBjb25zdCBzY29yZWQgPSBjYW5kaWRhdGVzXG4gICAgLm1hcCgoY2FuZGlkYXRlKSA9PiAoe1xuICAgICAgY2FuZGlkYXRlLFxuICAgICAgc2NvcmU6IHRyYW5zaWVudE92ZXJsYXlSZXNvbHV0aW9uU2NvcmUoY2FuZGlkYXRlLCB0YXJnZXRXaW5kb3cpLFxuICAgIH0pKVxuICAgIC5maWx0ZXIoKGl0ZW0pID0+IE51bWJlci5pc0Zpbml0ZShpdGVtLnNjb3JlKSAmJiBpdGVtLnNjb3JlID4gMClcbiAgICAuc29ydCgobGVmdCwgcmlnaHQpID0+IHJpZ2h0LnNjb3JlIC0gbGVmdC5zY29yZSk7XG4gIGlmIChzY29yZWQubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgaWYgKHNjb3JlZC5sZW5ndGggPiAxICYmIHNjb3JlZFswXS5zY29yZSA9PT0gc2NvcmVkWzFdLnNjb3JlKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgcmV0dXJuIHNjb3JlZFswXS5jYW5kaWRhdGU7XG59XG5cbmZ1bmN0aW9uIHJlc29sdmVXYXlsYW5kU2NvcGVkV2luZG93WG1sIChkZXNrdG9wWG1sLCBwaWRzLCB0YXJnZXRXaW5kb3csIG9wdGlvbnMgPSB7fSkge1xuICBjb25zdCB7YWxsb3dUcmFuc2llbnRPdmVybGF5ID0gZmFsc2V9ID0gb3B0aW9ucztcbiAgY29uc3QgY2FuZGlkYXRlcyA9IGV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyhkZXNrdG9wWG1sLCBwaWRzKTtcbiAgaWYgKGFsbG93VHJhbnNpZW50T3ZlcmxheSkge1xuICAgIGNvbnN0IHRyYW5zaWVudE92ZXJsYXkgPSByZXNvbHZlV2F5bGFuZFRyYW5zaWVudE92ZXJsYXlDYW5kaWRhdGUoY2FuZGlkYXRlcywgdGFyZ2V0V2luZG93KTtcbiAgICBpZiAodHJhbnNpZW50T3ZlcmxheT8ueG1sKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICB4bWw6IHRyYW5zaWVudE92ZXJsYXkueG1sLFxuICAgICAgICByZWFzb246ICdvaycsXG4gICAgICAgIGNhbmRpZGF0ZTogdHJhbnNpZW50T3ZlcmxheSxcbiAgICAgICAgcmVkaXJlY3RlZFRvVHJhbnNpZW50T3ZlcmxheTogdHJ1ZSxcbiAgICAgIH07XG4gICAgfVxuICB9XG4gIGNvbnN0IHNjb3JlZCA9IGNhbmRpZGF0ZXNcbiAgICAubWFwKChjYW5kaWRhdGUpID0+ICh7XG4gICAgICBjYW5kaWRhdGUsXG4gICAgICBzY29yZTogc2NvcGVkV2luZG93UmVzb2x1dGlvblNjb3JlKGNhbmRpZGF0ZSwgdGFyZ2V0V2luZG93KSxcbiAgICB9KSlcbiAgICAuZmlsdGVyKChpdGVtKSA9PiBOdW1iZXIuaXNGaW5pdGUoaXRlbS5zY29yZSkgJiYgaXRlbS5zY29yZSA+IDApXG4gICAgLnNvcnQoKGxlZnQsIHJpZ2h0KSA9PiByaWdodC5zY29yZSAtIGxlZnQuc2NvcmUpO1xuXG4gIGlmIChzY29yZWQubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHhtbDogJycsXG4gICAgICByZWFzb246ICdub3RfZm91bmQnLFxuICAgIH07XG4gIH1cbiAgaWYgKHNjb3JlZC5sZW5ndGggPiAxICYmIHNjb3JlZFswXS5zY29yZSA9PT0gc2NvcmVkWzFdLnNjb3JlKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHhtbDogJycsXG4gICAgICByZWFzb246ICdhbWJpZ3VvdXMnLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICB4bWw6IHNjb3JlZFswXS5jYW5kaWRhdGUueG1sLFxuICAgIHJlYXNvbjogJ29rJyxcbiAgICBjYW5kaWRhdGU6IHNjb3JlZFswXS5jYW5kaWRhdGUsXG4gIH07XG59XG5cbmV4cG9ydCB7XG4gIGF0dHJzVG9PYmplY3QsXG4gIGJ1aWxkV2luZG93SWRlbnRpdHksXG4gIGV4dHJhY3RXYXlsYW5kV2luZG93Q2FuZGlkYXRlcyxcbiAgaXNXaW5kb3dMaWtlTm9kZSxcbiAgaXNUcmFuc2llbnRXaW5kb3dDYW5kaWRhdGUsXG4gIG1hdGVyaWFsaXplV2F5bGFuZFdpbmRvd3MsXG4gIHBhcnNlUmVjdCxcbiAgcmVzb2x2ZVdheWxhbmRTY29wZWRXaW5kb3dYbWwsXG4gIHNjb3BlZFdpbmRvd1Jlc29sdXRpb25TY29yZSxcbiAgd2luZG93Q2FuZGlkYXRlU2NvcmUsXG59O1xuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7OztBQUFBLElBQUFBLE9BQUEsR0FBQUMsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFDLE1BQUEsR0FBQUYsc0JBQUEsQ0FBQUMsT0FBQTtBQUNBLElBQUFFLE9BQUEsR0FBQUYsT0FBQTtBQUVBLFNBQVNHLFNBQVNBLENBQUVDLElBQUksRUFBRTtFQUN4QixNQUFNQyxLQUFLLEdBQUcsNERBQTRELENBQUNDLElBQUksQ0FBQyxHQUFHRixJQUFJLGFBQUpBLElBQUksY0FBSkEsSUFBSSxHQUFJLEVBQUUsRUFBRSxDQUFDO0VBQ2hHLElBQUksQ0FBQ0MsS0FBSyxFQUFFO0lBQ1YsT0FBTyxJQUFJO0VBQ2I7RUFDQSxNQUFNO0lBQUNFLENBQUM7SUFBRUMsQ0FBQztJQUFFQyxLQUFLO0lBQUVDO0VBQU0sQ0FBQyxHQUFHTCxLQUFLLENBQUNNLE1B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
