import crypto from 'crypto';
import select from 'xpath.js';
import { DOMParser as dom, XMLSerializer } from '@xmldom/xmldom';

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

function attrsToObject (node) {
  if (!node?.attributes) {
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

function includesWindowToken (value, tokens) {
  const normalized = `${value ?? ''}`.toLowerCase();
  if (!normalized) {
    return false;
  }
  return tokens.some((token) => normalized.includes(token));
}

function isWindowLikeNode (node, attrs) {
  const tag = `${node?.nodeName ?? node?.tagName ?? ''}`.toLowerCase();
  const roleName = `${attrs?.role ?? ''}`.toLowerCase();
  const xmlRoles = `${attrs?.['xml-roles'] ?? ''}`.toLowerCase();
  const windowType = `${attrs?.['window-type'] ?? ''}`.toLowerCase();
  return [tag, roleName, xmlRoles, windowType].some((value) => includesWindowToken(value, WINDOW_LIKE_TOKENS));
}

function transientWindowBonus (candidate) {
  const nodeTag = `${candidate?.nodeTag ?? ''}`.toLowerCase();
  const windowType = `${candidate?.windowType ?? ''}`.toLowerCase();
  if ([nodeTag, windowType].some((value) => includesWindowToken(value, ['alert']))) {
    return 100000000;
  }
  if ([nodeTag, windowType].some((value) => includesWindowToken(value, ['dialog', 'modal']))) {
    return 80000000;
  }
  if ([nodeTag, windowType].some((value) => includesWindowToken(value, TRANSIENT_WINDOW_TOKENS))) {
    return 60000000;
  }
  return 0;
}

function isTransientWindowCandidate (candidate) {
  const nodeTag = `${candidate?.nodeTag ?? ''}`.toLowerCase();
  const windowType = `${candidate?.windowType ?? ''}`.toLowerCase();
  const states = `${candidate?.states ?? ''}`.toUpperCase();
  return (
    [nodeTag, windowType].some((value) => includesWindowToken(value, TRANSIENT_WINDOW_TOKENS))
    || states.includes('MODAL')
  );
}

function normalizeText (value) {
  return `${value ?? ''}`.trim().toLowerCase();
}

function primaryClassName (className) {
  return `${className ?? ''}`.split(/\s+/).filter(Boolean)[0] || '';
}

function rectArea (rect) {
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return 0;
  }
  return rect.width * rect.height;
}

function rectOverlapArea (left, right) {
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

function rectCenterDistance (left, right) {
  if (!left || !right) {
    return Number.POSITIVE_INFINITY;
  }
  const leftCx = left.x + (left.width / 2);
  const leftCy = left.y + (left.height / 2);
  const rightCx = right.x + (right.width / 2);
  const rightCy = right.y + (right.height / 2);
  return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}

function buildWindowIdentity (candidate) {
  // Intentionally excludes rect dimensions: window geometry can change (resize,
  // focus, GNOME layout shift) without the window itself changing identity.
  // Including size caused the Wayland wid to change mid-session on RHEL/GNOME,
  // making previously-valid handles stale after the first click or text input.
  return [
    Number.parseInt(`${candidate?.pid ?? ''}`, 10) || 0,
    `${candidate?.nodeTag ?? ''}`.toLowerCase(),
    `${candidate?.windowType ?? ''}`.toLowerCase(),
    `${candidate?.name ?? ''}`.trim(),
    primaryClassName(candidate?.className),
  ].join('|');
}

function windowCandidateScore (candidate) {
  const states = `${candidate?.states ?? ''}`.toUpperCase();
  let score = rectArea(candidate?.rect);
  if (candidate?.windowLike) {
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

function parsePid (value) {
  const pid = Number.parseInt(`${value ?? ''}`, 10);
  return Number.isFinite(pid) ? pid : null;
}

function resolveNodePid (node, attrs, pidSet) {
  const ownPid = parsePid(attrs?.pid);
  if (ownPid !== null && pidSet.has(ownPid)) {
    return ownPid;
  }

  const stack = [];
  try {
    stack.push(...Array.from(node?.childNodes || []));
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

function extractWaylandWindowCandidates (desktopXml, pids) {
  if (!`${desktopXml ?? ''}`.trim()) {
    return [];
  }
  const normalizedPids = (pids || [])
    .map((pid) => Number.parseInt(`${pid}`, 10))
    .filter((pid) => Number.isFinite(pid));
  if (normalizedPids.length === 0) {
    return [];
  }
  const pidSet = new Set(normalizedPids);

  const serializer = new XMLSerializer();
  const doc = new dom().parseFromString(desktopXml);
  let nodes = [];
  try {
    nodes = select(doc, '//*');
  } catch {
    nodes = [];
  }

  const allCandidates = [];
  const explicitWindows = [];
  for (const node of nodes) {
    const attrs = attrsToObject(node);
    const windowLike = isWindowLikeNode(node, attrs);
    const ownPid = parsePid(attrs.pid);
    const pid = ownPid !== null && pidSet.has(ownPid)
      ? ownPid
      : (windowLike ? resolveNodePid(node, attrs, pidSet) : null);
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

    const rawName = `${attrs.name ?? ''}`.trim();
    const className = `${attrs.class ?? ''}`.trim();
    const candidate = {
      pid,
      name: rawName || primaryClassName(className) || `window-${pid}`,
      className,
      nodeTag: `${node?.nodeName ?? node?.tagName ?? ''}`.toLowerCase(),
      windowType: `${attrs['window-type'] ?? ''}`.trim(),
      rect,
      states: `${attrs.states ?? ''}`.toUpperCase(),
      windowLike,
      xml: serializer.serializeToString(node),
    };
    allCandidates.push(candidate);
    if (candidate.windowLike) {
      explicitWindows.push(candidate);
    }
  }

  const chosenCandidates = explicitWindows.length > 0 ? explicitWindows : allCandidates;
  return chosenCandidates.map((candidate) => ({
    ...candidate,
    identityKey: buildWindowIdentity(candidate),
    score: windowCandidateScore(candidate),
  }));
}

function nextWindowHandle (identityKey, usedWids) {
  const digest = crypto.createHash('sha1').update(identityKey).digest('hex').slice(0, 8);
  let wid = (Number.parseInt(digest, 16) % 2000000000) + 1000;
  while (usedWids.has(wid)) {
    wid += 1;
  }
  usedWids.add(wid);
  return wid;
}

function materializeWaylandWindows (candidates, previousWidByIdentity = new Map()) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const existing = grouped.get(candidate.identityKey);
    if (!existing || existing.score < candidate.score) {
      grouped.set(candidate.identityKey, {
        ...candidate,
        duplicateCount: existing?.duplicateCount ?? 1,
      });
      continue;
    }
    if (existing.score === candidate.score) {
      existing.duplicateCount += 1;
    }
  }

  const usedWids = new Set();
  const identityToWid = new Map();
  const windows = Array.from(grouped.values())
    .sort((left, right) => (
      right.score - left.score
      || left.identityKey.localeCompare(right.identityKey)
    ))
    .map((window) => {
      const previousWid = previousWidByIdentity.get(window.identityKey);
      const wid = previousWid && !usedWids.has(previousWid)
        ? (usedWids.add(previousWid), previousWid)
        : nextWindowHandle(window.identityKey, usedWids);
      identityToWid.set(window.identityKey, wid);
      return {
        ...window,
        inputOutput: 'true',
        wid,
      };
    })
    .sort((left, right) => left.wid - right.wid);

  return {
    windows,
    identityToWid,
  };
}

function scopedWindowResolutionScore (candidate, targetWindow) {
  if (!candidate || !targetWindow) {
    return Number.NEGATIVE_INFINITY;
  }
  if (Number.parseInt(`${candidate.pid ?? ''}`, 10) !== Number.parseInt(`${targetWindow.pid ?? ''}`, 10)) {
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
      score += Math.round((overlapArea / Math.max(rectArea(targetRect), 1)) * 100);
    }
    const centerDistance = rectCenterDistance(candidateRect, targetRect);
    if (Number.isFinite(centerDistance)) {
      score += Math.max(0, 30 - Math.min(centerDistance, 300) / 10);
    }
  }

  if (candidate.windowLike) {
    score += 40;
  }
  if (`${candidate.states ?? ''}`.includes('ACTIVE')) {
    score += 30;
  }
  if (`${candidate.states ?? ''}`.includes('SHOWING') || `${candidate.states ?? ''}`.includes('VISIBLE')) {
    score += 25;
  }
  if (`${candidate.states ?? ''}`.includes('ENABLED') || `${candidate.states ?? ''}`.includes('SENSITIVE')) {
    score += 10;
  }
  return score;
}

function transientOverlayResolutionScore (candidate, targetWindow) {
  if (!candidate || !targetWindow || !isTransientWindowCandidate(candidate)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (Number.parseInt(`${candidate.pid ?? ''}`, 10) !== Number.parseInt(`${targetWindow.pid ?? ''}`, 10)) {
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
  const states = `${candidate.states ?? ''}`.toUpperCase();
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

function resolveWaylandTransientOverlayCandidate (candidates, targetWindow) {
  if (!targetWindow || isTransientWindowCandidate(targetWindow)) {
    return null;
  }
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: transientOverlayResolutionScore(candidate, targetWindow),
    }))
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((left, right) => right.score - left.score);
  if (scored.length === 0) {
    return null;
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return null;
  }
  return scored[0].candidate;
}

function resolveWaylandScopedWindowXml (desktopXml, pids, targetWindow, options = {}) {
  const {allowTransientOverlay = false} = options;
  const candidates = extractWaylandWindowCandidates(desktopXml, pids);
  if (allowTransientOverlay) {
    const transientOverlay = resolveWaylandTransientOverlayCandidate(candidates, targetWindow);
    if (transientOverlay?.xml) {
      return {
        xml: transientOverlay.xml,
        reason: 'ok',
        candidate: transientOverlay,
        redirectedToTransientOverlay: true,
      };
    }
  }
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scopedWindowResolutionScore(candidate, targetWindow),
    }))
    .filter((item) => Number.isFinite(item.score) && item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      xml: '',
      reason: 'not_found',
    };
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    return {
      xml: '',
      reason: 'ambiguous',
    };
  }
  return {
    xml: scored[0].candidate.xml,
    reason: 'ok',
    candidate: scored[0].candidate,
  };
}

export {
  attrsToObject,
  buildWindowIdentity,
  extractWaylandWindowCandidates,
  isWindowLikeNode,
  isTransientWindowCandidate,
  materializeWaylandWindows,
  parseRect,
  resolveWaylandScopedWindowXml,
  scopedWindowResolutionScore,
  windowCandidateScore,
};
