export const AGENCY_DISPLAY_NAMES = {
  GABS: 'Golden Arrow',
  MyCiti: 'MyCiTi',
};

export const AGENCY_SLUGS = {
  GABS: 'golden-arrow',
  MyCiti: 'myciti',
};

export const AGENCY_FROM_SLUG = Object.entries(AGENCY_SLUGS).reduce((result, [agency, slug]) => {
  result[slug] = agency;
  return result;
}, {});

export const getAgencyDisplayName = (agency) => AGENCY_DISPLAY_NAMES[agency] || agency;

export const slugify = (value) => {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'route';
};

export const getAgencySlug = (agency) => AGENCY_SLUGS[agency] || slugify(agency);

export const getTimetablePath = (route) => {
  if (!route) {
    return '/';
  }

  return `/timetables/${getAgencySlug(route.agency)}/route-${slugify(route.code)}-${slugify(route.name)}`;
};

export const getRouteLocatorFromPath = (pathname) => {
  const canonicalMatch = pathname.match(/^\/timetables\/([^/]+)\/route-([a-z0-9]+)(?:-|$)/i);

  if (canonicalMatch) {
    return {
      agency: AGENCY_FROM_SLUG[canonicalMatch[1].toLowerCase()] || null,
      code: canonicalMatch[2],
    };
  }

  const legacyMatch = pathname.match(/^\/timetables\/[^/]+\/(\d+)(?:-|$)/);
  return legacyMatch ? { id: Number(legacyMatch[1]) } : null;
};

export const getRouteIdFromPath = (pathname) => getRouteLocatorFromPath(pathname)?.id || null;

export const getOperatorAgencyFromPath = (pathname) => {
  const match = pathname.match(/^\/operators\/([^/]+)$/);
  return match ? AGENCY_FROM_SLUG[match[1]] : null;
};

export const getAreaSlugFromPath = (pathname) => {
  const match = pathname.match(/^\/areas\/([^/]+)$/);
  return match ? match[1] : null;
};

export const isAreasIndexPath = (pathname) => pathname === '/areas';

export const getAvailableRouteCount = (routes = []) => {
  const routeKeys = new Set();

  (routes || []).forEach((route) => {
    if (!route) return;
    const hasId = route.id !== null && route.id !== undefined && route.id !== '';
    routeKeys.add(hasId
      ? `id:${route.id}`
      : `route:${route.agency || ''}:${route.code || ''}:${route.name || ''}`
    );
  });

  return routeKeys.size;
};

export const getRouteCountLabel = (count) => {
  if (!count) {
    return 'Route timetables';
  }

  return `${count} route timetable${count === 1 ? '' : 's'}`;
};

export const getRouteLabel = (route) => {
  return route?.code ? `${route.code} - ${route.name}` : route?.name;
};

export const getRouteDirections = (route) => {
  return [route?.direction_1, route?.direction_2].filter(Boolean);
};

export const normalizeDirectionLabel = (direction) => {
  if (!direction) {
    return direction;
  }

  return String(direction).replace(/^to\s+/i, '').trim();
};

export const titleizeSlug = (slug) => String(slug || '')
  .split('-')
  .filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

export const cleanAreaName = (value) => {
  const cleanedName = String(value || '')
    .replace(/\((?:anti-?clockwise|clockwise)\)/ig, '')
    .replace(/\s+/g, ' ')
    .trim();

  return /^mamre\s*\((?:crown|frans)\)$/i.test(cleanedName) ? 'Mamre' : cleanedName;
};

export const formatRoutePlace = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()
  .replace(/\b\w/g, (letter) => letter.toUpperCase())
  .replace(/\bCbd\b/g, 'CBD')
  .replace(/\bSap\b/g, 'SAP');

export const getRouteEndpoints = (route) => {
  const parts = String(route?.name || '').split(/\s+-\s+/).map(formatRoutePlace).filter(Boolean);
  return parts.length >= 2 ? [parts[0], parts[parts.length - 1]] : parts;
};

