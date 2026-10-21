import React, { useState, useEffect, useRef, useMemo } from 'react';
import SchedulesDropdown from './SchedulesDropdown';
import ScheduleTable from './ScheduleTable';
import ServiceDayPicker from './ServiceDayPicker';
import Navbar from './Navbar';
import { AreaPage, AreasIndexPage } from './AreaPages';
import InfoPage, { INFO_PAGES } from './InfoPage';
import OperatorPage from './OperatorPage';
import RouteLinkList from './RouteLinkList';
import TimetableStatusNotice, { capeTownDay, getRouteStatus, useTimetableStatus } from './TimetableStatus';
import SiteFooter from './SiteFooter';
import SavedTimetablesPage from './SavedTimetablesPage';
import {
  getOnlineState,
  trackEvent,
  trackPageView,
  trackTimetableView,
} from './analytics';
import {
  filterRoutes,
  getDirectionDestination,
  getAgencyDisplayName,
  getAvailableRouteCount,
  getAreaSlugFromPath,
  getOperatorAgencyFromPath,
  getRouteAreaNames,
  getRouteCountLabel,
  getRouteDirections,
  getRouteSeoTitle,
  getRouteLocatorFromPath,
  getTimetablePath,
  isAreasIndexPath,
  normalizeDirectionLabel,
  slugify,
  titleizeSlug,
} from './routeUtils';
import {
  getCachedSchedules,
  getCachedTimetable,
  findSavedTimetableByLocator,
  saveSchedulesToCache,
  saveTimetableToCache,
  setTimetableSaved,
  touchTimetable,
} from './timetableCache';
import './App.css';

const SERVICE_DAYS = [
  { key: 'monday', label: 'Monday' },
  { key: 'tuesday', label: 'Tuesday' },
  { key: 'wednesday', label: 'Wednesday' },
  { key: 'thursday', label: 'Thursday' },
  { key: 'friday', label: 'Friday' },
  { key: 'saturday', label: 'Saturday' },
  { key: 'sunday', label: 'Sunday' },
  { key: 'public_holiday', label: 'Public Holiday' },
];

const FEATURED_AREA_LIMIT = 10;
const SEARCH_PRIORITY_AREA_SLUGS = [
  'atlantis',
  'mamre',
  'claremont',
  'khayelitsha',
  'cape-town',
  'delft',
  'bellville',
  'heideveld',
];
const AREA_LABEL_OVERRIDES = {
  bluedowns: 'Blue Downs',
};

const LOCAL_API_PORT = '4000';
const LOCAL_API_BASE_URL = `http://localhost:${LOCAL_API_PORT}`;
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? '' : LOCAL_API_BASE_URL);

const getInitialRouteLocator = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  return getRouteLocatorFromPath(window.location.pathname);
};

const getCurrentPath = () => {
  if (typeof window === 'undefined') {
    return '/';
  }

  if (window.location.pathname === '/data-reliability') {
    window.history.replaceState({}, '', '/');
    return '/';
  }
  return window.location.pathname;
};

const routeMatchesLocator = (route, locator) => {
  if (!route || !locator) {
    return false;
  }

  if (locator.agency && locator.code) {
    return route.agency === locator.agency &&
      String(route.code || '').toLowerCase() === String(locator.code).toLowerCase();
  }

  return Number(route.id) === Number(locator.id);
};

const updateBrowserPath = (nextPath, replace = false) => {
  if (typeof window === 'undefined' || window.location.pathname === nextPath) {
    return;
  }

  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({}, '', nextPath);
};

const getCurrentHostApiBaseUrl = () => {
  if (typeof window === 'undefined') {
    return LOCAL_API_BASE_URL;
  }

  return `${window.location.protocol}//${window.location.hostname}:${LOCAL_API_PORT}`;
};

