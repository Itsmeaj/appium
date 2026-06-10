// import _ from 'lodash';
import { remote } from 'webdriverio';
import { startServer } from '../../lib/server';
import chaiAsPromised from 'chai-as-promised';
import chai from 'chai';
import { HOST, PORT, MOCHA_TIMEOUT, APP_NAME } from '../utils';

chai.should();
chai.use(chaiAsPromised);

const CAPS = {
  platformName: 'linux',
  'appium:appName': APP_NAME
};
const maybeDescribe = process.platform === 'linux' ? describe : describe.skip;

maybeDescribe('AtSpi2Driver - find elements', function () {
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

  it('should find by name', async function () {
    const el = await driver.findElement('name', 'Find');
    el.should.exist;
  });

  it('should find by accessibility id', async function () {
    const el = await driver.findElement('accessibility id', 'Find');
    el.should.exist;
  });

  it('should find multiple by name', async function () {
    const els = await driver.findElements('name', 'Find');
    els.length.should.eql(1);
    await driver.getElementAttribute(els[0].ELEMENT, 'name').should.eventually.eql('Find');
  });

  it('should find by xpath', async function () {
    const el = await driver.findElement(
      'xpath',
      '//toggle-button[@name="Find"]'
    );
    el.should.exist;
  });

  it('should find by tag name', async function () {
    const els = await driver.findElements('tag name', 'toggle-button');
    els.length.should.be.greaterThan(0);
  });

  it('should find by css selector', async function () {
    const el = await driver.findElement('css selector', 'toggle-button[name="Find"]');
    el.should.exist;
  });

  it('should find by id when id is available on element', async function () {
    const byName = await driver.findElement('name', 'Find');
    const elementId = await driver.getElementAttribute(byName.ELEMENT, 'id');
    if (!elementId) {
      this.skip();
      return;
    }
    const byId = await driver.findElement('id', elementId);
    byId.should.exist;
  });

  it('should find multiple by xpath', async function () {
    const els = await driver.findElements(
      'xpath',
      '//toggle-button[@name="Find"]'
    );
    els.length.should.eql(1);
    await driver.getElementAttribute(els[0].ELEMENT, 'name').should.eventually.eql('Find');
  });

  it('should find subelements', async function () {
    const el = await driver.findElement('xpath', '//document-web');
    el.should.exist;
    const subEls = await driver.findElementsFromElement(el.ELEMENT, 'xpath', '//image[@name="Ubuntu Logo"]');
    subEls.length.should.eql(1);
    await driver.getElementAttribute(subEls[0].ELEMENT, 'tag').should.eventually.eql('img');
  });

});
