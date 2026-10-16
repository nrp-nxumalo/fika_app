const test = require('node:test');
const assert = require('node:assert/strict');
const {
  app,
  buildSitemapXml,
  cleanAreaName,
  CONTENT_SECURITY_POLICY_DIRECTIVES,
  finalizeAreas,
  formatEffectiveDate,
  getAreaNamesForRoute,
  getAreaSeo,
  getGa4MeasurementId,
  isAllowedCorsOrigin,
  getRouteSeoTitle,
  getTimetableDescription,
  getTimetableSeo,
  renderIndexHtml,
  shouldApplyCors,
} = require('../server');

test('production CORS accepts both first-party Fika hostnames', () => {
  assert.equal(isAllowedCorsOrigin('https://www.fika.net.za', { isProduction: true }), true);
  assert.equal(isAllowedCorsOrigin('https://fika.net.za', { isProduction: true }), true);
  assert.equal(isAllowedCorsOrigin('https://attacker.example', { isProduction: true }), false);
});

test('CORS does not intercept authenticated timetable review forms', () => {
  assert.equal(shouldApplyCors('/admin/timetable-reliability'), false);
  assert.equal(shouldApplyCors('/admin/timetable-reliability/sources/38/approve'), false);
  assert.equal(shouldApplyCors('/admin/timetable-reliability/versions/38/comparison'), false);
  assert.equal(shouldApplyCors('/api/reliability'), true);
  assert.equal(shouldApplyCors('/schedules'), true);
});

const route = {
  id: 300,
  agency: 'GABS',
  code: '0004',
  name: 'ATLANTIS - CAPE TOWN',
  direction_1: 'Atlantis - Cape Town',
  direction_2: 'Cape Town - Atlantis',
  effective_date: '2026-07-01',
};

test('route metadata leads with operator, code and endpoints', () => {
  const stops = [{ name: 'Atlantis' }, { name: 'Cape Town' }];
  const window = { first_time: '05:00:00', last_time: '22:30:00' };
  const seo = getTimetableSeo(route, window, stops);

  assert.equal(seo.title, 'Golden Arrow 0004 Atlantis–Cape Town Bus Times');
  assert.match(seo.description, /route 0004 from Atlantis to Cape Town/);
  assert.match(seo.description, /05:00 to 22:30/);
  assert.match(seo.description, /Effective 2026-07-01/);
  assert.match(seo.canonicalUrl, /\/timetables\/golden-arrow\/route-0004-atlantis-cape-town$/);
});

test('Mamre Crown and Frans routes aggregate into one Mamre hub', () => {
  assert.equal(cleanAreaName('Mamre (Crown)'), 'Mamre');
  assert.equal(cleanAreaName('MAMRE (FRANS)'), 'Mamre');
  assert.ok(getAreaNamesForRoute({ name: 'MAMRE (CROWN) - ATLANTIS' }).includes('Mamre'));
});

test('thin areas are noindex while demand-backed areas remain indexable', () => {
  const createAreaMap = (name) => new Map([[
    name.toLowerCase(),
    { slug: name.toLowerCase(), name, routeMap: new Map([[1, route]]) },
  ]]);
  const thinArea = finalizeAreas(createAreaMap('Unknown Terminal'))[0];
  const mamre = finalizeAreas(createAreaMap('Mamre'))[0];

  assert.equal(thinArea.indexable, false);
  assert.equal(getAreaSeo(thinArea).robots, 'noindex,follow');
  assert.equal(mamre.indexable, true);
  assert.equal(getAreaSeo(mamre).robots, 'index,follow');
});

test('effective dates serialize as sitemap-compatible dates', () => {
  assert.equal(formatEffectiveDate(new Date('2026-07-01T00:00:00Z')), '2026-07-01');
  assert.equal(formatEffectiveDate(new Date(2026, 6, 20)), '2026-07-20');
  assert.equal(formatEffectiveDate(null), '');
});

test('sitemap contains only route-code canonicals and reliable lastmod values', () => {
  const sitemap = buildSitemapXml([route], [{
    slug: 'atlantis', name: 'Atlantis', routes: [route], indexable: true,
  }, {
    slug: 'thin-stop', name: 'Thin Stop', routes: [route], indexable: false,
  }]);

  assert.match(sitemap, /\/timetables\/golden-arrow\/route-0004-atlantis-cape-town/);
  assert.doesNotMatch(sitemap, /\/timetables\/golden-arrow\/300-/);
  assert.match(sitemap, /<lastmod>2026-07-01<\/lastmod>/);
  assert.doesNotMatch(sitemap, /changefreq|priority|\/areas\/thin-stop/);
});

