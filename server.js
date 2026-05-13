const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 4000;
const PRODUCTION_SITE_URL = 'https://www.fika.net.za';
const DEFAULT_SITE_URL = IS_PRODUCTION ? PRODUCTION_SITE_URL : `http://localhost:${PORT}`;
const SITE_URL = (IS_PRODUCTION
  ? process.env.CANONICAL_SITE_URL || PRODUCTION_SITE_URL
  : process.env.SITE_URL || DEFAULT_SITE_URL
).replace(/\/$/, '');
const ADSENSE_PUBLISHER_ID = process.env.ADSENSE_PUBLISHER_ID || '';
const CLIENT_BUILD_DIR = path.join(__dirname, 'client', 'build');
const CLIENT_PUBLIC_DIR = path.join(__dirname, 'client', 'public');
const INDEX_HTML_PATH = path.join(CLIENT_BUILD_DIR, 'index.html');
const PUBLIC_INDEX_HTML_PATH = path.join(CLIENT_PUBLIC_DIR, 'index.html');
const MIN_AREA_ROUTE_COUNT = 2;
const MAX_AREA_LINKS = 30;
const MAX_ROUTE_STOP_LINKS = 24;
const SEO_CACHE_TTL_MS = 10 * 60 * 1000;
const SLOW_SEO_RENDER_MS = 1000;
const REQUEST_LOGGING_ENABLED = process.env.REQUEST_LOGGING_ENABLED !== 'false';
const DEV_REQUEST_IPS = new Set(
  (process.env.DEV_REQUEST_IPS || '')
    .split(',')
    .map((value) => normalizeIp(value))
    .filter(Boolean)
);

let seoDataCache = {
  data: null,
  expiresAt: 0,
  pending: null,
};

const app = express();
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

const localPoolConfig = {
  user: 'njabulonxumalo',
  host: 'localhost',
  database: 'fika',
  port: 5432,
};

const pool = new Pool(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
} : localPoolConfig);

const siteOrigin = new URL(SITE_URL).origin;
const developmentOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
const allowedOrigins = new Set([siteOrigin, ...developmentOrigins]);

function normalizeIp(value) {
  if (!value) {
    return '';
  }

  const normalizedValue = value.trim().toLowerCase();

  if (!normalizedValue) {
    return '';
  }

  if (normalizedValue.startsWith('::ffff:')) {
    return normalizedValue.slice(7);
  }

  return normalizedValue;
}

function getForwardedIps(req) {
  const forwardedForHeader = req.get('x-forwarded-for');

  if (!forwardedForHeader) {
    return [];
  }

  return forwardedForHeader
    .split(',')
    .map((value) => normalizeIp(value))
    .filter(Boolean);
}

function getRequestLabel(req, forwardedIps) {
  const requestIps = new Set([
    normalizeIp(req.ip),
    ...forwardedIps,
  ].filter(Boolean));

  if (
    requestIps.has('127.0.0.1') ||
    requestIps.has('::1') ||
    [...requestIps].some((ip) => DEV_REQUEST_IPS.has(ip))
  ) {
    return 'dev_request';
  }

  return 'external_request';
}

function shouldLogRequest(req) {
  if (!REQUEST_LOGGING_ENABLED || req.path === '/healthz') {
    return false;
  }

  if (req.method !== 'GET') {
    return true;
  }

  return !req.path.includes('.') || req.path.endsWith('.xml');
}

