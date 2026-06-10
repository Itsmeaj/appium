const DEVICE_TYPE_KEYBOARD = 1;
const DEVICE_TYPE_POINTER = 2;
const DEVICE_TYPE_TOUCHSCREEN = 4;

function parseWaylandGrantedDevices (rawDevices) {
  const grantedDevices = Number.parseInt(`${rawDevices ?? ''}`, 10);
  if (!Number.isFinite(grantedDevices) || grantedDevices < 0) {
    return {
      grantedDevices: null,
      keyboardAllowed: null,
      pointerAllowed: null,
      touchAllowed: null,
    };
  }
  return {
    grantedDevices,
    keyboardAllowed: (grantedDevices & DEVICE_TYPE_KEYBOARD) !== 0,
    pointerAllowed: (grantedDevices & DEVICE_TYPE_POINTER) !== 0,
    touchAllowed: (grantedDevices & DEVICE_TYPE_TOUCHSCREEN) !== 0,
  };
}

function pointerPermissionErrorMessage (grantInfo = {}) {
  if (grantInfo.pointerAllowed === true) {
    return '';
  }
  const details = Number.isFinite(grantInfo.grantedDevices)
    ? `granted devices=${grantInfo.grantedDevices}`
    : 'portal Start did not report granted devices';
  return (
    'Wayland portal session did not grant POINTER permission. ' +
    'Re-run and ensure remote control/pointer access is granted in the share dialog. ' +
    `(${details})`
  );
}

function ensureWaylandPointerPermission (grantInfo = {}) {
  const message = pointerPermissionErrorMessage(grantInfo);
  if (message) {
    throw new Error(message);
  }
}

export {
  DEVICE_TYPE_KEYBOARD,
  DEVICE_TYPE_POINTER,
  DEVICE_TYPE_TOUCHSCREEN,
  ensureWaylandPointerPermission,
  parseWaylandGrantedDevices,
  pointerPermissionErrorMessage,
};
