const desiredCapConstraints = {
  appName: {
    isString: true
  },
  appArguments: {
    isArray: true
  },
  attachToRunningApp: {
    isBoolean: true
  },
  linuxBackend: {
    isString: true,
    inclusionCaseInsensitive: ['auto', 'x11', 'wayland']
  },
  waylandRestoreToken: {
    isString: true
  },
  waylandTokenStorePath: {
    isString: true
  },
  waylandAutoShare: {
    isBoolean: true
  }
};

export { desiredCapConstraints };