app.use(compression());
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'", 'https://*.google.com', 'https://*.google-analytics.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      frameSrc: ["'self'", 'https://googleads.g.doubleclick.net', 'https://tpc.googlesyndication.com'],
      imgSrc: ["'self'", 'data:', 'https://*.google.com', 'https://*.googleusercontent.com', 'https://*.googlesyndication.com', 'https://*.doubleclick.net'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://pagead2.googlesyndication.com', 'https://fundingchoicesmessages.google.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      upgradeInsecureRequests: IS_PRODUCTION ? [] : null,
    },
  },
}));
app.use(cors({
  origin(origin, callback) {
    if (!origin || !IS_PRODUCTION || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
}));

app.use((req, res, next) => {
  if (!shouldLogRequest(req)) {
    next();
    return;
  }

  const startedAt = Date.now();
  const forwardedIps = getForwardedIps(req);
  const requestDetails = {
    event: 'incoming_request',
    requestLabel: getRequestLabel(req, forwardedIps),
    method: req.method,
    path: req.originalUrl,
    host: req.get('host') || null,
    ip: req.ip,
    forwardedIps,
    origin: req.get('origin') || null,
    referer: req.get('referer') || null,
    userAgent: req.get('user-agent') || null,
  };

  res.on('finish', () => {
    console.log(JSON.stringify({
      ...requestDetails,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });

  next();
});

app.use((req, res, next) => {
  const canonicalHost = new URL(SITE_URL).host;
  const requestHost = req.get('host');
  const shouldRedirectHost = IS_PRODUCTION &&
    requestHost &&
    requestHost !== canonicalHost &&
    req.method === 'GET' &&
    req.accepts('html') &&
    !req.path.startsWith('/schedules') &&
    !req.path.startsWith('/schedule_times') &&
    !req.path.startsWith('/healthz') &&
    !req.path.includes('.');

  if (shouldRedirectHost) {
    res.redirect(301, `${SITE_URL}${req.originalUrl}`);
    return;
  }

  next();
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(['/schedules', '/schedule_times', '/sitemap.xml'], publicApiLimiter);

const schedulesQuery = `
  SELECT
    routes.id,
    routes.name,
    routes.code,
    routes.agency,
    MAX(CASE WHEN directions.row_num = 1 THEN directions.direction END) AS direction_1,
    MAX(CASE WHEN directions.row_num = 2 THEN directions.direction END) AS direction_2
  FROM routes
  JOIN (
    SELECT
      direction,
      route_id,
      ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY direction) AS row_num
    FROM directions
  ) AS directions ON routes.id = directions.route_id
  WHERE routes.name != ''
  GROUP BY routes.id, routes.name, routes.code, routes.agency
  ORDER BY routes.agency, routes.name, routes.id;
`;

const routeByIdQuery = `
  SELECT
    routes.id,
    routes.name,
    routes.code,
    routes.agency,
    MAX(CASE WHEN directions.row_num = 1 THEN directions.direction END) AS direction_1,
    MAX(CASE WHEN directions.row_num = 2 THEN directions.direction END) AS direction_2
  FROM routes
  JOIN (
    SELECT
      direction,
      route_id,
      ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY direction) AS row_num
    FROM directions
  ) AS directions ON routes.id = directions.route_id
  WHERE routes.name != ''
    AND routes.id = $1
  GROUP BY routes.id, routes.name, routes.code, routes.agency
  LIMIT 1;
`;

const scheduleTimesQuery = `
  WITH route_stop_times AS (
    SELECT
      stops.name,
      directions.direction AS direction_name,
      directions.id AS directions_id,
      stop_times.sequence,
      trips.id AS trip_id,
      stop_times.arrival,
      stop_times.stop_time_type,
      trips.monday,
      trips.tuesday,
      trips.wednesday,
      trips.thursday,
      trips.friday,
      trips.saturday,
      trips.sunday,
      trips.public_holiday,
      CONCAT(
        trips.monday::int,
        trips.tuesday::int,
        trips.wednesday::int,
        trips.thursday::int,
        trips.friday::int,
        trips.saturday::int,
        trips.sunday::int,
        trips.public_holiday::int
      ) AS service_pattern,
      MIN(stop_times.arrival) OVER (PARTITION BY trips.id) AS first_arrival
    FROM directions
    JOIN trips ON trips.direction_id = directions.id
    JOIN stop_times ON stop_times.trip_id = trips.id
    JOIN stops ON stops.id = stop_times.stop_id
    WHERE directions.route_id = $1
  )

  SELECT
    name,
    direction_name,
    directions_id,
    sequence,
    JSON_AGG(
      JSON_BUILD_OBJECT(
        'trip_id', trip_id,
        'arrival', arrival,
        'stop_time_type', stop_time_type,
        'monday', monday,
        'tuesday', tuesday,
        'wednesday', wednesday,
        'thursday', thursday,
        'friday', friday,
        'saturday', saturday,
        'sunday', sunday,
        'public_holiday', public_holiday,
        'service_pattern', service_pattern,
        'first_arrival', first_arrival
      )
      ORDER BY service_pattern DESC, first_arrival, trip_id
    ) AS stop_times
  FROM route_stop_times
  GROUP BY directions_id, direction_name, sequence, name
  ORDER BY directions_id, sequence;
`;

function handleQueryError(res, error) {
  console.error('Error executing query', error);
  res.status(500).json({ error: 'Internal Server Error' });
}

const AGENCY_DISPLAY_NAMES = {
  GABS: 'Golden Arrow',
  MyCiti: 'MyCiTi',
};
const AGENCY_SLUGS = {
  GABS: 'golden-arrow',
  MyCiti: 'myciti',
};
const AGENCY_FROM_SLUG = Object.entries(AGENCY_SLUGS).reduce((result, [agency, slug]) => {
  result[slug] = agency;
  return result;
}, {});

const HOME_TITLE = 'Fika Timetables | Cape Town Bus Timetables';
const HOME_DESCRIPTION = 'Search Cape Town bus timetables for Golden Arrow and MyCiTi routes. Fika helps commuters find route times quickly, with more South African cities and provinces planned.';
const OPERATOR_COPY = {
  GABS: {
    title: 'Golden Arrow Bus Timetables | Cape Town',
    description: 'Search Golden Arrow bus timetables for Cape Town routes, stops, route numbers, and service days on Fika Timetables.',
  },
  MyCiti: {
    title: 'MyCiTi Bus Timetables | Cape Town',
    description: 'Search MyCiTi bus timetables for Cape Town routes, stops, route numbers, and service days on Fika Timetables.',
  },
};
const INFO_PAGES = {
  '/about': {
    title: 'About Fika Timetables | Cape Town Bus Timetables',
    heading: 'About Fika Timetables',
    eyebrow: 'About',
    description: 'Learn about Fika Timetables, a simple way to search Golden Arrow and MyCiTi bus timetables for Cape Town commuters.',
    body: [
      'Fika Timetables helps Cape Town commuters search Golden Arrow and MyCiTi bus timetables in one place.',
      'The site is designed for quick route lookup, readable timetable views, and offline access to routes you view often.',
      'More South African operators, cities, and provinces are planned as reliable timetable data becomes available.',
    ],
  },
  '/contact': {
    title: 'Contact Fika Timetables',
    heading: 'Contact Fika Timetables',
    eyebrow: 'Contact',
    description: 'Contact Fika Timetables for timetable feedback, data questions, and site enquiries.',
    body: [
      'For timetable feedback, data corrections, accessibility issues, or general enquiries, contact the Fika team.',
      'Email: hello@fikatimetables.co.za',
      'Please include the agency, route name, direction, and stop details when reporting timetable data issues.',
    ],
  },
  '/privacy-policy': {
    title: 'Privacy Policy | Fika Timetables',
    heading: 'Privacy Policy',
    eyebrow: 'Privacy',
    description: 'Read how Fika Timetables handles offline timetable caching, advertising cookies, third-party ad identifiers, and consent choices.',
    body: [
      'Fika Timetables stores viewed and saved timetables in your browser using IndexedDB so selected timetable data can be available offline.',
      'Fika Timetables uses Google AdSense to show advertising. Google and other third-party vendors may use cookies, web beacons, IP addresses, and similar identifiers to serve, personalize, limit, and measure ads.',
      'Google uses advertising cookies to help serve ads based on your prior visits to this and other websites. You can opt out of personalized advertising by visiting Google Ads Settings at https://adssettings.google.com, review Google advertising technologies at https://policies.google.com/technologies/ads, or use industry opt-out tools such as https://www.aboutads.info/choices.',
      'You can manage or delete cookies in your browser settings. Where required by law, including for visitors in the European Economic Area, the United Kingdom, and Switzerland, Fika Timetables will request consent before using cookies or identifiers for personalized advertising.',
      'The site does not require user accounts and does not ask for sensitive personal information. Contact hello@fikatimetables.co.za for privacy questions.',
    ],
  },
  '/terms': {
    title: 'Terms and Disclaimer | Fika Timetables',
    heading: 'Terms and Disclaimer',
    eyebrow: 'Terms',
    description: 'Review the Fika Timetables terms, timetable accuracy disclaimer, and acceptable use guidance.',
    body: [
      'Fika Timetables is provided as a commuter-friendly timetable viewer. Always confirm critical trips with the relevant transport operator.',
      'Timetable data can change, and Fika does not guarantee that every route, stop, or trip time is complete or current.',
      'You may use the site for personal timetable lookup. Automated scraping or abusive request patterns are not permitted.',
    ],
  },
};

function getAgencyDisplayName(agency) {
  return AGENCY_DISPLAY_NAMES[agency] || agency;
}

function getAgencySlug(agency) {
  return AGENCY_SLUGS[agency] || slugify(agency);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'route';
}

function getRouteLabel(route) {
  return route.code ? `${route.code} - ${route.name}` : route.name;
}

function getRouteDirections(route) {
  return [route.direction_1, route.direction_2].filter(Boolean);
}

function cleanAreaName(value) {
  return String(value || '')
    .replace(/\((?:anti-?clockwise|clockwise)\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatAreaName(value) {
  return cleanAreaName(value)
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bSap\b/g, 'SAP');
}

function getAreaNamesForRoute(route) {
  const routeParts = String(route.name || '').split(/\s+-\s+/);
  const directionParts = getRouteDirections(route)
    .flatMap((direction) => String(direction).split(/\s+-\s+| to /i));

  return [...new Set([...routeParts, ...directionParts]
    .map(cleanAreaName)
    .filter((value) => value.length >= 3))];
}

function getCanonicalTimetablePath(route) {
  return `/timetables/${getAgencySlug(route.agency)}/${route.id}-${slugify(route.name)}`;
}

function getCanonicalOperatorPath(agency) {
  return `/operators/${getAgencySlug(agency)}`;
}

function getCanonicalAreaPath(areaName) {
  return `/areas/${slugify(areaName)}`;
}

function getAbsoluteUrl(urlPath) {
  return `${SITE_URL}${urlPath}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

function formatTime(value) {
  if (!value) {
    return '';
  }

  return String(value).substring(0, 5);
}

function serializeJsonLd(data) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function getHomepageJsonLd() {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Fika Timetables',
      url: SITE_URL,
      description: HOME_DESCRIPTION,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${SITE_URL}/?q={search_term_string}`,
        'query-input': 'required name=search_term_string',
      },
    },
  ];
}

function getTimetableJsonLd(route, canonicalPath) {
  const routeLabel = getRouteLabel(route);
  const agencyName = getAgencyDisplayName(route.agency);
  const canonicalUrl = getAbsoluteUrl(canonicalPath);

  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: `${routeLabel} Timetable | Fika`,
      url: canonicalUrl,
      description: getTimetableDescription(route),
      isPartOf: {
        '@type': 'WebSite',
        name: 'Fika Timetables',
        url: SITE_URL,
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: 'Fika Timetables',
          item: SITE_URL,
        },
        {
          '@type': 'ListItem',
          position: 2,
          name: agencyName,
          item: getAbsoluteUrl(getCanonicalOperatorPath(route.agency)),
        },
        {
          '@type': 'ListItem',
          position: 3,
          name: routeLabel,
          item: canonicalUrl,
        },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Dataset',
      name: `${agencyName} ${routeLabel} bus timetable`,
      description: getTimetableDescription(route),
      url: canonicalUrl,
      spatialCoverage: {
        '@type': 'Place',
        name: 'Cape Town, South Africa',
      },
      provider: {
        '@type': 'Organization',
        name: agencyName,
      },
      includedInDataCatalog: {
        '@type': 'DataCatalog',
        name: 'Fika Timetables',
        url: SITE_URL,
      },
    },
  ];
}

function getBreadcrumbJsonLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

function getTimetableDescription(route, serviceWindow) {
  const agencyName = getAgencyDisplayName(route.agency);
  const routeLabel = getRouteLabel(route);
  const directions = getRouteDirections(route);
  const directionText = directions.length
    ? `, including trips to ${directions.join(' and ')}`
    : '';
  const timeText = serviceWindow?.first_time && serviceWindow?.last_time
    ? ` First listed trips run from ${formatTime(serviceWindow.first_time)} to ${formatTime(serviceWindow.last_time)}.`
    : '';

  return `View the ${agencyName} ${routeLabel} bus timetable in Cape Town${directionText}. Find route times quickly on Fika.${timeText}`;
}

function getHomepageSeo() {
  return {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonicalUrl: SITE_URL,
    jsonLd: getHomepageJsonLd(),
  };
}

function getInfoPageSeo(pagePath) {
  const page = INFO_PAGES[pagePath] || INFO_PAGES['/about'];

  return {
    title: page.title,
    description: page.description,
    canonicalUrl: getAbsoluteUrl(pagePath),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: page.title,
        url: getAbsoluteUrl(pagePath),
        description: page.description,
        isPartOf: {
          '@type': 'WebSite',
          name: 'Fika Timetables',
          url: SITE_URL,
        },
      },
    ],
  };
}

function getOperatorSeo(agency) {
  const agencyName = getAgencyDisplayName(agency);
  const page = OPERATOR_COPY[agency] || {
    title: `${agencyName} Bus Timetables | Cape Town`,
    description: `Search ${agencyName} bus timetables for Cape Town routes on Fika Timetables.`,
  };
  const canonicalPath = getCanonicalOperatorPath(agency);
  const canonicalUrl = getAbsoluteUrl(canonicalPath);

  return {
    title: page.title,
    description: page.description,
    canonicalUrl,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: page.title,
        url: canonicalUrl,
        description: page.description,
        isPartOf: {
          '@type': 'WebSite',
          name: 'Fika Timetables',
          url: SITE_URL,
        },
        about: {
          '@type': 'Organization',
          name: agencyName,
        },
      },
      getBreadcrumbJsonLd([
        { name: 'Fika Timetables', url: SITE_URL },
        { name: agencyName, url: canonicalUrl },
      ]),
    ],
  };
}