const parseRoutePresentation = (value) => {
  const normalized = String(value || '').replace(/^to\s+/i, '').trim();
  const [journey, ...viaParts] = normalized.split(/\s+via\s+/i);
  const places = journey.split(/\s+(?:[-–—]|→|to)\s+/i).map(formatRoutePlace).filter(Boolean);
  const intermediate = viaParts.length
    ? viaParts.join(' via ').split(/\s+[-–—]\s+/).map(formatRoutePlace).filter(Boolean)
    : places.slice(1, -1);

  return {
    origin: places[0] || '',
    destination: places.length > 1 ? places[places.length - 1] : '',
    intermediate,
  };
};

const matchingVia = (first, second) => {
  const normalize = (places) => places.map((place) => place.toLowerCase());
  const left = normalize(first);
  const right = normalize(second);
  return JSON.stringify(left) === JSON.stringify(right) ||
    JSON.stringify(left) === JSON.stringify([...right].reverse());
};

export const getDirectionDestination = (route, direction) => {
  const directionName = typeof direction === 'string' ? direction : direction?.name || direction?.direction;
  const selected = parseRoutePresentation(String(directionName || route?.name || '').trim());
  return selected.destination || selected.origin;
};

// Presentation is deliberately separate from the original names used by URLs and SEO.
export const getRoutePresentation = (route, direction) => {
  const base = parseRoutePresentation(route?.name);
  const directions = getRouteDirections(route).map(parseRoutePresentation);
  const metadataVia = directions.map((item) => item.intermediate);
  const hasMetadataVia = metadataVia.some((places) => places.length > 0);
  let sharedVia = hasMetadataVia
    ? (metadataVia.every((places) => matchingVia(places, metadataVia[0])) ? metadataVia[0] : [])
    : base.intermediate;
  if (hasMetadataVia && directions[0]?.destination.toLowerCase() === base.origin.toLowerCase()) {
    sharedVia = [...sharedVia].reverse();
  }
  const directionName = typeof direction === 'string' ? direction : direction?.name || direction?.direction;
  const selected = directionName ? parseRoutePresentation(directionName) : base;
  let origin = selected.origin || base.origin;
  let destination = selected.destination;

  if (directionName && !destination && base.destination) {
    // Some catalogues store only “To Destination” as the direction name.
    const target = selected.origin.toLowerCase();
    if (target === base.origin.toLowerCase() || target === base.destination.toLowerCase()) {
      origin = target === base.origin.toLowerCase() ? base.destination : base.origin;
      destination = selected.origin;
    } else {
      return { origin: '', destination: selected.origin, via: '', label: formatRoutePlace(directionName) };
    }
  }

  let intermediate = directionName && selected.intermediate.length
    ? selected.intermediate
    : sharedVia;
  if (directionName && !selected.intermediate.length && origin.toLowerCase() === base.destination.toLowerCase()) {
    intermediate = [...intermediate].reverse();
  }

  return {
    origin,
    destination,
    via: intermediate.join(' · '),
    label: [origin, destination].filter(Boolean).join(' → '),
  };
};

export const filterRoutes = (routes = [], query = '', agency = '') => {
  const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  return (routes || []).filter((route) => {
    if (!route || (agency && route.agency !== agency)) return false;
    const searchable = [route.code, route.name, route.agency, getAgencyDisplayName(route.agency), ...getRouteDirections(route)]
      .filter(Boolean).join(' ').toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
};

export const getRouteIntentLabel = (route) => {
  const code = route?.code ? ` ${route.code}` : '';
  return `${getAgencyDisplayName(route?.agency)}${code} ${getRouteEndpoints(route).join(' to ')} bus times`
    .replace(/\s+/g, ' ')
    .trim();
};

export const getRouteTileLabel = (route) => {
  const code = route?.code ? `${route.code} ` : '';
  return `${code}${getRouteEndpoints(route).join(' to ')}`
    .replace(/\s+/g, ' ')
    .trim();
};

export const getRouteSeoTitle = (route) => {
  const code = route?.code ? ` ${route.code}` : '';
  return `${getAgencyDisplayName(route?.agency)}${code} ${getRouteEndpoints(route).join('–')} Bus Times`
    .replace(/\s+/g, ' ')
    .trim();
};

export const getRouteAreaNames = (route) => {
  const routeParts = String(route?.name || '').split(/\s+-\s+/);
  const directionParts = getRouteDirections(route)
    .flatMap((direction) => String(direction).split(/\s+-\s+| to /i));

  return [...new Set([...routeParts, ...directionParts]
    .map(cleanAreaName)
    .filter((value) => value.length >= 3))];
};
