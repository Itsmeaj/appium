import chai from 'chai';
import {
  DesktopSessionCheck,
  LinuxPlatformCheck,
  NativeRuntimeCheck,
  WaylandPrerequisitesCheck,
} from '../../doctor/checks.js';

chai.should();

describe('Appium doctor checks', function () {
  it('should reject non-Linux hosts', async function () {
    const diagnosis = await new LinuxPlatformCheck({platform: 'darwin'}).diagnose();
    diagnosis.ok.should.eql(false);
    diagnosis.optional.should.eql(false);
    diagnosis.message.should.contain('requires Linux');
  });

  it('should require the native AT-SPI runtime', async function () {
    const diagnosis = await new NativeRuntimeCheck({
      runtimePath: '/missing/libstdspalinux.so',
      existsSync: () => false,
    }).diagnose();
    diagnosis.ok.should.eql(false);
    diagnosis.message.should.contain('native AT-SPI runtime is missing');
  });

  it('should accept either an X11 or Wayland display', async function () {
    const diagnosis = await new DesktopSessionCheck({
      env: {DISPLAY: ':0', XDG_SESSION_TYPE: 'x11'},
    }).diagnose();
    diagnosis.ok.should.eql(true);
  });

  it('should report missing Wayland session prerequisites', async function () {
    const diagnosis = await new WaylandPrerequisitesCheck({
      env: {PATH: '', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0'},
      commandFinder: () => null,
    }).diagnose();
    diagnosis.ok.should.eql(false);
    diagnosis.message.should.contain('DBUS_SESSION_BUS_ADDRESS');
    diagnosis.message.should.contain('xdg-desktop-portal');
  });
});
