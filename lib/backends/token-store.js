import fs from 'fs';
import os from 'os';
import path from 'path';

const DEFAULT_TOKEN_STORE_PATH = path.join(os.homedir(), '.config', 'appium-linux-driver', 'portal-restore-tokens.json');

function normalizeStorePath (inputPath) {
  if (!inputPath) {
    return DEFAULT_TOKEN_STORE_PATH;
  }
  if (inputPath.startsWith('~')) {
    return path.join(os.homedir(), inputPath.slice(1));
  }
  return inputPath;
}

function ensureParentDir (filePath) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
}

function loadTokenStore (inputPath) {
  const storePath = normalizeStorePath(inputPath);
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {storePath, data: {version: 1, wayland: {}}};
    }
    if (!parsed.wayland || typeof parsed.wayland !== 'object') {
      parsed.wayland = {};
    }
    if (!parsed.version) {
      parsed.version = 1;
    }
    return {storePath, data: parsed};
  } catch {
    return {storePath, data: {version: 1, wayland: {}}};
  }
}

function saveTokenStore (inputPath, data) {
  const storePath = normalizeStorePath(inputPath);
  ensureParentDir(storePath);
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), {mode: 0o600});
  fs.chmodSync(storePath, 0o600);
  return storePath;
}

function readWaylandToken (inputPath, appName) {
  const {storePath, data} = loadTokenStore(inputPath);
  const appData = data.wayland?.[appName] || null;
  return {
    storePath,
    token: appData?.restoreToken || null,
    updatedAt: appData?.updatedAt || null,
  };
}

function writeWaylandToken (inputPath, appName, restoreToken) {
  if (!restoreToken) {
    return normalizeStorePath(inputPath);
  }
  const {storePath, data} = loadTokenStore(inputPath);
  if (!data.wayland) {
    data.wayland = {};
  }
  data.wayland[appName] = {
    restoreToken,
    updatedAt: new Date().toISOString(),
  };
  return saveTokenStore(storePath, data);
}

export {
  DEFAULT_TOKEN_STORE_PATH,
  normalizeStorePath,
  loadTokenStore,
  saveTokenStore,
  readWaylandToken,
  writeWaylandToken,
};
