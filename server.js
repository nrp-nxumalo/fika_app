const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const {
  API_CACHE_PAYLOAD_KINDS,
  API_RESPONSE_CACHE_INDEX_SQL,
  API_RESPONSE_CACHE_TABLE_SQL,
  createEtag,
  getApiCacheKey,
} = require('./lib/apiCache');
const {
  buildNormalizedTimetablePayload,
  routeByIdQuery,
  scheduleTimesQuery,
  schedulesQuery,
} = require('./lib/apiPayloads');
const {
  AGENCY_DISPLAY_NAMES,
  AGENCY_FROM_SLUG,
  AGENCY_SLUGS,
  getAgencyDisplayName,
  getAgencySlug,
  getCanonicalTimetablePath,
  slugify,
} = require('./lib/routePaths');
const { resolveTimetableRoute } = require('./lib/routeResolver');
const {
  ensureRouteUrlAliasSchema,
  getRouteUrlAlias,
  saveRouteUrlAlias,
} = require('./lib/routeUrlAliases');
const { createSearchPerformanceHandler } = require('./lib/adminSearchPerformance');
const { getPublicReliabilityReport } = require('./lib/timetableReliabilityReport');
const { createTimetableReliabilityHandlers } = require('./lib/timetableReliabilityAdmin');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 4000;
const PRODUCTION_SITE_URL = 'https://www.fika.net.za';
const DEFAULT_SITE_URL = IS_PRODUCTION ? PRODUCTION_SITE_URL : `http://localhost:${PORT}`;
const SITE_URL = (IS_PRODUCTION
  ? process.env.CANONICAL_SITE_URL || PRODUCTION_SITE_URL
  : process.env.SITE_URL || DEFAULT_SITE_URL
).replace(/\/$/, '');
const CLIENT_BUILD_DIR = path.join(__dirname, 'client', 'build');
const CLIENT_PUBLIC_DIR = path.join(__dirname, 'client', 'public');
const INDEX_HTML_PATH = path.join(CLIENT_BUILD_DIR, 'index.html');
const PUBLIC_INDEX_HTML_PATH = path.join(CLIENT_PUBLIC_DIR, 'index.html');
const MIN_AREA_ROUTE_COUNT = 3;
const MAX_AREA_LINKS = 30;
const MAX_ROUTE_STOP_LINKS = 24;
const MAX_ROUTE_STOPS = 36;
const SEO_CACHE_TTL_MS = 10 * 60 * 1000;
const SLOW_SEO_RENDER_MS = 1000;
const PUBLIC_API_CACHE_CONTROL = process.env.PUBLIC_API_CACHE_CONTROL || 'public, max-age=300, stale-while-revalidate=86400';
const API_RESPONSE_CACHE_ENABLED = process.env.API_RESPONSE_CACHE_ENABLED !== 'false';
const PG_POOL_MAX = Number(process.env.PG_POOL_MAX) || (IS_PRODUCTION ? 5 : 10);
const REQUEST_LOGGING_ENABLED = process.env.REQUEST_LOGGING_ENABLED !== 'false';
const GA4_MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]+$/i;
const PRIORITY_AREA_SLUGS = new Set([
  'atlantis',
  'mamre',
  'claremont',
  'khayelitsha',
  'cape-town',
  'delft',
  'bellville',
  'heideveld',
]);
const PRIORITY_AREA_ORDER = [...PRIORITY_AREA_SLUGS];
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
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30 * 1000,
  connectionTimeoutMillis: 5 * 1000,
} : {
  ...localPoolConfig,
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30 * 1000,
  connectionTimeoutMillis: 5 * 1000,
});

const timetableReliabilityHandlers = createTimetableReliabilityHandlers({
  database: pool,
  username: process.env.TIMETABLE_ADMIN_USERNAME || process.env.SEO_REPORT_USERNAME,
  password: process.env.TIMETABLE_ADMIN_PASSWORD || process.env.SEO_REPORT_PASSWORD,
});
const timetableReliabilityForm = express.urlencoded({
  extended: false,
  limit: '64kb',
  parameterLimit: 500,
});

const siteOrigin = new URL(SITE_URL).origin;
const developmentOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]);
// CANONICAL_SITE_URL can be configured as either the apex or www hostname.
// Both are first-party Fika origins and users can legitimately arrive at the
// other hostname before a redirect or while an older page is still open.
const productionOrigins = new Set([
  new URL(PRODUCTION_SITE_URL).origin,
  'https://fika.net.za',
]);
const allowedOrigins = new Set([siteOrigin, ...productionOrigins, ...developmentOrigins]);

function isAllowedCorsOrigin(origin, { isProduction = IS_PRODUCTION } = {}) {
  return !origin || !isProduction || allowedOrigins.has(origin);
}

function shouldApplyCors(requestPath) {
  // The reliability console is server-rendered and protected by Basic auth
  // plus candidate-specific HMAC action tokens. CORS is an API response policy
  // and must not sit in front of these ordinary HTML form submissions.
  return !(
    requestPath === '/admin/timetable-reliability' ||
    requestPath.startsWith('/admin/timetable-reliability/')
  );
}
const CONTENT_SECURITY_POLICY_DIRECTIVES = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  connectSrc: [
    "'self'",
    'https://*.google-analytics.com',
    'https://*.analytics.google.com',
    'https://www.googletagmanager.com',
  ],
  fontSrc: ["'self'", 'https://fonts.gstatic.com'],
  frameSrc: ["'self'"],
  imgSrc: ["'self'", 'data:', 'https://*.google-analytics.com', 'https://www.googletagmanager.com'],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com'],
  scriptSrcElem: ["'self'", "'unsafe-inline'", 'https://www.googletagmanager.com'],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  upgradeInsecureRequests: IS_PRODUCTION ? [] : null,
};

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
    directives: CONTENT_SECURITY_POLICY_DIRECTIVES,
  },
}));
const corsMiddleware = cors({
  origin(origin, callback) {
    if (isAllowedCorsOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error('Not allowed by CORS'));
  },
});
app.use((req, res, next) => {
  if (!shouldApplyCors(req.path)) {
    next();
    return;
  }
  corsMiddleware(req, res, next);
});

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
    !req.path.startsWith('/api/') &&
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
app.use(['/schedules', '/schedule_times', '/api/v2/schedule_times', '/api/reliability', '/sitemap.xml'], publicApiLimiter);