const fetchApiJson = async (endpoint, errorMessage) => {
  const fetchJson = async (baseUrl) => {
    // IndexedDB supplies the immediate/offline response. Always revalidate the HTTP
    // response in the background so imported routes appear without a manual cache clear.
    const response = await fetch(`${baseUrl}${endpoint}`, { cache: 'no-cache' });
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      throw new Error(errorMessage);
    }

    if (!contentType.includes('application/json')) {
      throw new Error(`${errorMessage}: expected JSON but received ${contentType || 'an unknown response type'}`);
    }

    return response.json();
  };

  const candidateBaseUrls = [
    API_BASE_URL,
    '',
    getCurrentHostApiBaseUrl(),
    LOCAL_API_BASE_URL,
  ].filter((baseUrl, index, urls) => urls.indexOf(baseUrl) === index);

  let lastError;

  for (const baseUrl of candidateBaseUrls) {
    try {
      return await fetchJson(baseUrl);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(errorMessage);
};

const groupBy = (array, key) => {
  return array.reduce((result, currentValue) => {
    const keyValue = currentValue[key];

    if (!result[keyValue]) {
      result[keyValue] = [];
    }

    result[keyValue].push(currentValue);

    return result;
  }, {});
};

const normalizeScheduleRoutes = (routes) => {
  return (routes || []).map((schedule) => ({
    ...schedule,
    direction_1: normalizeDirectionLabel(schedule.direction_1),
    direction_2: normalizeDirectionLabel(schedule.direction_2),
  }));
};

const normalizeTimetableRows = (rows) => {
  return (rows || []).map((row) => ({
    ...row,
    direction_name: normalizeDirectionLabel(row.direction_name),
  }));
};

const compareTrips = (firstTrip, secondTrip) => {
  const firstPattern = firstTrip.service_pattern || '';
  const secondPattern = secondTrip.service_pattern || '';
  const patternComparison = secondPattern.localeCompare(firstPattern);

  if (patternComparison !== 0) {
    return patternComparison;
  }

  const firstArrival = firstTrip.first_arrival || '';
  const secondArrival = secondTrip.first_arrival || '';
  const arrivalComparison = firstArrival.localeCompare(secondArrival);

  if (arrivalComparison !== 0) {
    return arrivalComparison;
  }

  return Number(firstTrip.trip_id) - Number(secondTrip.trip_id);
};

const getLegacyTripMetadata = (stopTime) => {
  const trip = {
    trip_id: Number(stopTime.trip_id),
    service_pattern: stopTime.service_pattern || '',
    first_arrival: stopTime.first_arrival || '',
  };

  SERVICE_DAYS.forEach((day) => {
    if (stopTime[day.key]) {
      trip[day.key] = true;
    }
  });

  return trip;
};

const getLegacyStopTimeCell = (stopTime) => {
  const cell = {
    trip_id: Number(stopTime.trip_id),
  };

  if (stopTime.arrival) {
    cell.arrival = stopTime.arrival;
  }

  if (stopTime.stop_time_type) {
    cell.stop_time_type = stopTime.stop_time_type;
  }

  return cell;
};

const buildTimetablePayloadFromLegacyRows = (rows) => {
  const normalizedRows = normalizeTimetableRows(rows);

  return {
    version: 2,
    directions: Object.entries(groupBy(normalizedRows, 'direction_name')).map(([directionName, directionRows]) => {
      const tripById = new Map();

      const normalizedDirectionRows = directionRows.map((row) => {
        const stopTimes = (row.stop_times || []).map((stopTime) => {
          const tripId = Number(stopTime.trip_id);

          if (!tripById.has(tripId)) {
            tripById.set(tripId, getLegacyTripMetadata(stopTime));
          }

          return getLegacyStopTimeCell(stopTime);
        });

        return {
          name: row.name,
          sequence: Number(row.sequence) || 0,
          stop_times: stopTimes,
        };
      });

      return {
        id: directionRows[0]?.directions_id == null ? null : Number(directionRows[0].directions_id),
        name: directionName,
        code: directionRows[0]?.direction_code,
        trips: [...tripById.values()].sort(compareTrips),
        rows: normalizedDirectionRows,
      };
    }),
  };
};

const normalizeTimetablePayload = (payload) => {
  if (payload?.version === 2 && Array.isArray(payload.directions)) {
    return {
      ...payload,
      directions: payload.directions.map((direction) => ({
        ...direction,
        name: normalizeDirectionLabel(direction.name),
        trips: (direction.trips || [])
          .map((trip) => ({
            ...trip,
            trip_id: Number(trip.trip_id),
          }))
          .sort(compareTrips),
        rows: (direction.rows || []).map((row) => ({
          ...row,
          sequence: Number(row.sequence) || 0,
          stop_times: (row.stop_times || []).map((stopTime) => ({
            ...stopTime,
            trip_id: Number(stopTime.trip_id),
          })),
        })),
      })),
    };
  }

  return buildTimetablePayloadFromLegacyRows(Array.isArray(payload) ? payload : []);
};

const buildScheduleData = (payload) => {
  const normalizedPayload = normalizeTimetablePayload(payload);

  return normalizedPayload.directions.reduce((result, direction) => {
    result[direction.name] = {
      ...direction,
      trips: direction.trips || [],
      rows: direction.rows || [],
    };

    return result;
  }, {});
};

const hasTimetableDirections = (payload) => {
  const normalizedPayload = normalizeTimetablePayload(payload);

  return normalizedPayload.directions.some((direction) =>
    (direction.trips || []).length > 0 && (direction.rows || []).length > 0
  );
};

const hasRouteMetadataChanged = (currentRoute, nextRoute) => {
  if (!currentRoute || !nextRoute) {
    return currentRoute !== nextRoute;
  }

  return [
    'name',
    'code',
    'agency',
    'effective_date',
    'direction_1',
    'direction_2',
  ].some((key) => currentRoute[key] !== nextRoute[key]);
};

const getFeaturedAreaLinks = (schedules) => {
  const coverageBySlug = new Map();

  (schedules || []).forEach((schedule) => {
    const routeAreaSlugs = new Set(getRouteAreaNames(schedule).map(slugify));

    routeAreaSlugs.forEach((areaSlug) => {
      coverageBySlug.set(areaSlug, (coverageBySlug.get(areaSlug) || 0) + 1);
    });
  });

  return [...coverageBySlug.entries()]
    .map(([areaSlug, routeCount]) => ({
      areaSlug,
      label: AREA_LABEL_OVERRIDES[areaSlug] || titleizeSlug(areaSlug),
      routeCount,
    }))
    .sort((first, second) => {
      const firstPriority = SEARCH_PRIORITY_AREA_SLUGS.indexOf(first.areaSlug);
      const secondPriority = SEARCH_PRIORITY_AREA_SLUGS.indexOf(second.areaSlug);
      const firstRank = firstPriority === -1 ? Number.MAX_SAFE_INTEGER : firstPriority;
      const secondRank = secondPriority === -1 ? Number.MAX_SAFE_INTEGER : secondPriority;

      return firstRank - secondRank ||
        second.routeCount - first.routeCount ||
        first.label.localeCompare(second.label);
    })
    .slice(0, FEATURED_AREA_LIMIT);
};

function TimetableStatePanel({ title, message, loading = false }) {
  return (
    <div className={`table-state-panel ${loading ? 'loading' : ''}`.trim()}>
      <div className="table-state-copy">
        <h1>{title}</h1>
        <p>{message}</p>
      </div>
      <div className="table-state-preview" aria-hidden="true">
        <div className="table-state-preview-header">
          <span />
          <span />
          <span />
          <span />
        </div>
        {Array.from({ length: 6 }, (_, rowIndex) => (
          <div className="table-state-preview-row" key={rowIndex}>
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}

function LandingPage({
  route,
  schedules,
  selectedAgency,
  loadingSchedules,
  onAgencyChange,
  onRouteSelect,
}) {
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(24);
  const matchingRoutes = filterRoutes(schedules, query, selectedAgency);
  useEffect(() => { setVisibleCount(24); }, [query, selectedAgency]);
  const agencies = [...new Set(schedules.map((schedule) => schedule.agency))].filter(Boolean);
  const availableAgencies = agencies.map(getAgencyDisplayName).join(' and ');
  const featuredAreaLinks = getFeaturedAreaLinks(schedules);

  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-eyebrow">Cape Town bus timetables</p>
          <h1>Find the bus timetable you need.</h1>
          <p>
            Search Golden Arrow and MyCiTi route timetables in one place. Fika organizes route
            names, directions, stops, and service-day patterns into pages that are easier to scan
            than static timetable PDFs. {getRouteCountLabel(getAvailableRouteCount(schedules))} for Cape Town bus commuters.
          </p>
        </div>

        <div className="landing-search-panel">
          <p className="landing-search-label">Search for a timetable</p>
          {loadingSchedules ? (
            <div className="route-list-loading">Loading routes...</div>
          ) : (
            <SchedulesDropdown
              className="landing-schedule-picker"
              placeholder="Search by route, area, or route number"
              route={route}
              schedules={schedules}
              selectedAgency={selectedAgency}
              onAgencyChange={onAgencyChange}
              onRouteSelect={onRouteSelect}
              searchLocation="landing_search"
              query={query}
              onQueryChange={setQuery}
            />
          )}
          <p id="landing-search-helper">
            Available now: {availableAgencies || 'Cape Town bus services'}.
          </p>
        </div>
      </section>

      {featuredAreaLinks.length > 0 && (
        <section className="area-link-band" aria-label="Popular Cape Town bus areas">
          {featuredAreaLinks.map(({ areaSlug, label, routeCount }) => (
            <a key={areaSlug} href={`/areas/${areaSlug}`} title={`${routeCount} routes serve ${label}`}>
              {label}
            </a>
          ))}
        </section>
      )}

      <section className="home-routes" aria-labelledby="home-routes-title">
        <div className="home-routes-heading">
          <h2 id="home-routes-title">{query.trim() ? 'Matching routes' : 'Browse routes'}</h2>
          <p role="status">{matchingRoutes.length} routes{selectedAgency ? ` · ${getAgencyDisplayName(selectedAgency)}` : ' · All operators'}</p>
        </div>
        {loadingSchedules ? <p>Loading routes...</p> : <>
          <RouteLinkList routes={matchingRoutes.slice(0, visibleCount)}
            emptyMessage="No routes match. Try another area, route number, or operator."
            selectionSource="landing_routes" onRouteSelect={onRouteSelect} />
          {visibleCount < matchingRoutes.length && <button className="show-more-routes" type="button"
            onClick={() => setVisibleCount((count) => count + 24)}>Show more routes</button>}
        </>}
      </section>

      <section className="commuter-guide-band" aria-label="Cape Town timetable notes">
        <article>
          <h2>Built for Cape Town bus commuters</h2>
          <p>
            Fika focuses on timetable lookup for local bus travel, with separate pages for
            operators, areas, and individual routes. Each route page keeps the operator name,
            route label, direction, stop sequence, and service days together.
          </p>
        </article>
        <article>
          <h2>Readable route pages</h2>
          <p>
            Timetable pages show the stops served by a route and the listed trip times for the
            selected direction and day. When a timetable has been opened before, it can also be
            saved in the browser for offline reference.
          </p>
        </article>
        <article>
          <h2>Independent timetable viewer</h2>
          <p>
            Fika is not an official transport operator. For fares, disruptions, cards, and urgent
            service notices, check the relevant Golden Arrow or MyCiTi channels before travelling.
          </p>
        </article>
      </section>
    </main>
  );
}

function App() {
  const [scheduleData, setScheduleData] = useState(null);
  const [timetablePayload, setTimetablePayload] = useState(null);
  const [schedules, setSchedules] = useState([]);
  const [route, setRoute] = useState(null);
  const [loadingSchedules, setLoadingSchedules] = useState(true);
  const [loadingTimes, setLoadingTimes] = useState(false);
  const [selectedAgency, setSelectedAgency] = useState('');
  const [selectedDirection, setSelectedDirection] = useState('');
  const [selectedServiceDay, setSelectedServiceDay] = useState(capeTownDay);
  const [hasOpenedTimetableView, setHasOpenedTimetableView] = useState(false);
  const [timetableMessage, setTimetableMessage] = useState('');
  const [offlineSaveMessage, setOfflineSaveMessage] = useState('');
  const [routeSavedOffline, setRouteSavedOffline] = useState(false);
  const [timetableDataSource, setTimetableDataSource] = useState('');
  const [timetableViewKey, setTimetableViewKey] = useState('');
  const [requestedRouteLocator, setRequestedRouteLocator] = useState(getInitialRouteLocator);
  const [currentPath, setCurrentPath] = useState(getCurrentPath);
  const routeViewSequence = useRef(0);
  const failedRouteLocators = useRef(new Set());

  const clearTimetableSelection = ({ showWorkspace = false, message = '' } = {}) => {
    setRoute(null);
    setScheduleData(null);
    setTimetablePayload(null);
    setSelectedDirection('');
    setSelectedServiceDay(capeTownDay());
    setRouteSavedOffline(false);
    setTimetableDataSource('');
    setOfflineSaveMessage('');
    setTimetableMessage(message);
    setHasOpenedTimetableView(showWorkspace);
  };

  const selectRoute = (
    selectedRoute,
    { updateUrl = true, replaceUrl = false, selectionSource = '' } = {}
  ) => {
    if (!selectedRoute) {
      return;
    }

    setRequestedRouteLocator({
      id: Number(selectedRoute.id),
      agency: selectedRoute.agency,
      code: selectedRoute.code,
    });
    setRoute(selectedRoute);
    setSelectedAgency(selectedRoute.agency);
    setSelectedDirection(getRouteDirections(selectedRoute)[0] || '');
    setSelectedServiceDay(capeTownDay());
    setTimetableMessage('');
    setOfflineSaveMessage('');
    setHasOpenedTimetableView(true);
    routeViewSequence.current += 1;
    setTimetableViewKey(`${selectedRoute.id}-${routeViewSequence.current}`);

    if (selectionSource) {
      trackEvent('route_selected', {
        agency: selectedRoute.agency,
        route_code: selectedRoute.code || 'unknown',
        selection_source: selectionSource,
      });
    }

    if (updateUrl) {
      const timetablePath = getTimetablePath(selectedRoute);
      updateBrowserPath(timetablePath, replaceUrl);
      setCurrentPath(timetablePath);
      window.scrollTo({ top: 0 });
    }
  };

  useEffect(() => {
    let ignore = false;

    const fetchSchedules = async () => {
      const cachedSchedules = await getCachedSchedules();

      if (!ignore && cachedSchedules?.data?.length) {
        const cachedScheduleData = normalizeScheduleRoutes(cachedSchedules.data);

        setSchedules(cachedScheduleData);
        setLoadingSchedules(false);
      }

      try {
        const data = normalizeScheduleRoutes(await fetchApiJson('/schedules', 'Unable to fetch schedules'));

        if (ignore) {
          return;
        }

        setSchedules(data);
        await saveSchedulesToCache(data);
      } catch (error) {
        console.error('Error fetching schedules:', error);
      } finally {
        if (!ignore) {
          setLoadingSchedules(false);
        }
      }
    };

    fetchSchedules();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setCurrentPath(window.location.pathname);
      const nextRouteLocator = getRouteLocatorFromPath(window.location.pathname);
      setRequestedRouteLocator(nextRouteLocator);

      if (!nextRouteLocator) {
        clearTimetableSelection();
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    let ignore = false;

    if (!requestedRouteLocator) {
      return undefined;
    }

    const requestedRoute = schedules.find((schedule) => {
      return routeMatchesLocator(schedule, requestedRouteLocator);
    });

    if (routeMatchesLocator(route, requestedRouteLocator)) {
      if (requestedRoute && Number(route.id) === Number(requestedRoute.id) && hasRouteMetadataChanged(route, requestedRoute)) {
        const nextDirections = getRouteDirections(requestedRoute);

        setRoute(requestedRoute);
        setSelectedDirection((currentDirection) =>
          nextDirections.includes(currentDirection) ? currentDirection : nextDirections[0] || ''
        );
      }

      return undefined;
    }

    if (requestedRoute && getOnlineState() !== 'offline') {
      selectRoute(requestedRoute, { updateUrl: true, replaceUrl: true });
      return undefined;
    }

    if (loadingSchedules) {
      return undefined;
    }

    const resolveSavedRoute = async () => {
      const savedTimetable = await findSavedTimetableByLocator(requestedRouteLocator);

      if (ignore) {
        return;
      }

      if (savedTimetable?.routeSnapshot) {
        selectRoute(savedTimetable.routeSnapshot, { updateUrl: true, replaceUrl: true });
        return;
      }

      if (requestedRoute) {
        selectRoute(requestedRoute, { updateUrl: true, replaceUrl: true });
        return;
      }

      clearTimetableSelection({
        showWorkspace: true,
        message: 'This timetable could not be found. Select a route to view an available timetable.',
      });
      const failureKey = JSON.stringify(requestedRouteLocator);

      if (!failedRouteLocators.current.has(failureKey)) {
        failedRouteLocators.current.add(failureKey);
        trackEvent('timetable_load_failed', {
          agency: requestedRouteLocator.agency || 'unknown',
          route_code: requestedRouteLocator.code || 'unknown',
          online_state: getOnlineState(),
          failure_type: 'route_not_found',
        });
      }
    };

    resolveSavedRoute();
    return () => {
      ignore = true;
    };
  }, [loadingSchedules, requestedRouteLocator, route, schedules]);

  useEffect(() => {
    if (route) {
      setHasOpenedTimetableView(true);
    }
  }, [route]);

  useEffect(() => {
    const pathRouteLocator = getRouteLocatorFromPath(currentPath);

    if (pathRouteLocator && !routeMatchesLocator(route, pathRouteLocator)) {
      return;
    }

    let pageTitle = 'Fika Timetables | Cape Town Bus Timetables';
    const currentInfoPage = INFO_PAGES[currentPath];
    const currentOperator = getOperatorAgencyFromPath(currentPath);
    const currentAreaSlug = getAreaSlugFromPath(currentPath);

    if (pathRouteLocator && route) {
      pageTitle = getRouteSeoTitle(route);
    } else if (currentPath === '/saved-timetables') {
      pageTitle = 'Saved Timetables | Fika Timetables';
    } else if (currentInfoPage) {
      pageTitle = currentInfoPage.title;
    } else if (currentOperator) {
      pageTitle = `${getAgencyDisplayName(currentOperator)} Bus Timetables | Fika Timetables`;
    } else if (currentPath === '/areas') {
      pageTitle = 'Cape Town Bus Areas | Fika Timetables';
    } else if (currentAreaSlug) {
      pageTitle = `${titleizeSlug(currentAreaSlug)} Bus Times | Fika Timetables`;
    }

    trackPageView({ path: currentPath, title: pageTitle });
  }, [currentPath, route]);

  const handleAgencyChange = (agency) => { setSelectedAgency(agency); };

  const handleRouteSelect = (selectedRoute, { source } = {}) => {
    selectRoute(selectedRoute, { selectionSource: source });
  };

  useEffect(() => {
    let ignore = false;
    let latestRequest = 0;

    const fetchScheduleTimes = async () => {
      const request = ++latestRequest;
      const isOutdated = () => ignore || request !== latestRequest;
      const cachedTimetable = await getCachedTimetable(route.id);
      let hasUsableCachedTimetable = false;

      if (isOutdated()) {
        return;
      }

      setRouteSavedOffline(Boolean(cachedTimetable?.saved));

      if (cachedTimetable?.data) {
        const cachedTimetablePayload = normalizeTimetablePayload(cachedTimetable.data);

        if (hasTimetableDirections(cachedTimetablePayload)) {
          hasUsableCachedTimetable = true;
          setTimetablePayload(cachedTimetablePayload);
          setScheduleData(buildScheduleData(cachedTimetablePayload));
          setTimetableDataSource('cache');
          setLoadingTimes(false);
          setTimetableMessage('');
          await touchTimetable(route.id);
        } else {
          setTimetablePayload(null);
          setScheduleData(null);
        }
      } else {
        setTimetablePayload(null);
        setScheduleData(null);
      }

      if (navigator.onLine === false && hasUsableCachedTimetable) {
        return;
      }

      try {
        if (!cachedTimetable?.data) {
          setLoadingTimes(true);
        }

        let data;
        let networkDataSource = 'network_v2';

        try {
          data = await fetchApiJson(`/api/v2/schedule_times/${route.id}?metadata=direction-codes`, 'Unable to fetch timetable');
        } catch (error) {
          networkDataSource = 'network_legacy';
          data = await fetchApiJson(`/schedule_times/${route.id}?metadata=direction-codes`, 'Unable to fetch timetable');
        }

        const normalizedPayload = normalizeTimetablePayload(data);

        if (isOutdated()) {
          return;
        }

        if (!hasTimetableDirections(normalizedPayload)) {
          if (!hasUsableCachedTimetable) {
            setTimetablePayload(null);
            setScheduleData(null);
            setTimetableMessage('This timetable is not available yet. Select another route or try again after the latest data refresh is complete.');
            trackEvent('timetable_load_failed', {
              agency: route.agency,
              route_code: route.code || 'unknown',
              online_state: getOnlineState(),
              failure_type: 'invalid_payload',
            });
          }
          return;
        }

        setTimetablePayload(normalizedPayload);
        setScheduleData(buildScheduleData(normalizedPayload));
        setTimetableDataSource(networkDataSource);
        setTimetableMessage('');
        await saveTimetableToCache(
          route,
          normalizedPayload,
          cachedTimetable?.saved
        );
        const refreshedTimetable = await getCachedTimetable(route.id);
        if (!isOutdated()) setRouteSavedOffline(Boolean(refreshedTimetable?.saved));
      } catch (error) {
        console.error('Error fetching timetable:', error);

        if (!hasUsableCachedTimetable && !isOutdated()) {
          setTimetableMessage('This timetable is not available offline yet. Connect to the internet and open it once to cache it.');
          trackEvent('timetable_load_failed', {
            agency: route.agency,
            route_code: route.code || 'unknown',
            online_state: getOnlineState(),
            failure_type: 'network',
          });
        }
      } finally {
        if (!isOutdated()) {
          setLoadingTimes(false);
        }
      }
    };

    if (route) {
      setLoadingTimes(true);
      setScheduleData(null);
      setTimetablePayload(null);
      setTimetableDataSource('');
      setTimetableMessage('');
      fetchScheduleTimes();
    }

    const reconnect = () => { if (route) fetchScheduleTimes(); };
    window.addEventListener('online', reconnect);
    return () => {
      ignore = true;
      window.removeEventListener('online', reconnect);
    };
  }, [route]);

  useEffect(() => {
    if (!route || !scheduleData || !timetableDataSource || !timetableViewKey) {
      return;
    }

    trackTimetableView(timetableViewKey, {
      agency: route.agency,
      route_code: route.code || 'unknown',
      data_source: timetableDataSource,
      online_state: getOnlineState(),
      saved_offline: routeSavedOffline,
    });
  }, [route, routeSavedOffline, scheduleData, timetableDataSource, timetableViewKey]);

  const loading = loadingTimes;
  const loadingInitialSchedules = loadingSchedules;
  const loadedDirections = Object.keys(scheduleData || {});
  const directions = loadedDirections.length ? loadedDirections : getRouteDirections(route);
  useEffect(() => {
    const names = Object.keys(scheduleData || {});
    if (names.length) setSelectedDirection((current) => names.includes(current) ? current : names[0]);
  }, [scheduleData]);
  const statusState = useTimetableStatus(route ? `${route.agency}:${route.code}` : '', fetchApiJson);
  const decoratedSchedules = useMemo(() => schedules.map((schedule) => ({
    ...schedule,
    timetableStatus: getRouteStatus(statusState.report, schedule, statusState),
  })), [schedules, statusState]);
  const routeStatus = getRouteStatus(statusState.report, route, {
    ...statusState, direction: selectedDirection, serviceDay: selectedServiceDay,
  });

  const handleDirectionChange = (direction) => {
    setSelectedDirection(direction);
    window.scrollTo({ top: 0 });
    if (route) {
      trackEvent('direction_changed', {
        agency: route.agency,
        route_code: route.code || 'unknown',
        direction,
      });
    }
  };

  const handleServiceDayChange = (serviceDay) => {
    setSelectedServiceDay(serviceDay);
    window.scrollTo({ top: 0 });
    if (route) {
      trackEvent('service_day_changed', {
        agency: route.agency,
        route_code: route.code || 'unknown',
        service_day: serviceDay,
      });
    }
  };

  const handleSaveOfflineChange = async (saved) => {
    if (!route) {
      return;
    }

    let savedSuccessfully;

    if (timetablePayload) {
      savedSuccessfully = await saveTimetableToCache(route, timetablePayload, saved);
    } else {
      savedSuccessfully = await setTimetableSaved(route, saved);
    }

    if (savedSuccessfully) {
      setRouteSavedOffline(saved);
      setOfflineSaveMessage('');
      trackEvent('offline_save_changed', {
        agency: route.agency,
        route_code: route.code || 'unknown',
        saved_state: saved ? 'saved' : 'removed',
      });
    } else {
      setOfflineSaveMessage('Fika could not update offline storage. Check your browser storage settings and try again.');
    }
  };

  const showTimetableWorkspace = hasOpenedTimetableView || route;
  const infoPage = INFO_PAGES[currentPath];
  const operatorAgency = getOperatorAgencyFromPath(currentPath);
  const areaSlug = getAreaSlugFromPath(currentPath);
  const isAreasIndex = isAreasIndexPath(currentPath);
  const isSavedTimetablesPage = currentPath === '/saved-timetables';

  return (
    <div className="App">
      <Navbar />
      {isSavedTimetablesPage ? (
        <SavedTimetablesPage
          schedules={decoratedSchedules}
          onViewRoute={(savedRoute) => selectRoute(savedRoute)}
        />
      ) : infoPage ? (
        <InfoPage page={infoPage} />
      ) : operatorAgency ? (
        <OperatorPage
          agency={operatorAgency}
          schedules={decoratedSchedules}
          loadingSchedules={loadingInitialSchedules}
        />
      ) : isAreasIndex ? (
        <AreasIndexPage
          schedules={decoratedSchedules}
          loadingSchedules={loadingInitialSchedules}
        />
      ) : areaSlug ? (
        <AreaPage
          areaSlug={areaSlug}
          schedules={decoratedSchedules}
          loadingSchedules={loadingInitialSchedules}
        />
      ) : !showTimetableWorkspace ? (
        <>
          <LandingPage
            route={route}
            schedules={decoratedSchedules}
            selectedAgency={selectedAgency}
            loadingSchedules={loadingInitialSchedules}
            onAgencyChange={handleAgencyChange}
            onRouteSelect={handleRouteSelect}
          />
          <SiteFooter />
        </>
      ) : (
        <main className='container'>
          <div className="timetable-layout">
            <div className="timetable-workspace">
              <div className="route-toolbar" aria-label="Find and filter timetables">
                <SchedulesDropdown
                  placeholder="Search routes"
                  route={route}
                  schedules={decoratedSchedules}
                  selectedAgency={selectedAgency}
                  onAgencyChange={handleAgencyChange}
                  onRouteSelect={handleRouteSelect}
                  searchLocation="timetable_search"
                />
                {route && <div className="route-controls">
                  <fieldset className="route-direction-control">
                    <legend>Direction</legend>
                    <div className="route-direction-buttons">
                      {directions.map((direction) => <button key={direction} type="button"
                        aria-pressed={selectedDirection === direction}
                        onClick={() => handleDirectionChange(direction)}>
                        <span>{getDirectionDestination(route, direction)}</span>
                        {route.agency === 'GABS' && /^\d{4}$/.test(route.code || '')
                          && /^\d{2}$/.test(scheduleData?.[direction]?.code || '') && (
                          <small className="route-direction-number">
                            {route.code}{scheduleData[direction].code}
                          </small>
                        )}
                      </button>)}
                    </div>
                  </fieldset>
                  <ServiceDayPicker key={`${route.id}|${selectedDirection}`} days={SERVICE_DAYS}
                    value={selectedServiceDay} onChange={handleServiceDayChange} />
                </div>}
              </div>
              <div className='table'>
                {!route ? (
                  <TimetableStatePanel
                    title="Select a route"
                    message="Select a route to view its timetable."
                  />
                ) : timetableMessage ? (
                  <TimetableStatePanel
                    title="Timetable unavailable"
                    message={timetableMessage}
                  />
                ) : loading || !scheduleData ? (
                  <TimetableStatePanel
                    title={getRouteSeoTitle(route)}
                    message="Loading timetable..."
                    loading
                  />
                ) : (
                  <ScheduleTable
                    selectedDirection={selectedDirection}
                    selectedServiceDay={selectedServiceDay}
                    scheduleData={scheduleData}
                    route={route}
                    savedOffline={routeSavedOffline}
                    onSaveOfflineChange={handleSaveOfflineChange}
                    offlineSaveMessage={offlineSaveMessage}
                    statusNotice={<>
                      {timetableDataSource === 'cache' && <p className="saved-times-notice" role="status">Showing saved timetable times. Updates appear when a connection is available.</p>}
                      <TimetableStatusNotice status={routeStatus} />
                    </>}
                  />
                )}
              </div>
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

export default App;
