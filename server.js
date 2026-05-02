const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ADSENSE_PUBLISHER_ID = process.env.ADSENSE_PUBLISHER_ID || '';
const CLIENT_BUILD_DIR = path.join(__dirname, 'client', 'build');
const CLIENT_PUBLIC_DIR = path.join(__dirname, 'client', 'public');
const INDEX_HTML_PATH = path.join(CLIENT_BUILD_DIR, 'index.html');
const PUBLIC_INDEX_HTML_PATH = path.join(CLIENT_PUBLIC_DIR, 'index.html');

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

const HOME_TITLE = 'Fika Timetables | Cape Town Bus Timetables';
const HOME_DESCRIPTION = 'Search Cape Town bus timetables for Golden Arrow and MyCiTi routes. Fika helps commuters find route times quickly, with more South African cities and provinces planned.';
const INFO_PAGES = {
  '/about': {
    title: 'About Fika Timetables | Cape Town Bus Timetables',
    description: 'Learn about Fika Timetables, a simple way to search Golden Arrow and MyCiTi bus timetables for Cape Town commuters.',
  },
  '/contact': {
    title: 'Contact Fika Timetables',
    description: 'Contact Fika Timetables for timetable feedback, data questions, and site enquiries.',
  },
  '/privacy-policy': {
    title: 'Privacy Policy | Fika Timetables',
    description: 'Read how Fika Timetables handles local offline timetable caching, analytics, cookies, and future advertising disclosures.',
  },
  '/terms': {
    title: 'Terms and Disclaimer | Fika Timetables',
    description: 'Review the Fika Timetables terms, timetable accuracy disclaimer, and acceptable use guidance.',
  },
};

function getAgencyDisplayName(agency) {
  return AGENCY_DISPLAY_NAMES[agency] || agency;
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

function getAgencySlug(agency) {
  return slugify(agency);
}

function getRouteLabel(route) {
  return route.code ? `${route.code} - ${route.name}` : route.name;
}

function getRouteDirections(route) {
  return [route.direction_1, route.direction_2].filter(Boolean);
}

function getCanonicalTimetablePath(route) {
  return `/timetables/${getAgencySlug(route.agency)}/${route.id}-${slugify(route.name)}`;
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
          item: canonicalUrl,
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

function getTimetableDescription(route) {
  const agencyName = getAgencyDisplayName(route.agency);
  const routeLabel = getRouteLabel(route);
  const directions = getRouteDirections(route);
  const directionText = directions.length
    ? `, including trips to ${directions.join(' and ')}`
    : '';

  return `View the ${agencyName} ${routeLabel} bus timetable in Cape Town${directionText}. Find route times quickly on Fika.`;
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

function getTimetableSeo(route) {
  const canonicalPath = getCanonicalTimetablePath(route);
  const agencyName = getAgencyDisplayName(route.agency);
  const routeLabel = getRouteLabel(route);

  return {
    title: `${agencyName} ${routeLabel} Timetable | Fika`,
    description: getTimetableDescription(route),
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

function renderIndexHtml(seo) {
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

  return html;
}

async function getRouteById(routeId) {
  const { rows } = await pool.query(routeByIdQuery, [routeId]);
  return rows[0];
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
  try {
    const { rows } = await pool.query(schedulesQuery);
    const urls = [
      {
        loc: SITE_URL,
        priority: '1.0',
      },
      ...rows.map((route) => ({
        loc: getAbsoluteUrl(getCanonicalTimetablePath(route)),
        priority: '0.8',
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

app.get('/', (req, res) => {
  res.send(renderIndexHtml(getHomepageSeo()));
});

Object.keys(INFO_PAGES).forEach((pagePath) => {
  app.get(pagePath, (req, res) => {
    res.send(renderIndexHtml(getInfoPageSeo(pagePath)));
  });
});

app.get('/timetables/:agency/:routeSlug', async (req, res) => {
  const routeIdMatch = req.params.routeSlug.match(/^(\d+)(?:-|$)/);

  if (!routeIdMatch) {
    res.status(404).send(renderIndexHtml(getHomepageSeo()));
    return;
  }

  try {
    const route = await getRouteById(routeIdMatch[1]);

    if (!route) {
      res.status(404).send(renderIndexHtml(getHomepageSeo()));
      return;
    }

    const canonicalPath = getCanonicalTimetablePath(route);

    if (req.path !== canonicalPath) {
      res.redirect(301, canonicalPath);
      return;
    }

    res.send(renderIndexHtml(getTimetableSeo(route)));
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