function handleQueryError(res, error) {
  console.error('Error executing query', error);
  res.status(500).json({ error: 'Internal Server Error' });
}

let apiResponseCacheReady = false;
let apiResponseCacheSetupPromise = null;
let apiResponseCacheWarningLogged = false;

async function ensureApiResponseCacheTable() {
  if (apiResponseCacheReady) {
    return;
  }

  if (!apiResponseCacheSetupPromise) {
    apiResponseCacheSetupPromise = (async () => {
      await pool.query(API_RESPONSE_CACHE_TABLE_SQL);
      await pool.query(API_RESPONSE_CACHE_INDEX_SQL);
      apiResponseCacheReady = true;
    })().finally(() => {
      apiResponseCacheSetupPromise = null;
    });
  }

  await apiResponseCacheSetupPromise;
}

async function getApiResponseCacheEntry(cacheKey) {
  const startedAt = Date.now();

  if (!API_RESPONSE_CACHE_ENABLED) {
    return {
      entry: null,
      queryMs: 0,
      unavailable: false,
    };
  }

  try {
    await ensureApiResponseCacheTable();

    const { rows } = await pool.query(`
      SELECT
        etag,
        payload_text,
        payload_gzip,
        payload_br,
        updated_at,
        octet_length(payload_text) AS payload_bytes,
        octet_length(payload_gzip) AS gzip_bytes,
        octet_length(payload_br) AS br_bytes
      FROM api_response_cache
      WHERE cache_key = $1
      LIMIT 1;
    `, [cacheKey]);

    return {
      entry: rows[0] || null,
      queryMs: Date.now() - startedAt,
      unavailable: false,
    };
  } catch (error) {
    if (!apiResponseCacheWarningLogged) {
      apiResponseCacheWarningLogged = true;
      console.warn('API response cache unavailable; falling back to live queries', error);
    }

    return {
      entry: null,
      queryMs: Date.now() - startedAt,
      unavailable: true,
    };
  }
}

function logApiResponse(req, metrics) {
  if (!REQUEST_LOGGING_ENABLED) {
    return;
  }

  console.log(JSON.stringify({
    event: 'api_response',
    method: req.method,
    path: req.originalUrl,
    status: metrics.status,
    cacheKey: metrics.cacheKey,
    cacheHit: metrics.cacheHit,
    cacheQueryMs: metrics.cacheQueryMs,
    queryMs: metrics.queryMs,
    payloadBytes: metrics.payloadBytes,
    responseBytes: metrics.responseBytes,
    encoding: metrics.encoding,
    durationMs: metrics.durationMs,
  }));
}

function setJsonCacheHeaders(req, res, { etag, updatedAt, cacheHit }) {
  res.type('application/json');
  res.set('Cache-Control', PUBLIC_API_CACHE_CONTROL);
  res.set('ETag', etag);
  res.set('Vary', 'Accept-Encoding');
  res.set('X-Fika-Cache', cacheHit ? 'hit' : 'miss');

  if (updatedAt) {
    res.set('Last-Modified', new Date(updatedAt).toUTCString());
  }

  return req.fresh;
}

function getPreferredCachedEncoding(req, entry) {
  const preferredEncoding = req.acceptsEncodings('br', 'gzip', 'identity');

  if (preferredEncoding === 'br' && entry.payload_br) {
    return {
      encoding: 'br',
      body: entry.payload_br,
      responseBytes: Number(entry.br_bytes) || entry.payload_br.length,
    };
  }

  if (preferredEncoding === 'gzip' && entry.payload_gzip) {
    return {
      encoding: 'gzip',
      body: entry.payload_gzip,
      responseBytes: Number(entry.gzip_bytes) || entry.payload_gzip.length,
    };
  }

  if (preferredEncoding === false) {
    return null;
  }

  const body = Buffer.from(entry.payload_text);

  return {
    encoding: 'identity',
    body,
    responseBytes: Number(entry.payload_bytes) || body.length,
  };
}

