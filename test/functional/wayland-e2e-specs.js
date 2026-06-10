import _ from 'lodash';
import { remote } from 'webdriverio';
import { startServer } from '../../lib/server';
import chaiAsPromised from 'chai-as-promised';
import chai from 'chai';
import { HOST, PORT, MOCHA_TIMEOUT, APP_NAME } from '../utils';

chai.should();
chai.use(chaiAsPromised);

const isWaylandSession = ((process.env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland') || !!process.env.WAYLAND_DISPLAY;
const SHOULD_RUN = process.platform === 'linux' && process.env.RUN_WAYLAND_E2E === '1' && isWaylandSession;
const maybeDescribe = SHOULD_RUN ? describe : describe.skip;

const CAPS = {
  platformName: 'linux',
  'appium:appName': APP_NAME,
  'appium:linuxBackend': 'wayland',
};

maybeDescribe('AtSpi2Driver - wayland backend', function () {
  this.timeout(MOCHA_TIMEOUT);

  let server;
  let driver;
  before(async function () {
    server = await startServer(PORT, HOST);
  });
  after(async function () {
    if (server) {
      await server.close();
      server = null;
    }
  });

  beforeEach(async function () {
    driver = await remote({
      hostname: HOST,
      port: PORT,
      capabilities: CAPS,
    });
  });

  afterEach(async function () {
    if (driver) {
      try {
        await driver.deleteSession();
      } finally {
        driver = null;
      }
    }
  });

  it('should retrieve xml source on wayland', async function () {
    const source = await driver.getPageSource();
    _.includes(source, '<?xml version="1.0" encoding="UTF-8"?>').should.be.true;
  });

  it('should list at least one window handle on wayland', async function () {
    const handles = await driver.getWindowHandles();
    handles.length.should.be.greaterThan(0);
  });

  it('should keep page source available after switching to the reported wayland handle', async function () {
    const currentHandle = await driver.getWindowHandle();
    const handles = await driver.getWindowHandles();
    handles.should.include(currentHandle);

    await driver.switchToWindow(currentHandle);
    const source = await driver.getPageSource();
    _.includes(source, '<?xml version="1.0" encoding="UTF-8"?>').should.be.true;
  });
});