function getAreaSeo(area) {
  const canonicalPath = getCanonicalAreaPath(area.name);
  const canonicalUrl = getAbsoluteUrl(canonicalPath);
  const title = `${area.name} Bus Timetables | Cape Town`;
  const description = `Find Cape Town bus routes and timetables serving ${area.name}, including Golden Arrow and MyCiTi services where available.`;

  return {
    title,
    description,
    canonicalUrl,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        url: canonicalUrl,
        description,
        isPartOf: {
          '@type': 'WebSite',
          name: 'Fika Timetables',
          url: SITE_URL,
        },
        about: {
          '@type': 'Place',
          name: `${area.name}, Cape Town`,
        },
      },
      getBreadcrumbJsonLd([
        { name: 'Fika Timetables', url: SITE_URL },
        { name: 'Cape Town Areas', url: getAbsoluteUrl('/areas') },
        { name: area.name, url: canonicalUrl },
      ]),
    ],
  };
}

function getAreasSeo() {
  const canonicalUrl = getAbsoluteUrl('/areas');
  const title = 'Cape Town Bus Areas | Fika Timetables';
  const description = 'Browse Cape Town bus timetable areas and stops served by Golden Arrow and MyCiTi routes on Fika Timetables.';

  return {
    title,
    description,
    canonicalUrl,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: title,
        url: canonicalUrl,
        description,
        isPartOf: {
          '@type': 'WebSite',
          name: 'Fika Timetables',
          url: SITE_URL,
        },
      },
      getBreadcrumbJsonLd([
        { name: 'Fika Timetables', url: SITE_URL },
        { name: 'Cape Town Areas', url: canonicalUrl },
      ]),
    ],
  };
}

