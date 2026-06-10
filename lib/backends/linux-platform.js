import fs from 'fs';

const SUPPORTED_RHEL_MAJORS = Object.freeze([8, 9, 10]);
const RHEL_FAMILY_IDS = new Set(['rhel', 'redhat', 'redhatenterpriseserver', 'centos', 'rocky', 'almalinux', 'ol', 'oracle', 'fedora']);

const SUPPORTED_UBUNTU_MAJORS = Object.freeze([20, 22, 24, 26]);
const UBUNTU_FAMILY_IDS = new Set(['ubuntu', 'linuxmint', 'pop', 'elementary']);

function stripQuotes (value) {
  const text = `${value ?? ''}`.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1);
  }
  return text;
}

function parseOsRelease (text) {
  const rows = {};
  for (const line of `${text ?? ''}`.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1));
    rows[key] = value;
  }
  return rows;
}

function readOsReleaseFile (filePath = '/etc/os-release') {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function splitLikeValues (rawValue) {
  const values = `${rawValue ?? ''}`
    .split(/\s+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(values));
}

function detectLinuxDistroInfo ({
  platform = process.platform,
  env = process.env,
  osReleaseText = null,
  osReleasePath = '/etc/os-release',
} = {}) {
  const isLinux = platform === 'linux';
  if (!isLinux) {
    return {
      platform,
      isLinux,
      id: null,
      idLike: [],
      versionId: null,
      majorVersion: null,
      prettyName: null,
      isRhelLike: false,
      isSupportedRhelMajor: false,
      isUbuntu: false,
      isSupportedUbuntuMajor: false,
      sessionType: `${env?.XDG_SESSION_TYPE ?? ''}`.trim().toLowerCase(),
      hasWaylandDisplay: Boolean(env?.WAYLAND_DISPLAY),
    };
  }

  const text = osReleaseText === null ? readOsReleaseFile(osReleasePath) : `${osReleaseText}`;
  const rows = parseOsRelease(text);
  const id = `${rows.ID ?? ''}`.trim().toLowerCase() || null;
  const idLike = splitLikeValues(rows.ID_LIKE || '');
  const versionId = `${rows.VERSION_ID ?? ''}`.trim() || null;
  const majorValue = versionId ? Number.parseInt(versionId.split('.')[0], 10) : NaN;
  const majorVersion = Number.isFinite(majorValue) ? majorValue : null;
  const isRhelLike = Boolean(id && RHEL_FAMILY_IDS.has(id)) || idLike.some((name) => RHEL_FAMILY_IDS.has(name));
  const isUbuntu = Boolean(id && UBUNTU_FAMILY_IDS.has(id)) || idLike.some((name) => UBUNTU_FAMILY_IDS.has(name));

  return {
    platform,
    isLinux,
    id,
    idLike,
    versionId,
    majorVersion,
    prettyName: `${rows.PRETTY_NAME ?? ''}`.trim() || null,
    isRhelLike,
    isSupportedRhelMajor: Boolean(isRhelLike && majorVersion && SUPPORTED_RHEL_MAJORS.includes(majorVersion)),
    isUbuntu,
    isSupportedUbuntuMajor: Boolean(isUbuntu && majorVersion && SUPPORTED_UBUNTU_MAJORS.includes(majorVersion)),
    sessionType: `${env?.XDG_SESSION_TYPE ?? ''}`.trim().toLowerCase(),
    hasWaylandDisplay: Boolean(env?.WAYLAND_DISPLAY),
  };
}

function formatDistroLabel (distroInfo = {}) {
  const pretty = `${distroInfo.prettyName ?? ''}`.trim();
  if (pretty) {
    return pretty;
  }
  const id = `${distroInfo.id ?? ''}`.trim();
  const versionId = `${distroInfo.versionId ?? ''}`.trim();
  if (id && versionId) {
    return `${id} ${versionId}`;
  }
  if (id) {
    return id;
  }
  return 'unknown Linux distribution';
}

function hintForMissingDependency ({command, distroInfo}) {
  const isRhel = Boolean(distroInfo?.isRhelLike);
  const isUbuntu = Boolean(distroInfo?.isUbuntu);
  const rhelPkgHint = {
    'xdg-desktop-portal': 'xdg-desktop-portal xdg-desktop-portal-gnome',
    'pipewire': 'pipewire pipewire-utils',
    'wl-copy': 'wl-clipboard',
    'wl-paste': 'wl-clipboard',
    'gnome-screenshot': 'gnome-screenshot',
    'python3': 'python3',
    'python3-pyatspi': 'python3-atspi',
  };
  const ubuntuPkgHint = {
    'xdg-desktop-portal': 'xdg-desktop-portal xdg-desktop-portal-gnome',
    'pipewire': 'pipewire',
    'wl-copy': 'wl-clipboard',
    'wl-paste': 'wl-clipboard',
    'gnome-screenshot': 'gnome-screenshot',
    'python3': 'python3',
    'python3-pyatspi': 'python3-pyatspi',
  };
  const packages = isRhel ? rhelPkgHint[command] : (isUbuntu ? ubuntuPkgHint[command] : null);
  if (!packages) {
    return '';
  }
  if (isRhel) {
    return ` Install using: sudo dnf install -y ${packages}`;
  }
  if (isUbuntu) {
    return ` Install using: sudo apt-get install -y ${packages}`;
  }
  return '';
}

function evaluateWaylandPreflight ({
  env = process.env,
  hasCommand,
  distroInfo = detectLinuxDistroInfo({env}),
  autoShareEnabled = true,
} = {}) {
  if (typeof hasCommand !== 'function') {
    throw new Error('evaluateWaylandPreflight requires hasCommand(command) callback');
  }

  const errors = [];
  const warnings = [];

  if (!distroInfo.isLinux) {
    errors.push(`Wayland backend requires Linux runtime, but current platform is '${distroInfo.platform}'.`);
    return {errors, warnings};
  }

  const hasWaylandSession = distroInfo.sessionType === 'wayland' || distroInfo.hasWaylandDisplay;
  if (!hasWaylandSession) {
    errors.push('Wayland backend requested, but this process is not in a Wayland session. Set appium:linuxBackend to x11 or run under Wayland.');
  }

  if (!env?.DBUS_SESSION_BUS_ADDRESS) {
    errors.push('Wayland backend requires DBUS_SESSION_BUS_ADDRESS from an active desktop session.');
  }
  if (!env?.XDG_RUNTIME_DIR) {
    errors.push('Wayland backend requires XDG_RUNTIME_DIR from the logged-in desktop user.');
  }

  for (const command of ['xdg-desktop-portal', 'pipewire']) {
    if (!hasCommand(command)) {
      errors.push(`Wayland prerequisite '${command}' is missing.${hintForMissingDependency({command, distroInfo})}`);
    }
  }

  if (!hasCommand('xdg-desktop-portal-gnome')) {
    warnings.push(
      `Command 'xdg-desktop-portal-gnome' is missing.${hintForMissingDependency({command: 'xdg-desktop-portal', distroInfo})}` +
      ' GNOME-specific portal integration may fail.'
    );
  }

  if (autoShareEnabled) {
    if (!hasCommand('python3')) {
      warnings.push(`Wayland auto-share is enabled but 'python3' is missing.${hintForMissingDependency({command: 'python3', distroInfo})}`);
    } else if (!hasCommand('python3-pyatspi')) {
      warnings.push(
        `Wayland auto-share uses pyatspi and it was not detected.${hintForMissingDependency({command: 'python3-pyatspi', distroInfo})}` +
        ' Consent dialogs may require manual interaction.'
      );
    }
  }

  if (distroInfo.isRhelLike && !distroInfo.isSupportedRhelMajor) {
    warnings.push(
      `Detected ${formatDistroLabel(distroInfo)}. Supported RHEL majors are ${SUPPORTED_RHEL_MAJORS.join(', ')} (GNOME, x86_64).`
    );
  }

  if (distroInfo.isUbuntu && !distroInfo.isSupportedUbuntuMajor) {
    warnings.push(
      `Detected ${formatDistroLabel(distroInfo)}. Supported Ubuntu majors are ${SUPPORTED_UBUNTU_MAJORS.join(', ')} (GNOME, Wayland).`
    );
  }

  return {errors, warnings};
}

export {
  SUPPORTED_RHEL_MAJORS,
  SUPPORTED_UBUNTU_MAJORS,
  parseOsRelease,
  detectLinuxDistroInfo,
  formatDistroLabel,
  evaluateWaylandPreflight,
};