function sendCachedApiPayload(req, res, { entry, cacheKey, cacheQueryMs, startedAt }) {
  const payloadBytes = Number(entry.payload_bytes) || Buffer.byteLength(entry.payload_text);
  const isFresh = setJsonCacheHeaders(req, res, {
    etag: entry.etag,
    updatedAt: entry.updated_at,
    cacheHit: true,
  });

  if (isFresh) {
    res.status(304).end();
    logApiResponse(req, {
      cacheKey,
      cacheHit: true,
      cacheQueryMs,
      queryMs: 0,
      payloadBytes,
      responseBytes: 0,
      encoding: 'not-modified',
      status: 304,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const encodedPayload = getPreferredCachedEncoding(req, entry);

  if (!encodedPayload) {
    res.status(406).send('Not Acceptable');
    logApiResponse(req, {
      cacheKey,
      cacheHit: true,
      cacheQueryMs,
      queryMs: 0,
      payloadBytes,
      responseBytes: 0,
      encoding: 'not-acceptable',
      status: 406,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  if (encodedPayload.encoding !== 'identity') {
    res.set('Content-Encoding', encodedPayload.encoding);
  }

  res.set('Content-Length', String(encodedPayload.responseBytes));
  res.send(encodedPayload.body);
  logApiResponse(req, {
    cacheKey,
    cacheHit: true,
    cacheQueryMs,
    queryMs: 0,
    payloadBytes,
    responseBytes: encodedPayload.responseBytes,
    encoding: encodedPayload.encoding,
    status: 200,
    durationMs: Date.now() - startedAt,
  });
}

function sendLiveApiPayload(req, res, { payload, cacheKey, cacheQueryMs, queryMs, startedAt }) {
  const payloadText = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadText);
  const etag = createEtag(payloadText);
  const isFresh = setJsonCacheHeaders(req, res, {
    etag,
    cacheHit: false,
  });

  if (isFresh) {
    res.status(304).end();
    logApiResponse(req, {
      cacheKey,
      cacheHit: false,
      cacheQueryMs,
      queryMs,
      payloadBytes,
      responseBytes: 0,
      encoding: 'not-modified',
      status: 304,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  res.send(payloadText);
  logApiResponse(req, {
    cacheKey,
    cacheHit: false,
    cacheQueryMs,
    queryMs,
    payloadBytes,
    responseBytes: payloadBytes,
    encoding: 'dynamic',
    status: 200,
    durationMs: Date.now() - startedAt,
  });
}

async function sendApiPayload(req, res, { cacheKey, loadPayload }) {
  const startedAt = Date.now();
  const cacheResult = await getApiResponseCacheEntry(cacheKey);

  if (cacheResult.entry) {
    sendCachedApiPayload(req, res, {
      entry: cacheResult.entry,
      cacheKey,
      cacheQueryMs: cacheResult.queryMs,
      startedAt,
    });
    return;
  }

  const liveQueryStartedAt = Date.now();
  const payload = await loadPayload();
  const queryMs = Date.now() - liveQueryStartedAt;

  sendLiveApiPayload(req, res, {
    payload,
    cacheKey,
    cacheQueryMs: cacheResult.queryMs,
    queryMs,
    startedAt,
  });
}

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
const OPERATOR_SERVICE_URLS = {
  GABS: 'https://www.gabs.co.za/',
  MyCiti: 'https://www.myciti.org.za',
};
const INFO_PAGES = {
  '/about': {
    title: 'About Fika Timetables | Cape Town Bus Timetables',
    heading: 'About Fika Timetables',
    eyebrow: 'About',
    description: 'Learn about Fika Timetables, a simple way to search Golden Arrow and MyCiTi bus timetables for Cape Town commuters.',
    body: [
      'Fika Timetables helps Cape Town commuters search Golden Arrow and MyCiTi bus timetables in one place. The site turns route data into readable pages with route names, directions, stops, service days, and listed trip times.',
      'The project exists because bus timetable information is often split across PDFs, operator pages, and route notices. Fika keeps the everyday lookup task focused: choose a route, compare the available directions, and scan the stop-by-stop timetable.',
      'Viewed timetables can be stored in your browser for offline reference. This is useful during commutes where mobile data is unreliable, but critical journeys should still be confirmed with the relevant transport operator.',
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
      'Fika is an independent timetable viewer and does not operate bus services, sell travel cards, set fares, or issue service alerts. For account, fare, card, lost property, or urgent travel questions, contact the relevant operator directly.',
    ],
  },
  '/privacy-policy': {
    title: 'Privacy Policy | Fika Timetables',
    heading: 'Privacy Policy',
    eyebrow: 'Privacy',
    description: 'Read how Fika Timetables handles offline timetable caching, local browser storage, and timetable lookup privacy.',
    body: [
      'Fika Timetables stores viewed and saved timetables in your browser using IndexedDB so selected timetable data can be available offline.',
      'Fika Timetables uses Google Analytics 4 to understand how visitors use timetable search, route pages, filters, and offline saving so the service can be maintained and improved. Fika relies on its legitimate interest in measuring and improving the service for this processing.',
      'Google Analytics uses a first-party _ga cookie containing a pseudonymous client identifier to distinguish browsers and sessions. It also receives page and interaction events, device and browser details, and approximate location derived from an IP address. Google states that IP addresses are discarded before Analytics logs the data.',
      'Fika does not send raw route-search text, stop names, timetable contents, contact details, URL query strings, or raw error messages to Google Analytics. Advertising storage, Google Signals, and ad personalization are disabled.',
      'If you close the analytics notice, Fika stores that dismissal choice in this browser so the notice does not appear on every visit.',
      'Analytics event-level data is configured for a 14-month retention period. You can block or delete analytics cookies through your browser settings and may contact hello@fika.net.za to object to this processing.',
      'Fika Timetables does not run third-party promotional networks or personalized marketing trackers.',
      'You can manage or delete locally stored timetable data in your browser settings. Clearing site data may remove saved offline timetables.',
      'The site does not require user accounts and does not ask for sensitive personal information. Contact hello@fika.net.za for privacy questions.',
      'Route searches and saved timetable choices are handled in your browser unless they are needed to request timetable data from the server.',
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
      'Fika is independent from Golden Arrow, MyCiTi, and other transport operators unless a future page says otherwise. Operator names and logos are used only to identify the timetable source or service being viewed.',
      'You may use the site for personal timetable lookup. Automated scraping or abusive request patterns are not permitted.',
    ],
  },
  '/data-reliability': {
    title: 'Timetable Source Reliability | Fika Timetables',
    heading: 'Timetable source reliability',
    eyebrow: 'Evidence, not promises',
    description: 'See Fika timetable source fingerprints, review status, official PDF links, daily checks, and weekly source-accuracy audit evidence.',
    body: [
      'Source accuracy means Fika correctly displays the timetable published in the cited operator PDF. Fika checks source fingerprints daily, holds changed extractions for human review, and records weekly sample audits.',
      'Operational punctuality means a bus actually arrives at the published time. Fika does not currently measure live operations and cannot claim to prove punctuality.',
      'The live source registry and latest recorded audit load on this page after the application starts.',
    ],
  },
};

function getRouteLabel(route) {
  return route.code ? `${route.code} - ${route.name}` : route.name;
}

function getRouteDirections(route) {
  return [route.direction_1, route.direction_2].filter(Boolean);
}

function normalizeDirectionName(direction) {
  return String(direction || '').replace(/^to\s+/i, '').trim();
}

function cleanAreaName(value) {
  const cleanedName = String(value || '')
    .replace(/\((?:anti-?clockwise|clockwise)\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (/^mamre\s*\((?:crown|frans)\)$/i.test(cleanedName)) {
    return 'Mamre';
  }

  return cleanedName;
}

function formatAreaName(value) {
  return cleanAreaName(value)
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bSap\b/g, 'SAP');
}

function formatDisplayName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bCbd\b/g, 'CBD')
    .replace(/\bSap\b/g, 'SAP');
}

function getRouteEndpoints(route) {
  const parts = String(route.name || '')
    .split(/\s+-\s+/)
    .map(formatDisplayName)
    .filter(Boolean);

  if (parts.length >= 2) {
    return [parts[0], parts[parts.length - 1]];
  }

  const directions = getRouteDirections(route)
    .map(normalizeDirectionName)
    .map(formatDisplayName)
    .filter(Boolean);

  return directions.length >= 2 ? [directions[0], directions[1]] : [formatDisplayName(route.name)];
}

function getRouteIntentLabel(route) {
  const agencyName = getAgencyDisplayName(route.agency);
  const code = route.code ? ` ${route.code}` : '';
  const endpoints = getRouteEndpoints(route).join(' to ');
  return `${agencyName}${code} ${endpoints} bus times`.replace(/\s+/g, ' ').trim();
}

function getRouteTileLabel(route) {
  const code = route.code ? `${route.code} ` : '';
  return `${code}${getRouteEndpoints(route).join(' to ')}`.replace(/\s+/g, ' ').trim();
}

function getRouteSeoTitle(route) {
  const agencyName = getAgencyDisplayName(route.agency);
  const code = route.code ? ` ${route.code}` : '';
  const endpoints = getRouteEndpoints(route).join('–');
  return `${agencyName}${code} ${endpoints} Bus Times`.replace(/\s+/g, ' ').trim();
}

function formatEffectiveDate(value) {
  if (!value) {
    return '';
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    return [
      value.getFullYear(),
      String(value.getMonth() + 1).padStart(2, '0'),
      String(value.getDate()).padStart(2, '0'),
    ].join('-');
  }

  const dateOnlyMatch = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return dateOnlyMatch ? dateOnlyMatch[1] : '';
}

function getAreaNamesForRoute(route) {
  const routeParts = String(route.name || '').split(/\s+-\s+/);
  const directionParts = getRouteDirections(route)
    .flatMap((direction) => String(direction).split(/\s+-\s+| to /i));

  return [...new Set([...routeParts, ...directionParts]
    .map(cleanAreaName)
    .filter((value) => value.length >= 3))];
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

function getTimetableJsonLd(route, canonicalPath, serviceWindow, stops) {
  const routeLabel = getRouteIntentLabel(route);
  const agencyName = getAgencyDisplayName(route.agency);
  const canonicalUrl = getAbsoluteUrl(canonicalPath);

  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: routeLabel,
      url: canonicalUrl,
      description: getTimetableDescription(route, serviceWindow, stops),
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
      name: routeLabel,
      description: getTimetableDescription(route, serviceWindow, stops),
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

function getTimetableDescription(route, serviceWindow, stops = []) {
  const agencyName = getAgencyDisplayName(route.agency);
  const codeText = route.code ? ` route ${route.code}` : '';
  const endpoints = getRouteEndpoints(route);
  const corridorText = endpoints.length >= 2
    ? ` from ${endpoints[0]} to ${endpoints[1]}`
    : ` for ${endpoints[0] || formatDisplayName(route.name)}`;
  const stopCount = new Set(stops.map((stop) => cleanAreaName(stop.name)).filter(Boolean)).size;
  const timeText = serviceWindow?.first_time && serviceWindow?.last_time
    ? ` Listed times run from ${formatTime(serviceWindow.first_time)} to ${formatTime(serviceWindow.last_time)}`
    : '';
  const stopText = stopCount ? ` across ${stopCount} stops and listed service days` : ' with stops and listed service days';
  const effectiveDate = formatEffectiveDate(route.effective_date);
  const effectiveText = effectiveDate ? ` Effective ${effectiveDate}.` : '';

  return `${agencyName}${codeText}${corridorText}.${timeText}${stopText}.${effectiveText}`;
}

function getHomepageSeo() {
  return {
    title: HOME_TITLE,
    description: HOME_DESCRIPTION,
    canonicalUrl: SITE_URL,
    jsonLd: getHomepageJsonLd(),
  };
}

function getNotFoundSeo(requestPath, title, description) {
  const canonicalUrl = getAbsoluteUrl(requestPath);

  return {
    title,
    description,
    canonicalUrl,
    robots: 'noindex,follow',
    jsonLd: [],
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
  const title = area.slug === 'cape-town'
    ? 'Cape Town Bus Routes & Times | Fika'
    : `${area.name} Bus Times & Timetables | Cape Town`;
  const operators = [...new Set(area.routes.map((route) => getAgencyDisplayName(route.agency)))];
  const destinations = [...new Set(area.routes
    .flatMap(getRouteEndpoints)
    .filter((name) => slugify(name) !== area.slug))]
    .slice(0, 3);
  const destinationText = destinations.length ? ` Popular links include ${destinations.join(', ')}.` : '';
  const description = `${area.routes.length} bus routes serve ${area.name} on ${operators.join(' and ')}.${destinationText}`;

  return {
    title,
    description,
    canonicalUrl,
    robots: area.indexable ? 'index,follow' : 'noindex,follow',
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

function getTimetableSeo(route, serviceWindow, stops) {
  const canonicalPath = getCanonicalTimetablePath(route);
  const title = getRouteSeoTitle(route);

  return {
    title,
    description: getTimetableDescription(route, serviceWindow, stops),
    canonicalUrl: getAbsoluteUrl(canonicalPath),
    jsonLd: getTimetableJsonLd(route, canonicalPath, serviceWindow, stops),
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
  const robots = escapeHtml(seo.robots || 'index,follow');
  const jsonLd = serializeJsonLd(seo.jsonLd);
  const runtimeConfig = JSON.stringify({
    ga4MeasurementId: getGa4MeasurementId(),
  }).replace(/</g, '\\u003c');

  html = replaceOrInsertHeadTag(html, /<title[^>]*>.*?<\/title>/i, `<title>${title}</title>`);
  html = replaceOrInsertHeadTag(html, /<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${description}" />`);
  html = replaceOrInsertHeadTag(html, /<link\s+rel="canonical"[^>]*>/i, `<link rel="canonical" href="${canonicalUrl}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+name="robots"[^>]*>/i, `<meta name="robots" content="${robots}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:title"[^>]*>/i, `<meta property="og:title" content="${title}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:description"[^>]*>/i, `<meta property="og:description" content="${description}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:url"[^>]*>/i, `<meta property="og:url" content="${canonicalUrl}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+property="og:type"[^>]*>/i, '<meta property="og:type" content="website" />');
  html = replaceOrInsertHeadTag(html, /<meta\s+name="twitter:card"[^>]*>/i, '<meta name="twitter:card" content="summary" />');
  html = replaceOrInsertHeadTag(html, /<meta\s+name="twitter:title"[^>]*>/i, `<meta name="twitter:title" content="${title}" />`);
  html = replaceOrInsertHeadTag(html, /<meta\s+name="twitter:description"[^>]*>/i, `<meta name="twitter:description" content="${description}" />`);
  html = replaceOrInsertHeadTag(html, /<script\s+id="seo-jsonld"[^>]*>[\s\S]*?<\/script>/i, `<script id="seo-jsonld" type="application/ld+json">${jsonLd}</script>`);
  html = replaceOrInsertHeadTag(
    html,
    /<script\s+id="fika-runtime-config"[^>]*>[\s\S]*?<\/script>/i,
    `<script id="fika-runtime-config">window.__FIKA_CONFIG__=${runtimeConfig};</script>`
  );
  html = html.replace('<div id="root"></div>', `<div id="root">${bodyHtml}</div>`);

  return html;
}

function getGa4MeasurementId(value = process.env.GA4_MEASUREMENT_ID) {
  const measurementId = String(value || '').trim();
  return GA4_MEASUREMENT_ID_PATTERN.test(measurementId) ? measurementId.toUpperCase() : '';
}

function sendNotFound(req, res, { title, description, eyebrow = 'Not found' }) {
  res.set('X-Robots-Tag', 'noindex, follow');
  res.status(404).send(renderIndexHtml(
    getNotFoundSeo(req.path, title, description),
    renderSeoShell({ eyebrow, title, description })
  ));
}

async function getRouteById(routeId) {
  const { rows } = await pool.query(routeByIdQuery, [routeId]);
  return rows[0];
}

async function getRouteByAgencyAndCode(agency, routeCode) {
  const { rows } = await pool.query(`
    SELECT
      routes.id,
      routes.name,
      routes.code,
      routes.agency,
      routes.effective_date,
      directions.id AS direction_id,
      directions.direction
    FROM routes
    LEFT JOIN directions ON directions.route_id = routes.id
    WHERE routes.agency = $1
      AND lower(routes.code) = lower($2)
    ORDER BY directions.id;
  `, [agency, routeCode]);

  if (!rows.length) {
    return null;
  }

  return {
    id: rows[0].id,
    name: rows[0].name,
    code: rows[0].code,
    agency: rows[0].agency,
    effective_date: rows[0].effective_date,
    direction_1: rows[0]?.direction,
    direction_2: rows[1]?.direction,
  };
}

let routeUrlAliasSchemaPromise = null;

async function ensureRouteAliases() {
  if (!routeUrlAliasSchemaPromise) {
    routeUrlAliasSchemaPromise = ensureRouteUrlAliasSchema(pool).catch((error) => {
      routeUrlAliasSchemaPromise = null;
      throw error;
    });
  }

  return routeUrlAliasSchemaPromise;
}

const timetableRouteRepository = {
  getByAgencyAndCode: getRouteByAgencyAndCode,
  getById: getRouteById,
  async getAlias(legacyPath) {
    await ensureRouteAliases();
    return getRouteUrlAlias(pool, legacyPath);
  },
  async saveAlias(alias) {
    await ensureRouteAliases();
    return saveRouteUrlAlias(pool, alias);
  },
  async findUniqueByNameSlug(agency, nameSlug) {
    const { routes } = await getSeoData();
    const matches = routes.filter((route) =>
      route.agency === agency && slugify(route.name) === nameSlug
    );

    return matches.length === 1 ? matches[0] : null;
  },
};

async function getAllRoutes() {
  const { rows } = await pool.query(schedulesQuery);
  return rows;
}

async function getScheduleTimes(routeId) {
  const { rows } = await pool.query(scheduleTimesQuery, [routeId]);
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
    .map((area) => ({
      ...area,
      indexable: area.routes.length >= MIN_AREA_ROUTE_COUNT || PRIORITY_AREA_SLUGS.has(area.slug),
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

function getFeaturedAreas(areas, limit = MAX_AREA_LINKS) {
  return [...areas]
    .sort((first, second) => {
      const firstPriority = PRIORITY_AREA_ORDER.indexOf(first.slug);
      const secondPriority = PRIORITY_AREA_ORDER.indexOf(second.slug);
      const firstRank = firstPriority === -1 ? Number.MAX_SAFE_INTEGER : firstPriority;
      const secondRank = secondPriority === -1 ? Number.MAX_SAFE_INTEGER : secondPriority;
      return firstRank - secondRank || second.routes.length - first.routes.length || first.name.localeCompare(second.name);
    })
    .slice(0, limit);
}

async function buildSeoData() {
  const routes = await getAllRoutes();
  const areaMap = new Map();

  routes.forEach((route) => {
    getAreaNamesForRoute(route).forEach((areaName) => upsertArea(areaMap, areaName, route));
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

function renderRouteLinks(routes, className = 'seo-link-list', compact = false) {
  if (!routes.length) {
    return '';
  }

  return `<ul class="${className}">${routes.map((route) => (
    `<li><a href="${escapeHtml(getCanonicalTimetablePath(route))}">${escapeHtml(compact ? getRouteTileLabel(route) : getRouteIntentLabel(route))}</a></li>`
  )).join('')}</ul>`;
}

function renderRoutesByOperator(routes) {
  return Object.keys(AGENCY_SLUGS)
    .map((agency) => ({
      agency,
      routes: routes.filter((route) => route.agency === agency),
    }))
    .filter((group) => group.routes.length)
    .map((group) => `
      <section class="seo-route-group">
        <h3>${escapeHtml(getAgencyDisplayName(group.agency))}</h3>
        ${renderRouteLinks(group.routes)}
      </section>
    `)
    .join('');
}

function renderAreaLinks(areas, className = 'seo-link-list') {
  if (!areas.length) {
    return '';
  }

  return `<ul class="${className}">${areas.map((area) => (
    `<li><a href="${escapeHtml(getCanonicalAreaPath(area.name))}">${escapeHtml(area.name)} bus timetables</a></li>`
  )).join('')}</ul>`;
}

function renderStopList(stops) {
  const uniqueStops = [...new Map(stops.map((stop) => [
    `${cleanAreaName(stop.name)}|${stop.direction_name}`,
    {
      name: cleanAreaName(stop.name),
      direction: normalizeDirectionName(stop.direction_name),
    },
  ])).values()]
    .filter((stop) => stop.name)
    .slice(0, MAX_ROUTE_STOPS);

  if (!uniqueStops.length) {
    return '<p>Stop details are not available for this timetable yet.</p>';
  }

  return `<ul class="seo-stop-list">${uniqueStops.map((stop) => (
    `<li><span>${escapeHtml(stop.name)}</span>${stop.direction ? ` <small>${escapeHtml(stop.direction)}</small>` : ''}</li>`
  )).join('')}</ul>`;
}

function renderRouteFacts(route, stops, serviceWindow) {
  const directions = getRouteDirections(route).map(normalizeDirectionName).filter(Boolean);
  const stopCount = new Set(stops.map((stop) => cleanAreaName(stop.name)).filter(Boolean)).size;
  const firstTrip = formatTime(serviceWindow?.first_time) || 'Not listed';
  const lastTrip = formatTime(serviceWindow?.last_time) || 'Not listed';
  const effectiveDate = formatEffectiveDate(route.effective_date) || 'Not supplied';

  return `
    <dl class="seo-fact-list">
      <div><dt>Operator</dt><dd>${escapeHtml(getAgencyDisplayName(route.agency))}</dd></div>
      <div><dt>Route</dt><dd>${escapeHtml(getRouteLabel(route))}</dd></div>
      <div><dt>Directions</dt><dd>${escapeHtml(directions.join(' and ') || 'Direction details available in the timetable')}</dd></div>
      <div><dt>Listed stops</dt><dd>${stopCount || 'Stop count unavailable'}</dd></div>
      <div><dt>First listed trip</dt><dd>${escapeHtml(firstTrip)}</dd></div>
      <div><dt>Last listed trip</dt><dd>${escapeHtml(lastTrip)}</dd></div>
      <div><dt>Effective date</dt><dd>${escapeHtml(effectiveDate)}</dd></div>
    </dl>
  `;
}

function renderSiteFooter() {
  const links = [
    { href: '/operators/myciti', label: 'MyCiTi' },
    { href: '/operators/golden-arrow', label: 'Golden Arrow' },
    { href: '/areas', label: 'Areas' },
    { href: '/saved-timetables', label: 'Saved' },
    { href: '/about', label: 'About' },
    { href: '/data-reliability', label: 'Data reliability' },
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
            ${(section.paragraphs || []).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}
            ${section.html}
          </section>
        `).join('')}
      </section>
      ${renderSiteFooter()}
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
        title: 'Cape Town Timetable Lookup',
        paragraphs: [
          'Fika organizes loaded bus timetable data into route pages with operator names, direction labels, stop sequences, service days, and listed trip times. The site is built for practical commuter lookup rather than republishing static timetable PDFs.',
          'Current coverage focuses on Golden Arrow and MyCiTi services in Cape Town. More South African cities and operators can be added when reliable route and timetable data is available.',
        ],
        html: '',
      },
      {
        title: 'Bus Operators',
        paragraphs: [
          'Start from an operator page when you already know whether the trip is served by Golden Arrow or MyCiTi.',
        ],
        html: `<ul class="seo-link-list">${operatorSections.map((operator) => (
          `<li><a href="${escapeHtml(operator.path)}">${escapeHtml(operator.name)} timetables</a> <span>${operator.count} routes</span></li>`
        )).join('')}</ul>`,
      },
      {
        title: 'Popular Areas',
        paragraphs: [
          'Area pages group route names and direction labels into place-based timetable collections for easier local discovery.',
        ],
        html: renderAreaLinks(getFeaturedAreas(areas)),
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
    description: `${page.description} Fika is an independent timetable viewer and does not replace official operator notices.`,
    sections: [
      {
        title: 'Timetable Coverage',
        paragraphs: [
          `This ${agencyName} page groups the routes currently loaded in Fika so commuters can move from an operator view to a specific timetable page with stop-by-stop times, direction labels, and service-day information.`,
          `For fares, cards, accessibility, disruptions, and urgent service changes, check ${agencyName}${OPERATOR_SERVICE_URLS[agency] ? ` at ${OPERATOR_SERVICE_URLS[agency]}` : ''}.`,
        ],
        html: '',
      },
      {
        title: `${agencyName} Routes`,
        paragraphs: [
          `${routes.length} ${agencyName} route timetable${routes.length === 1 ? '' : 's'} are currently available in this index.`,
        ],
        html: renderRouteLinks(routes, 'seo-link-list', true),
      },
      {
        title: `${agencyName} Areas And Stops`,
        paragraphs: [
          'These area links are generated from loaded route names and direction labels, so some entries may represent an interchange, terminal, or corridor.',
        ],
        html: renderAreaLinks(operatorAreas),
      },
    ],
  });
}

function renderAreaBody(area) {
  const seo = getAreaSeo(area);

  return renderSeoShell({
    eyebrow: 'Cape Town bus area',
    title: seo.title.replace(/\s*\|.*$/, ''),
    description: seo.description,
    sections: [
      {
        title: 'Area Timetable Notes',
        paragraphs: [
          `This area page is built from route names and direction labels in the loaded timetable data. A route may appear for ${area.name} because it starts there, ends there, or links commuters to the area.`,
          'Fika is independent from transport operators. Use these area links for planning and route discovery, then confirm urgent service changes through Golden Arrow or MyCiTi before travelling.',
        ],
        html: '',
      },
      {
        title: `Routes serving ${area.name}`,
        paragraphs: [
          `${area.routes.length} route timetable${area.routes.length === 1 ? '' : 's'} are currently associated with ${area.name}.`,
        ],
        html: renderRoutesByOperator(area.routes),
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
        title: 'How Areas Are Grouped',
        paragraphs: [
          'The area index groups loaded timetable data into place-based pages so commuters can discover routes by suburb, interchange, terminal, or corridor instead of only by route number.',
          'Areas are generated from route names and direction names. Some names may represent a terminal, station, or corridor rather than a municipal suburb boundary.',
        ],
        html: '',
      },
      {
        title: 'Areas And Stops',
        paragraphs: [
          `${areas.length} Cape Town area and stop group${areas.length === 1 ? '' : 's'} are currently indexed.`,
        ],
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
  return renderSeoShell({
    eyebrow: `${agencyName} timetable`,
    title: getRouteSeoTitle(route),
    description: getTimetableDescription(route, serviceWindow, stops),
    sections: [
      {
        title: 'Timetable Summary',
        paragraphs: [
          `${agencyName} ${routeLabel} is shown with route directions, stops, and listed trip times where they are available in the timetable data.`,
          'Fika is independent from transport operators. Always check official service notices for disruptions, fare changes, accessibility updates, and critical trips.',
        ],
        html: renderRouteFacts(route, stops, serviceWindow),
      },
      {
        title: 'Route Areas',
        paragraphs: [
          areas.length
            ? `This timetable is associated with ${areas.map((area) => area.name).slice(0, 4).join(', ')}${areas.length > 4 ? ', and nearby areas' : ''}.`
            : 'Area matches are generated from route and direction names when enough related timetable data is available.',
        ],
        html: renderAreaLinks(areas),
      },
      {
        title: 'Stops On This Timetable',
        paragraphs: [
          stopAreas.length
            ? `Some listed stops also have area pages, including ${stopAreas.map((area) => area.name).slice(0, 4).join(', ')}.`
            : 'The stop list below is generated from the timetable rows for this route.',
        ],
        html: renderStopList(stops),
      },
      {
        title: 'Related Cape Town Routes',
        paragraphs: [
          'Related routes are selected from timetable areas that overlap with this route, which can help when comparing nearby services.',
        ],
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

function buildSitemapXml(routes, areas) {
  const urls = [
    { loc: SITE_URL },
    ...Object.values(AGENCY_SLUGS).map((slug) => ({
      loc: getAbsoluteUrl(`/operators/${slug}`),
    })),
    ...Object.keys(INFO_PAGES).map((pagePath) => ({
      loc: getAbsoluteUrl(pagePath),
    })),
    { loc: getAbsoluteUrl('/areas') },
    ...routes.map((route) => ({
      loc: getAbsoluteUrl(getCanonicalTimetablePath(route)),
      lastmod: formatEffectiveDate(route.effective_date),
    })),
    ...areas.filter((area) => area.indexable).map((area) => ({
      loc: getAbsoluteUrl(getCanonicalAreaPath(area.name)),
      lastmod: area.routes
        .map((route) => formatEffectiveDate(route.effective_date))
        .filter(Boolean)
        .sort()
        .slice(-1)[0],
    })),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((url) => (
      `  <url>\n` +
      `    <loc>${escapeXml(url.loc)}</loc>\n` +
      (url.lastmod ? `    <lastmod>${escapeXml(url.lastmod)}</lastmod>\n` : '') +
      `  </url>`
    )).join('\n') +
    `\n</urlset>\n`;
}

app.get('/schedules', async (req, res) => {
  try {
    await sendApiPayload(req, res, {
      cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.schedulesV1),
      loadPayload: getAllRoutes,
    });
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
    await sendApiPayload(req, res, {
      cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.scheduleTimesV1, id),
      loadPayload: () => getScheduleTimes(id),
    });
  } catch (error) {
    handleQueryError(res, error);
  }
});

app.get('/api/v2/schedule_times/:id', async (req, res) => {
  const { id } = req.params;

  if (!/^\d+$/.test(id)) {
    res.status(400).json({ error: 'Route id must be numeric' });
    return;
  }

  try {
    await sendApiPayload(req, res, {
      cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.scheduleTimesV2, id),
      loadPayload: async () => buildNormalizedTimetablePayload(id, await getScheduleTimes(id)),
    });
  } catch (error) {
    handleQueryError(res, error);
  }
});

app.get('/api/reliability', async (req, res) => {
  try {
    const report = await getPublicReliabilityReport(pool);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.json(report);
  } catch (error) {
    console.error('Unable to load timetable reliability report', error);
    res.status(503).json({ error: 'Timetable reliability evidence is temporarily unavailable.' });
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

app.get('/admin/search-performance', createSearchPerformanceHandler({
  database: pool,
  username: process.env.SEO_REPORT_USERNAME,
  password: process.env.SEO_REPORT_PASSWORD,
}));

app.get('/admin/timetable-reliability', timetableReliabilityHandlers.report);
app.get('/admin/timetable-reliability/section-versions/:id/comparison', timetableReliabilityHandlers.sectionComparison);
app.post('/admin/timetable-reliability/sections/:id/approve', timetableReliabilityForm, timetableReliabilityHandlers.approveSection);
app.post('/admin/timetable-reliability/sections/:id/withdraw', timetableReliabilityForm, timetableReliabilityHandlers.withdrawSection);
app.get('/admin/timetable-reliability/versions/:id/pdf', timetableReliabilityHandlers.pdf);
app.get('/admin/timetable-reliability/versions/:id/comparison', timetableReliabilityHandlers.comparison);
app.post('/admin/timetable-reliability/sources/bulk-approve-unchanged', timetableReliabilityForm, timetableReliabilityHandlers.bulkApproveUnchanged);
app.post('/admin/timetable-reliability/sources/:id/approve', timetableReliabilityForm, timetableReliabilityHandlers.approve);
app.post('/admin/timetable-reliability/sources/:id/withdraw', timetableReliabilityForm, timetableReliabilityHandlers.withdraw);
app.post('/admin/timetable-reliability/audits/:id', timetableReliabilityForm, timetableReliabilityHandlers.audit);

app.get('/sitemap.xml', async (req, res) => {
  const startedAt = Date.now();

  try {
    const { routes, areas } = await getSeoData();
    const sitemap = buildSitemapXml(routes, areas);

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

app.get('/saved-timetables', (req, res) => {
  const seo = {
    title: 'Saved Timetables | Fika Timetables',
    description: 'View bus timetables saved in this browser for offline reference.',
    canonicalUrl: getAbsoluteUrl('/saved-timetables'),
    robots: 'noindex,follow',
    jsonLd: [],
  };

  res.set('X-Robots-Tag', 'noindex, follow');
  res.send(renderIndexHtml(seo, renderSeoShell({
    eyebrow: 'Available in this browser',
    title: 'Saved timetables',
    description: 'Saved timetable details are stored in this browser and appear after the Fika app loads.',
  })));
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
    sendNotFound(req, res, {
      title: 'Operator not found',
      description: 'Select Golden Arrow or MyCiTi to view available Cape Town bus timetables.',
    });
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
      sendNotFound(req, res, {
        title: 'Area not found',
        description: 'This Cape Town bus area is not available yet. Search Fika Timetables for MyCiTi and Golden Arrow routes.',
      });
      return;
    }

    const canonicalPath = getCanonicalAreaPath(area.name);

    if (req.path !== canonicalPath) {
      res.redirect(301, canonicalPath);
      return;
    }

    logSlowSeoRender(`GET /areas/${req.params.areaSlug}`, startedAt);
    if (!area.indexable) {
      res.set('X-Robots-Tag', 'noindex, follow');
    }
    res.send(renderIndexHtml(getAreaSeo(area), renderAreaBody(area)));
  } catch (error) {
    console.error('Error rendering area page', error);
    res.status(500).send(renderIndexHtml(getHomepageSeo()));
  }
});

app.get('/timetables/:agency/:routeSlug', async (req, res) => {
  const startedAt = Date.now();

  try {
    const [resolution, seoData] = await Promise.all([
      resolveTimetableRoute({
        agencySlug: req.params.agency,
        routeSlug: req.params.routeSlug,
        requestPath: req.path,
      }, timetableRouteRepository),
      getSeoData(),
    ]);

    if (resolution.status === 'not-found') {
      sendNotFound(req, res, {
        title: 'Timetable not found',
        description: 'This timetable URL is not available. Search Fika Timetables for MyCiTi and Golden Arrow routes.',
      });
      return;
    }

    if (resolution.status === 'redirect') {
      res.redirect(301, resolution.canonicalPath);
      return;
    }

    const route = resolution.route;

    const [stops, serviceWindow] = await Promise.all([
      getRouteStops(route.id),
      getRouteServiceWindow(route.id),
    ]);
    const relatedRoutes = getRelatedRoutes(route, seoData.routes);

    logSlowSeoRender(`GET /timetables/${req.params.agency}/${req.params.routeSlug}`, startedAt);
    res.send(renderIndexHtml(
      getTimetableSeo(route, serviceWindow, stops),
      renderTimetableBody(route, stops, serviceWindow, relatedRoutes, seoData.areas)
    ));
  } catch (error) {
    console.error('Error rendering timetable route', error);
    res.status(500).send(renderIndexHtml(getHomepageSeo()));
  }
});

app.use(express.static(CLIENT_BUILD_DIR, { index: false }));

app.get('*', (req, res) => {
  sendNotFound(req, res, {
    title: 'Page not found',
    description: 'This Fika Timetables page is not available. Browse Golden Arrow and MyCiTi routes from the homepage.',
  });
});

async function startServer() {
  await ensureRouteAliases();
  return app.listen(PORT, () => {
    console.log(`Fika server listening on port ${PORT}`);
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error('Unable to initialize Fika database schema', error);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  buildSitemapXml,
  cleanAreaName,
  CONTENT_SECURITY_POLICY_DIRECTIVES,
  finalizeAreas,
  formatEffectiveDate,
  getAreaNamesForRoute,
  getAreaSeo,
  getCanonicalAreaPath,
  getFeaturedAreas,
  getGa4MeasurementId,
  isAllowedCorsOrigin,
  getRouteSeoTitle,
  getTimetableDescription,
  getTimetableSeo,
  renderIndexHtml,
  shouldApplyCors,
  startServer,
};