function getTimetableSeo(route, serviceWindow) {
  const canonicalPath = getCanonicalTimetablePath(route);
  const agencyName = getAgencyDisplayName(route.agency);
  const routeLabel = getRouteLabel(route);

  return {
    title: `${agencyName} ${routeLabel} Timetable | Fika`,
    description: getTimetableDescription(route, serviceWindow),
    canonicalUrl: getAbsoluteUrl(canonicalPath),
    jsonLd: getTimetableJsonLd(route, canonicalPath),
  };
}

function getIndexHtml() {
  const indexPath = fs.existsSync(INDEX_HTML_PATH) ? INDEX_HTML_PATH : PUBLIC_INDEX_HTML_PATH;
  return fs.readFileSync(indexPath, 'utf8');
}

function replaceOrInsertHeadTag(html, pattern, tag) {
  if (pattern.test(html)) {
    return html.replace(pattern, tag);
  }

  return html.replace('</head>', `    ${tag}\n  </head>`);
}

function renderIndexHtml(seo, bodyHtml = '') {
  let html = getIndexHtml();
  const title = escapeHtml(seo.title);
  const description = escapeHtml(seo.description);
  const canonicalUrl = escapeHtml(seo.canonicalUrl);
  const jsonLd = serializeJsonLd(seo.jsonLd);

  html = replaceOrInsertHeadTag(html, /<title[^>]*>.*?<\/title>/i, `<title>${title}</title>`);
  html = replaceOrInsertHeadTag(html, /<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${description}" />`);
  html = replaceOrInsertHeadTag(html, /<link\s+rel="canonical"[^>]*>/i, `<link rel="canonical" href="${canonicalUrl}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:title"[^>]*>/i, `<meta property="og:title" content="${title}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:description"[^>]*>/i, `<meta property="og:description" content="${description}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:url"[^>]*>/i, `<meta property="og:url" content="${canonicalUrl}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:type"[^>]*>/i, '<meta property="og:type" content="website" />');
  html = replaceOrInsertHeadTag(html, /<meta\s+name="twitter:card"[^>]*>/i, '<meta name="twitter:card" content="summary" />');
  html = replaceOrInsertHeadTag(html, /<meta\s+name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${title}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${description}" />`);
  html = replaceOrInsertHeadTag(html, /<script\s+id="seo-jsonld"[^>]*>[\s\S]*?<\/script>/i, `<script id="seo-jsonld" type="application/ld+json">${jsonLd}</script>`);
  html = html.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);

  return html;
}

async function getRouteById(routeId) {
  const { rows } = await pool.query(routeByIdQuery, [routeId]);
  return rows[0];
}

async function getAllRoutes() {
  const { rows } = await pool.query(schedulesQuery);
  return rows;
}

async function getRouteServiceWindow(routeId) {
  const { rows } = await pool.query(`
    SELECT MIN(stop_times.arrival) AS first_time, MAX(stop_times.arrival) AS last_time
    FROM directions
    JOIN trips ON trips.direction_id = directions.id
    JOIN stop_times ON stop_times.trip_id = trips.id
    WHERE directions.route_id = $1
      AND stop_times.arrival IS NOT NULL
      AND COALESCE(stop_times.stop_time_type, '') != 'not_served';
  `, [routeId]);

  return rows[0];
}

async function getRouteStops(routeId) {
  const { rows } = await pool.query(`
    SELECT
      directions.direction AS direction_name,
      stops.name,
      MIN(stop_times.sequence) AS sequence
    FROM directions
    JOIN trips ON trips.direction_id = directions.id
    JOIN stop_times ON stop_times.trip_id = trips.id
    JOIN stops ON stops.id = stop_times.stop_id
    WHERE directions.route_id = $1
      AND COALESCE(stop_times.stop_time_type, '') != 'not_served'
    GROUP BY directions.direction, stops.name
    ORDER BY directions.direction, sequence, stops.name;
  `, [routeId]);

  return rows;
}

async function getStopRouteAreas() {
  const { rows } = await pool.query(`
    SELECT DISTINCT
      stops.name AS area_name,
      routes.id,
      routes.name,
      routes.code,
      routes.agency,
      MAX(CASE WHEN ranked_directions.row_num = 1 THEN ranked_directions.direction END) OVER (PARTITION BY routes.id, stops.name) AS direction_1,
      MAX(CASE WHEN ranked_directions.row_num = 2 THEN ranked_directions.direction END) OVER (PARTITION BY routes.id, stops.name) AS direction_2
    FROM stops
    JOIN stop_times ON stop_times.stop_id = stops.id
    JOIN trips ON trips.id = stop_times.trip_id
    JOIN directions ON directions.id = trips.direction_id
    JOIN routes ON routes.id = directions.route_id
    JOIN (
      SELECT
        id,
        route_id,
        direction,
        ROW_NUMBER() OVER (PARTITION BY route_id ORDER BY direction) AS row_num
      FROM directions
    ) ranked_directions ON ranked_directions.route_id = routes.id
    WHERE routes.name != ''
      AND COALESCE(stop_times.stop_time_type, '') != 'not_served';
  `);

  return rows;
}

function upsertArea(areaMap, areaName, route) {
  const normalizedName = cleanAreaName(areaName);

  if (normalizedName.length < 3) {
    return;
  }

  const slug = slugify(normalizedName);

  if (!areaMap.has(slug)) {
    areaMap.set(slug, {
      slug,
      name: formatAreaName(normalizedName),
      routeMap: new Map(),
    });
  }

  const area = areaMap.get(slug);
  area.routeMap.set(Number(route.id), route);
}

function finalizeAreas(areaMap) {
  return [...areaMap.values()]
    .map((area) => ({
      slug: area.slug,
      name: area.name,
      routes: [...area.routeMap.values()].sort((first, second) =>
        getRouteLabel(first).localeCompare(getRouteLabel(second))
      ),
    }))
    .filter((area) => area.routes.length >= MIN_AREA_ROUTE_COUNT)
    .sort((first, second) => first.name.localeCompare(second.name));
}

async function buildSeoData() {
  const [routes, stopRoutes] = await Promise.all([getAllRoutes(), getStopRouteAreas()]);
  const areaMap = new Map();

  routes.forEach((route) => {
    getAreaNamesForRoute(route).forEach((areaName) => upsertArea(areaMap, areaName, route));
  });

  stopRoutes.forEach((row) => {
    upsertArea(areaMap, row.area_name, row);
  });

  const areas = finalizeAreas(areaMap);

  return {
    routes,
    areas,
    areaBySlug: new Map(areas.map((area) => [area.slug, area])),
    generatedAt: Date.now(),
  };
}

async function getSeoData({ forceRefresh = false } = {}) {
  const now = Date.now();

  if (!forceRefresh && seoDataCache.data && seoDataCache.expiresAt > now) {
    return seoDataCache.data;
  }

  if (!forceRefresh && seoDataCache.pending) {
    return seoDataCache.pending;
  }

  seoDataCache.pending = buildSeoData()
    .then((data) => {
      seoDataCache = {
        data,
        expiresAt: Date.now() + SEO_CACHE_TTL_MS,
        pending: null,
      };
      return data;
    })
    .catch((error) => {
      seoDataCache.pending = null;
      throw error;
    });

  return seoDataCache.pending;
}

function logSlowSeoRender(label, startedAt) {
  const durationMs = Date.now() - startedAt;

  if (IS_PRODUCTION && durationMs > SLOW_SEO_RENDER_MS) {
    console.warn(`Slow SEO render: ${label} took ${durationMs}ms`);
  }
}

function renderRouteLinks(routes, className = 'seo-link-list') {
  if (!routes.length) {
    return '';
  }

  return `<ul class="${className}">${routes.map((route) => (
    `<li><a href="${escapeHtml(getCanonicalTimetablePath(route))}">${escapeHtml(getAgencyDisplayName(route.agency))} ${escapeHtml(getRouteLabel(route))}</a></li>`
  )).join('')}</ul>`;
}

function renderAreaLinks(areas, className = 'seo-link-list') {
  if (!areas.length) {
    return '';
  }

  return `<ul class="${className}">${areas.map((area) => (
    `<li><a href="${escapeHtml(getCanonicalAreaPath(area.name))}">${escapeHtml(area.name)} bus timetables</a></li>`
  )).join('')}</ul>`;
}

function renderSiteFooter() {
  const links = [
    { href: '/operators/myciti', label: 'MyCiTi' },
    { href: '/operators/golden-arrow', label: 'Golden Arrow' },
    { href: '/areas', label: 'Areas' },
    { href: '/about', label: 'About' },
    { href: '/contact', label: 'Contact' },
    { href: '/privacy-policy', label: 'Privacy Policy' },
    { href: '/terms', label: 'Terms' },
  ];

  return `
    <footer class="site-footer">
      ${links.map((link) => (
        `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`
      )).join('')}
    </footer>
  `;
}

function renderInfoBody(page) {
  return `
    <main class="info-page">
      <section class="info-panel">
        <p class="info-eyebrow">${escapeHtml(page.eyebrow)}</p>
        <h1>${escapeHtml(page.heading || page.title)}</h1>
        ${page.body.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
      </section>
      ${renderSiteFooter()}
    </main>
  `;
}

function renderSeoShell({ eyebrow, title, description, sections = [] }) {
  return `
    <main class="seo-page">
      <section class="seo-panel">
        <p class="seo-eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(description)}</p>
        ${sections.map((section) => `
          <section class="seo-section">
            <h2>${escapeHtml(section.title)}</h2>
            ${section.html}
          </section>
        `).join('')}
      </section>
    </main>
  `;
}

function renderHomeBody(routes = [], areas = []) {
  const operatorSections = Object.keys(AGENCY_SLUGS).map((agency) => ({
    name: getAgencyDisplayName(agency),
    path: getCanonicalOperatorPath(agency),
    count: routes.filter((route) => route.agency === agency).length,
  }));

  return renderSeoShell({
    eyebrow: 'Cape Town bus timetables',
    title: 'Find Golden Arrow and MyCiTi bus timetables in Cape Town',
    description: HOME_DESCRIPTION,
    sections: [
      {
        title: 'Bus Operators',
        html: `<ul class="seo-link-list">${operatorSections.map((operator) => (
          `<li><a href="${escapeHtml(operator.path)}">${escapeHtml(operator.name)} timetables</a> <span>${operator.count} routes</span></li>`
        )).join('')}</ul>`,
      },
      {
        title: 'Popular Areas',
        html: renderAreaLinks(areas.slice(0, MAX_AREA_LINKS)),
      },
    ],
  });
}

function renderOperatorBody(agency, routes, areas) {
  const agencyName = getAgencyDisplayName(agency);
  const page = OPERATOR_COPY[agency];
  const operatorAreas = areas
    .filter((area) => area.routes.some((route) => route.agency === agency))
    .slice(0, MAX_AREA_LINKS);

  return renderSeoShell({
    eyebrow: 'Cape Town bus operator',
    title: page.title,
    description: page.description,
    sections: [
      {
        title: `${agencyName} Routes`,
        html: renderRouteLinks(routes),
      },
      {
        title: `${agencyName} Areas And Stops`,
        html: renderAreaLinks(operatorAreas),
      },
    ],
  });
}

function renderAreaBody(area) {
  return renderSeoShell({
    eyebrow: 'Cape Town bus area',
    title: `${area.name} bus timetables`,
    description: `Find bus routes serving ${area.name} in Cape Town. View Golden Arrow and MyCiTi timetables by route, stop, and direction where available.`,
    sections: [
      {
        title: `Routes serving ${area.name}`,
        html: renderRouteLinks(area.routes),
      },
    ],
  });
}

function renderAreasBody(areas) {
  return renderSeoShell({
    eyebrow: 'Cape Town bus areas',
    title: 'Cape Town bus areas and stops',
    description: 'Browse Golden Arrow and MyCiTi timetable pages by Cape Town area, stop, and route coverage.',
    sections: [
      {
        title: 'Areas And Stops',
        html: renderAreaLinks(areas),
      },
    ],
  });
}

function renderTimetableBody(route, stops, serviceWindow, relatedRoutes, indexedAreas) {
  const agencyName = getAgencyDisplayName(route.agency);
  const routeLabel = getRouteLabel(route);
  const indexedAreaBySlug = new Map(indexedAreas.map((area) => [area.slug, area]));
  const areas = [...new Map(getAreaNamesForRoute(route)
    .map((name) => indexedAreaBySlug.get(slugify(name)))
    .filter(Boolean)
    .map((area) => [area.slug, area])).values()];
  const stopAreas = [...new Map(stops
    .map((stop) => indexedAreaBySlug.get(slugify(cleanAreaName(stop.name))))
    .filter(Boolean)
    .map((area) => [area.slug, area])).values()]
    .slice(0, MAX_ROUTE_STOP_LINKS);
  const timeSummary = serviceWindow?.first_time && serviceWindow?.last_time
    ? `Listed trips run from ${formatTime(serviceWindow.first_time)} to ${formatTime(serviceWindow.last_time)}.`
    : 'Open the timetable to view service days, directions, stops, and listed trip times.';

  return renderSeoShell({
    eyebrow: `${agencyName} timetable`,
    title: `${agencyName} ${routeLabel} bus timetable`,
    description: `${getTimetableDescription(route, serviceWindow)} ${timeSummary}`,
    sections: [
      {
        title: 'Route Areas',
        html: renderAreaLinks(areas),
      },
      {
        title: 'Stops On This Timetable',
        html: renderAreaLinks(stopAreas),
      },
      {
        title: 'Related Cape Town Routes',
        html: renderRouteLinks(relatedRoutes),
      },
    ],
  });
}

function getRelatedRoutes(route, allRoutes) {
  const currentAreas = new Set(getAreaNamesForRoute(route).map(slugify));

  return allRoutes
    .filter((candidate) => Number(candidate.id) !== Number(route.id))
    .map((candidate) => ({
      route: candidate,
      score: getAreaNamesForRoute(candidate).filter((area) => currentAreas.has(slugify(area))).length,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((first, second) => second.score - first.score || getRouteLabel(first.route).localeCompare(getRouteLabel(second.route)))
    .slice(0, 12)
    .map((candidate) => candidate.route);
}

app.get('/schedules', async (req, res) => {
  try {
    const { rows } = await pool.query(schedulesQuery);
    res.json(rows);
  } catch (error) {
    handleQueryError(res, error);
  }
});

app.get('/schedule_times/:id', async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Route id must be numeric' });
    return;
  }

  try {
    const { rows } = await pool.query(scheduleTimesQuery, [id]);
    res.json(rows);
  } catch (error) {
    handleQueryError(res, error);
  }
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

app.get('/healthz/db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (error) {
    console.error('Database health check failed', error);
    res.status(503).json({ ok: false });
  }
});

app.get('/sitemap.xml', async (req, res) => {
  const startedAt = Date.now();

  try {
    const { routes, areas } = await getSeoData();
    const urls = [
      {
        loc: SITE_URL,
        priority: '1.0',
      },
      ...Object.values(AGENCY_SLUGS).map((slug) => ({
        loc: getAbsoluteUrl(`/operators/${slug}`),
        priority: '0.9',
      })),
      ...Object.keys(INFO_PAGES).map((pagePath) => ({
        loc: getAbsoluteUrl(pagePath),
        priority: '0.5',
      })),
      {
        loc: getAbsoluteUrl('/areas'),
        priority: '0.7',
      },
      ...routes.map((route) => ({
        loc: getAbsoluteUrl(getCanonicalTimetablePath(route)),
        priority: '0.8',
      })),
      ...areas.map((area) => ({
        loc: getAbsoluteUrl(getCanonicalAreaPath(area.name)),
        priority: '0.7',
      })),
    ];

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((url) => (
        `  <url>\n` +
        `    <loc>${escapeXml(url.loc)}</loc>\n` +
        `    <changefreq>weekly</changefreq>\n` +
        `    <priority>${url.priority}</priority>\n` +
        `  </url>`
      )).join('\n') +
      `\n</urlset>\n`;

    logSlowSeoRender('GET /sitemap.xml', startedAt);
    res.type('application/xml').send(sitemap);
  } catch (error) {
    console.error('Error generating sitemap', error);
    res.status(500).type('text/plain').send('Unable to generate sitemap');
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/ads.txt', (req, res) => {
  const adsTxt = ADSENSE_PUBLISHER_ID
    ? `google.com, ${ADSENSE_PUBLISHER_ID}, DIRECT, f08c47fec0942fa0\n`
    : '# AdSense publisher id pending. Set ADSENSE_PUBLISHER_ID to enable ads.txt.\n';

  res.type('text/plain').send(adsTxt);
});

app.get('/sw.js', (req, res) => {
  const serviceWorkerPath = fs.existsSync(path.join(CLIENT_BUILD_DIR, 'sw.js'))
    ? path.join(CLIENT_BUILD_DIR, 'sw.js')
    : path.join(CLIENT_PUBLIC_DIR, 'sw.js');

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(serviceWorkerPath);
});

app.get('/', async (req, res) => {
  const startedAt = Date.now();

  try {
    const { routes, areas } = await getSeoData();
    logSlowSeoRender('GET /', startedAt);
    res.send(renderIndexHtml(getHomepageSeo(), renderHomeBody(routes, areas)));
  } catch (error) {
    console.error('Error rendering homepage', error);
    res.send(renderIndexHtml(getHomepageSeo()));
  }
});

Object.keys(INFO_PAGES).forEach((pagePath) => {
  app.get(pagePath, (req, res) => {
    res.send(renderIndexHtml(getInfoPageSeo(pagePath), renderInfoBody(INFO_PAGES[pagePath])));
  });
});

app.get('/operators/:agencySlug', async (req, res) => {
  const startedAt = Date.now();
  const agency = AGENCY_FROM_SLUG[req.params.agencySlug];

  if (!agency) {
    res.status(404).send(renderIndexHtml(getHomepageSeo(), renderSeoShell({
      eyebrow: 'Not found',
      title: 'Operator not found',
      description: 'Select Golden Arrow or MyCiTi to view available Cape Town bus timetables.',
      sections: [
        {
          title: 'Available operators',
          html: `<ul class="seo-link-list">${Object.keys(AGENCY_SLUGS).map((operator) => (
            `<li><a href="${escapeHtml(getCanonicalOperatorPath(operator))}">${escapeHtml(getAgencyDisplayName(operator))} timetables</a></li>`
          )).join('')}</ul>`,
        },
      ],
    })));
    return;
  }

  try {
    const { routes, areas } = await getSeoData();
    const operatorRoutes = routes.filter((route) => route.agency === agency);

    logSlowSeoRender(`GET /operators/${req.params.agencySlug}`, startedAt);
    res.send(renderIndexHtml(getOperatorSeo(agency), renderOperatorBody(agency, operatorRoutes, areas)));
  } catch (error) {
    console.error('Error rendering operator page', error);
    res.status(500).send(renderIndexHtml(getHomepageSeo()));
  }
});

app.get('/areas', async (req, res) => {
  const startedAt = Date.now();

  try {
    const { areas } = await getSeoData();
    logSlowSeoRender('GET /areas', startedAt);
    res.send(renderIndexHtml(getAreasSeo(), renderAreasBody(areas)));
  } catch (error) {
    console.error('Error rendering areas page', error);
    res.status(500).send(renderIndexHtml(getHomepageSeo()));
  }
});

app.get('/areas/:areaSlug', async (req, res) => {
  const startedAt = Date.now();

  try {
    const { areaBySlug } = await getSeoData();
    const area = areaBySlug.get(req.params.areaSlug);

    if (!area) {
      res.status(404).send(renderIndexHtml(getHomepageSeo(), renderSeoShell({
        eyebrow: 'Not found',
        title: 'Area not found',
        description: 'This Cape Town bus area is not available yet. Search Fika Timetables for MyCiTi and Golden Arrow routes.',
      })));
      return;
    }

    const canonicalPath = getCanonicalAreaPath(area.name);

    if (req.path !== canonicalPath) {
      res.redirect(301, canonicalPath);
      return;
    }

    logSlowSeoRender(`GET /areas/${req.params.areaSlug}`, startedAt);
    res.send(renderIndexHtml(getAreaSeo(area), renderAreaBody(area)));
  } catch (error) {
    console.error('Error rendering area page', error);
    res.status(500).send(renderIndexHtml(getHomepageSeo()));
  }
});

app.get('/timetables/:agency/:routeSlug', async (req, res) => {
  const startedAt = Date.now();
  const routeIdMatch = req.params.routeSlug.match(/^(\d+)(?:-|$)/);

  if (!routeIdMatch) {
    res.status(404).send(renderIndexHtml(getHomepageSeo(), renderSeoShell({
      eyebrow: 'Not found',
      title: 'Timetable not found',
      description: 'This timetable URL is not available. Search Fika Timetables for MyCiTi and Golden Arrow routes.',
    })));
    return;
  }

  try {
    const [route, seoData] = await Promise.all([
      getRouteById(routeIdMatch[1]),
      getSeoData(),
    ]);

    if (!route) {
      res.status(404).send(renderIndexHtml(getHomepageSeo(), renderSeoShell({
        eyebrow: 'Not found',
        title: 'Timetable not found',
        description: 'This timetable URL is not available. Search Fika Timetables for MyCiTi and Golden Arrow routes.',
      })));
      return;
    }

    const canonicalPath = getCanonicalTimetablePath(route);

    if (req.path !== canonicalPath) {
      res.redirect(301, canonicalPath);
      return;
    }

    const [stops, serviceWindow] = await Promise.all([
      getRouteStops(route.id),
      getRouteServiceWindow(route.id),
    ]);
    const relatedRoutes = getRelatedRoutes(route, seoData.routes);

    logSlowSeoRender(`GET /timetables/${req.params.agency}/${req.params.routeSlug}`, startedAt);
    res.send(renderIndexHtml(
      getTimetableSeo(route, serviceWindow),
      renderTimetableBody(route, stops, serviceWindow, relatedRoutes, seoData.areas)
    ));
  } catch (error) {
    console.error('Error rendering timetable route', error);
    res.status(500).send(renderIndexHtml(getHomepageSeo()));
  }
});

app.use(express.static(CLIENT_BUILD_DIR, { index: false }));

app.get('*', (req, res) => {
  res.send(renderIndexHtml(getHomepageSeo()));
});

app.listen(PORT, () => {
  console.log(`Fika server listening on port ${PORT}`);
});
