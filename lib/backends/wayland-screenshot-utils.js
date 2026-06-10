function getWaylandScreenshotStrategies ({portalAvailable, hasGnomeScreenshot, hasGrim}) {
  const strategies = [];
  if (hasGnomeScreenshot) {
    strategies.push('gnome-screenshot');
  }
  if (portalAvailable) {
    strategies.push('portal');
  }
  if (hasGrim) {
    strategies.push('grim');
  }
  return strategies;
}

function getWaylandScreenshotFailureMessage ({portalAvailable, hasGnomeScreenshot, hasGrim}) {
  const strategies = getWaylandScreenshotStrategies({portalAvailable, hasGnomeScreenshot, hasGrim});
  if (strategies.length > 0) {
    return null;
  }
  return 'Wayland screenshot interfaces are unavailable (portal/gnome-screenshot/grim). Screenshot commands may fail.';
}

export {
  getWaylandScreenshotStrategies,
  getWaylandScreenshotFailureMessage,
};