test('opening timetable copy includes useful route information before disclaimers', () => {
  const description = getTimetableDescription(route, null, []);
  assert.ok(description.startsWith('Golden Arrow route 0004 from Atlantis to Cape Town.'));
});

test('numeric timetable APIs remain registered for backward compatibility', () => {
  const paths = app._router.stack
    .map((layer) => layer.route?.path)
    .filter(Boolean);
  assert.ok(paths.includes('/schedule_times/:id'));
  assert.ok(paths.includes('/api/v2/schedule_times/:id'));
  assert.ok(paths.includes('/api/timetable-status'));
  assert.ok(paths.includes('/api/reliability'));
});

test('public reliability page redirects home and is absent from public navigation and sitemap', () => {
  const layer = app._router.stack.find(item => item.route?.path === '/data-reliability');
  const response = { redirect(code, location) { this.code = code; this.location = location; } };
  layer.route.stack[0].handle({}, response);
  assert.equal(response.code, 301);
  assert.equal(response.location, '/');
  assert.doesNotMatch(buildSitemapXml([route], []), /data-reliability/);
  const about = app._router.stack.find(item => item.route?.path === '/about');
  about.route.stack[0].handle({}, { send(html) { assert.doesNotMatch(html, /href="\/data-reliability"/); } });
});

test('GA4 measurement IDs are validated before runtime injection', () => {
  assert.equal(getGa4MeasurementId(' g-AbC123 '), 'G-ABC123');
  assert.equal(getGa4MeasurementId('GTM-ABC123'), '');
  assert.equal(getGa4MeasurementId('<script>'), '');
});

test('valid GA4 configuration is injected into rendered pages', () => {
  const previousMeasurementId = process.env.GA4_MEASUREMENT_ID;
  process.env.GA4_MEASUREMENT_ID = 'G-RUNTIME123';

  try {
    const html = renderIndexHtml({
      title: 'Test',
      description: 'Test page',
      canonicalUrl: 'https://www.fika.net.za/test',
      jsonLd: [],
    });
    assert.match(html, /window\.__FIKA_CONFIG__=\{"ga4MeasurementId":"G-RUNTIME123"\}/);
  } finally {
    if (previousMeasurementId === undefined) {
      delete process.env.GA4_MEASUREMENT_ID;
    } else {
      process.env.GA4_MEASUREMENT_ID = previousMeasurementId;
    }
  }
});

test('privacy policy discloses automatic GA4 behavior without presenting a consent control', () => {
  const routeLayer = app._router.stack.find((layer) => layer.route?.path === '/privacy-policy');
  const response = {
    body: '',
    send(value) { this.body = value; return this; },
  };

  routeLayer.route.stack[0].handle({}, response);

  assert.match(response.body, /first-party _ga cookie/);
  assert.match(response.body, /legitimate interest/);
  assert.match(response.body, /stores that dismissal choice in this browser/);
  assert.match(response.body, /Advertising storage, Google Signals, and ad personalization are disabled/);
  assert.doesNotMatch(response.body, /Accept analytics|Analytics settings/);
});

test('saved timetables are noindex, excluded from the sitemap, and allow GA4 CSP endpoints', () => {
  const routeLayer = app._router.stack.find((layer) => layer.route?.path === '/saved-timetables');
  const response = {
    headers: {},
    body: '',
    set(name, value) { this.headers[name] = value; return this; },
    send(value) { this.body = value; return this; },
  };
  routeLayer.route.stack[0].handle({}, response);

  const sitemap = buildSitemapXml([route], []);

  assert.equal(response.headers['X-Robots-Tag'], 'noindex, follow');
  assert.match(response.body, /Saved timetables/);
  assert.match(response.body, /name="robots" content="noindex,follow"/);
  assert.ok(CONTENT_SECURITY_POLICY_DIRECTIVES.scriptSrc.includes('https://www.googletagmanager.com'));
  assert.ok(CONTENT_SECURITY_POLICY_DIRECTIVES.connectSrc.includes('https://*.google-analytics.com'));
  assert.doesNotMatch(sitemap, /saved-timetables/);
});
