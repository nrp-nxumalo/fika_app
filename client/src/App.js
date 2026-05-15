import React, { useState, useEffect } from 'react';
import SchedulesDropdown from './SchedulesDropdown';
import ScheduleTable from './ScheduleTable';
import DirectionRadioButton from './DirectionRadioButton';
import Navbar from './Navbar';
import AdSlot from './AdSlot';
import { AreaPage, AreasIndexPage } from './AreaPages';
import InfoPage, { INFO_PAGES } from './InfoPage';
import OperatorPage from './OperatorPage';
import SiteFooter from './SiteFooter';
import {
  getAgencyDisplayName,
  getAreaSlugFromPath,
  getOperatorAgencyFromPath,
  getRouteCountLabel,
  getRouteDirections,
  getRouteIdFromPath,
  getTimetablePath,
  isAreasIndexPath,
  normalizeDirectionLabel,
  slugify,
} from './routeUtils';
import {
  getCachedSchedules,
  getCachedTimetable,
  isCacheStale,
  saveSchedulesToCache,
  saveTimetableToCache,
  setTimetableSaved,
  touchTimetable,
} from './timetableCache';

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

const FEATURED_AREA_LINKS = [
  'Cape Town',
  'Bellville',
  'Khayelitsha',
  'Claremont',
  'Delft',
  'Wynberg',
  'Blouberg',
  'Atlantis',
];

const LOCAL_API_PORT = '4000';
const LOCAL_API_BASE_URL = `http://localhost:${LOCAL_API_PORT}`;
const API_BASE_URL = process.env.REACT_APP_API_BASE_URL ||
  (process.env.NODE_ENV === 'production' ? '' : LOCAL_API_BASE_URL);
const TIMETABLE_AD_RAIL_MEDIA_QUERY = '(min-width: 1181px)';

const getInitialRouteId = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  return getRouteIdFromPath(window.location.pathname);
};

const getCurrentPath = () => {
  if (typeof window === 'undefined') {
    return '/';
  }

  return window.location.pathname;
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

const getMatchesMediaQuery = (mediaQuery) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia(mediaQuery).matches;
};

const fetchApiJson = async (endpoint, errorMessage) => {
  const fetchJson = async (baseUrl) => {
    const response = await fetch(`${baseUrl}${endpoint}`);
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

const getAvailableServiceDays = (scheduleData, selectedDirection) => {
  if (!scheduleData) {
    return [];
  }

  const directionGroups = selectedDirection && scheduleData[selectedDirection]
    ? [scheduleData[selectedDirection]]
    : Object.values(scheduleData);

  return SERVICE_DAYS.filter((day) =>
    directionGroups.some((direction) => direction.trips?.some((trip) => trip[day.key]))
  );
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
  setRoute,
  setSelectedAgency,
  setSelectedDirection,
}) {
  const agencies = [...new Set(schedules.map((schedule) => schedule.agency))].filter(Boolean);
  const availableAgencies = agencies.map(getAgencyDisplayName).join(' and ');

  return (
    <main className="landing">
      <section className="landing-hero">
        <div className="landing-copy">
          <p className="landing-eyebrow">Cape Town bus timetables</p>
          <h1>Find the bus timetable you need.</h1>
          <p>
            Search Golden Arrow and MyCiTi route timetables in one place. More South African cities
            and provinces are planned for future releases.
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
              setRoute={setRoute}
              setSelectedAgency={setSelectedAgency}
              setSelectedDirection={setSelectedDirection}
            />
          )}
          <p id="landing-search-helper">
            Available now: {availableAgencies || 'Cape Town bus services'}.
          </p>
        </div>
      </section>

      <section className="landing-ad-band">
        <AdSlot
          adClient="ca-pub-6988683138579622"
          adFormat="fluid"
          adLayout="in-article"
          adSlot="4341548768"
          className="ad-slot-banner"
          textAlign="center"
        />
      </section>

      <section className="coverage-band" aria-label="Timetable coverage">
        <div className="coverage-copy">
          <h2>Available now</h2>
          <p>{getRouteCountLabel(schedules.length)} for Cape Town bus commuters.</p>
        </div>
        <div className="coverage-list">
          <div className="coverage-item">
            <a href="/operators/golden-arrow" className="coverage-link">
              <img src="/agency-logos/gabs.png" alt="" />
            </a>
            <div>
              <h3><a href="/operators/golden-arrow">Golden Arrow</a></h3>
              <p>Cape Town route timetables</p>
            </div>
          </div>
          <div className="coverage-item">
            <a href="/operators/myciti" className="coverage-link">
              <img src="/agency-logos/myciti.png" alt="" />
            </a>
            <div>
              <h3><a href="/operators/myciti">MyCiTi</a></h3>
              <p>Cape Town route timetables</p>
            </div>
          </div>
        </div>
        <div className="coverage-next">
          <h2>Coming soon</h2>
          <p>More operators, cities, and provinces as new timetable data is added.</p>
        </div>
      </section>

      <section className="area-link-band" aria-label="Popular Cape Town bus areas">
        {FEATURED_AREA_LINKS.map((areaName) => (
          <a key={areaName} href={`/areas/${slugify(areaName)}`}>
            {areaName}
          </a>
        ))}
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
  const [selectedServiceDay, setSelectedServiceDay] = useState('');
  const [mobileFilterSheet, setMobileFilterSheet] = useState(null);
  const [hasOpenedTimetableView, setHasOpenedTimetableView] = useState(false);
  const [timetableMessage, setTimetableMessage] = useState('');
  const [routeSavedOffline, setRouteSavedOffline] = useState(false);
  const [requestedRouteId, setRequestedRouteId] = useState(getInitialRouteId);
  const [currentPath, setCurrentPath] = useState(getCurrentPath);
  const [showTimetableAdRail, setShowTimetableAdRail] = useState(() =>
    getMatchesMediaQuery(TIMETABLE_AD_RAIL_MEDIA_QUERY)
  );

  const clearTimetableSelection = ({ showWorkspace = false, message = '' } = {}) => {
    setRoute(null);
    setScheduleData(null);
    setTimetablePayload(null);
    setSelectedDirection('');
    setSelectedServiceDay('');
    setMobileFilterSheet(null);
    setRouteSavedOffline(false);
    setTimetableMessage(message);
    setHasOpenedTimetableView(showWorkspace);
  };

  const selectRoute = (selectedRoute, { updateUrl = true, replaceUrl = false } = {}) => {
    if (!selectedRoute) {
      return;
    }

    setRequestedRouteId(Number(selectedRoute.id));
    setRoute(selectedRoute);
    setSelectedAgency(selectedRoute.agency);
    setSelectedDirection(getRouteDirections(selectedRoute)[0] || '');
    setSelectedServiceDay('');
    setMobileFilterSheet(null);
    setTimetableMessage('');
    setHasOpenedTimetableView(true);

    if (updateUrl) {
      updateBrowserPath(getTimetablePath(selectedRoute), replaceUrl);
    }
  };

  useEffect(() => {
    let ignore = false;

    const fetchSchedules = async () => {
      const cachedSchedules = await getCachedSchedules();

      if (!ignore && cachedSchedules?.data?.length) {
        const cachedScheduleData = normalizeScheduleRoutes(cachedSchedules.data);

        setSchedules(cachedScheduleData);
        setSelectedAgency((currentAgency) => currentAgency || cachedScheduleData[0]?.agency || '');
        setLoadingSchedules(false);
      }

      if (cachedSchedules?.data?.length && !isCacheStale(cachedSchedules.cachedAt)) {
        return;
      }

      try {
        const data = normalizeScheduleRoutes(await fetchApiJson('/schedules', 'Unable to fetch schedules'));

        if (ignore) {
          return;
        }

        setSchedules(data);
        setSelectedAgency((currentAgency) => currentAgency || data[0]?.agency || '');
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
      const nextRouteId = getRouteIdFromPath(window.location.pathname);
      setRequestedRouteId(nextRouteId);

      if (!nextRouteId) {
        clearTimetableSelection();
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }

    const mediaQueryList = window.matchMedia(TIMETABLE_AD_RAIL_MEDIA_QUERY);
    const handleChange = (event) => {
      setShowTimetableAdRail(event.matches);
    };

    setShowTimetableAdRail(mediaQueryList.matches);

    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', handleChange);

      return () => {
        mediaQueryList.removeEventListener('change', handleChange);
      };
    }

    mediaQueryList.addListener(handleChange);

    return () => {
      mediaQueryList.removeListener(handleChange);
    };
  }, []);

  useEffect(() => {
    if (!requestedRouteId || !schedules.length) {
      return;
    }

    const requestedRoute = schedules.find((schedule) => Number(schedule.id) === requestedRouteId);

    if (requestedRoute) {
      if (Number(route?.id) !== Number(requestedRoute.id)) {
        selectRoute(requestedRoute, { updateUrl: true, replaceUrl: true });
      } else {
        updateBrowserPath(getTimetablePath(requestedRoute), true);
      }

      return;
    }

    if (!loadingSchedules) {
      clearTimetableSelection({
        showWorkspace: true,
        message: 'This timetable could not be found. Select a route to view an available timetable.',
      });
    }
  }, [loadingSchedules, requestedRouteId, route, schedules]);

  useEffect(() => {
    if (route) {
      setHasOpenedTimetableView(true);
    }
  }, [route]);

  const handleAgencyChange = (agency) => {
    const shouldStayInWorkspace = hasOpenedTimetableView || route;

    setRequestedRouteId(null);
    setSelectedAgency(agency);
    clearTimetableSelection({
      showWorkspace: shouldStayInWorkspace,
      message: 'Select a route to view its timetable.',
    });
    updateBrowserPath('/');
  };

  const handleRouteSelect = (selectedRoute) => {
    selectRoute(selectedRoute);
  };

  useEffect(() => {
    let ignore = false;

    const fetchScheduleTimes = async () => {
      const cachedTimetable = await getCachedTimetable(route.id);

      if (ignore) {
        return;
      }

      setRouteSavedOffline(Boolean(cachedTimetable?.saved));

      if (cachedTimetable?.data) {
        const cachedTimetablePayload = normalizeTimetablePayload(cachedTimetable.data);

        setTimetablePayload(cachedTimetablePayload);
        setScheduleData(buildScheduleData(cachedTimetablePayload));
        setLoadingTimes(false);
        setTimetableMessage('');
        await touchTimetable(route.id);
      } else {
        setTimetablePayload(null);
        setScheduleData(null);
      }

      if (cachedTimetable?.data && !isCacheStale(cachedTimetable.cachedAt)) {
        return;
      }

      try {
        if (!cachedTimetable?.data) {
          setLoadingTimes(true);
        }

        let data;

        try {
          data = await fetchApiJson(`/api/v2/schedule_times/${route.id}`, 'Unable to fetch timetable');
        } catch (error) {
          data = await fetchApiJson(`/schedule_times/${route.id}`, 'Unable to fetch timetable');
        }

        const normalizedPayload = normalizeTimetablePayload(data);

        if (ignore) {
          return;
        }

        setTimetablePayload(normalizedPayload);
        setScheduleData(buildScheduleData(normalizedPayload));
        setTimetableMessage('');
        await saveTimetableToCache(route.id, normalizedPayload, cachedTimetable?.saved);
        const refreshedTimetable = await getCachedTimetable(route.id);
        setRouteSavedOffline(Boolean(refreshedTimetable?.saved));
      } catch (error) {
        console.error('Error fetching timetable:', error);

        if (!cachedTimetable?.data && !ignore) {
          setTimetableMessage('This timetable is not available offline yet. Connect to the internet and open it once to cache it.');
        }
      } finally {
        if (!ignore) {
          setLoadingTimes(false);
        }
      }
    };

    if (route) {
      setLoadingTimes(true);
      setScheduleData(null);
      setTimetablePayload(null);
      setTimetableMessage('');
      fetchScheduleTimes();
    }

    return () => {
      ignore = true;
    };
  }, [route]);

  useEffect(() => {
    const availableServiceDays = getAvailableServiceDays(scheduleData, selectedDirection);

    if (!availableServiceDays.length) {
      setSelectedServiceDay('');
      return;
    }

    if (!availableServiceDays.some((day) => day.key === selectedServiceDay)) {
      setSelectedServiceDay(availableServiceDays[0].key);
    }
  }, [scheduleData, selectedDirection, selectedServiceDay]);

  const loading = loadingTimes;
  const loadingInitialSchedules = loadingSchedules;
  const availableServiceDays = getAvailableServiceDays(scheduleData, selectedDirection);
  const directions = getRouteDirections(route);
  const selectedServiceDayLabel = availableServiceDays.find((day) => day.key === selectedServiceDay)?.label;

  const closeMobileFilterSheet = () => {
    setMobileFilterSheet(null);
  };

  const handleSaveOfflineChange = async (saved) => {
    if (!route) {
      return;
    }

    if (timetablePayload) {
      await saveTimetableToCache(route.id, timetablePayload, saved);
    } else {
      await setTimetableSaved(route.id, saved);
    }

    setRouteSavedOffline(saved);
  };

  const routeSearchPlaceholder = selectedAgency
    ? `Search ${getAgencyDisplayName(selectedAgency)} routes...`
    : 'Search route...';

  const showTimetableWorkspace = hasOpenedTimetableView || route;
  const infoPage = INFO_PAGES[currentPath];
  const operatorAgency = getOperatorAgencyFromPath(currentPath);
  const areaSlug = getAreaSlugFromPath(currentPath);
  const isAreasIndex = isAreasIndexPath(currentPath);

  return (
    <div className="App">
      <Navbar />
      {infoPage ? (
        <InfoPage page={infoPage} />
      ) : operatorAgency ? (
        <OperatorPage
          agency={operatorAgency}
          schedules={schedules}
          loadingSchedules={loadingInitialSchedules}
        />
      ) : isAreasIndex ? (
        <AreasIndexPage
          schedules={schedules}
          loadingSchedules={loadingInitialSchedules}
        />
      ) : areaSlug ? (
        <AreaPage
          areaSlug={areaSlug}
          schedules={schedules}
          loadingSchedules={loadingInitialSchedules}
        />
      ) : !showTimetableWorkspace ? (
        <>
          <LandingPage
            route={route}
            schedules={schedules}
            selectedAgency={selectedAgency}
            loadingSchedules={loadingInitialSchedules}
            onAgencyChange={handleAgencyChange}
            onRouteSelect={handleRouteSelect}
            setRoute={setRoute}
            setSelectedAgency={setSelectedAgency}
            setSelectedDirection={setSelectedDirection}
          />
          <SiteFooter />
        </>
      ) : (
        <div className='container'>
          <div className="timetable-layout">
            <div className="timetable-workspace">
              <div className='side-bar'>
                <SchedulesDropdown
                  placeholder={routeSearchPlaceholder}
                  route={route}
                  schedules={schedules}
                  selectedAgency={selectedAgency}
                  onAgencyChange={handleAgencyChange}
                  onRouteSelect={handleRouteSelect}
                  setRoute={setRoute}
                  setSelectedAgency={setSelectedAgency}
                  setSelectedDirection={setSelectedDirection}
                />
                {directions.length > 0 && (
                  <div className="mobile-filter-chips">
                    {directions.length > 1 && (
                      <button
                        type="button"
                        className="mobile-filter-chip"
                        onClick={() => setMobileFilterSheet('direction')}
                      >
                        <span>Direction</span>
                        <strong>{selectedDirection}</strong>
                      </button>
                    )}
                    {availableServiceDays.length > 0 && (
                      <button
                        type="button"
                        className="mobile-filter-chip"
                        onClick={() => setMobileFilterSheet('serviceDay')}
                      >
                        <span>Day</span>
                        <strong>{selectedServiceDayLabel}</strong>
                      </button>
                    )}
                  </div>
                )}
                {route && (
                  <DirectionRadioButton
                    className="directions"
                    route={route}
                    setSelectedDirection={setSelectedDirection}
                    selectedDirection={selectedDirection}
                  />
                )}
                {availableServiceDays.length > 0 && (
                  <div className="service-day-toggle-container">
                    <label className="service-day-toggle-label">Service Day</label>
                    <div className="service-day-toggle">
                      {availableServiceDays.map((day) => (
                        <button
                          key={day.key}
                          type="button"
                          className={selectedServiceDay === day.key ? 'active' : ''}
                          onClick={() => setSelectedServiceDay(day.key)}
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
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
                    title={route.name}
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
                  />
                )}
              </div>
              {mobileFilterSheet && (
                <div className="mobile-sheet" role="dialog" aria-modal="true">
                  <button
                    type="button"
                    className="mobile-sheet-backdrop"
                    aria-label="Close filters"
                    onClick={closeMobileFilterSheet}
                  />
                  <div className="mobile-sheet-panel">
                    <div className="mobile-sheet-header">
                      <h2>
                        {mobileFilterSheet === 'direction' ? 'Select Direction' : 'Select Service Day'}
                      </h2>
                      <button type="button" onClick={closeMobileFilterSheet}>
                        Close
                      </button>
                    </div>
                    <div className="mobile-sheet-options">
                      {mobileFilterSheet === 'direction' && directions.map((direction) => (
                        <button
                          key={direction}
                          type="button"
                          className={selectedDirection === direction ? 'active' : ''}
                          onClick={() => {
                            setSelectedDirection(direction);
                            closeMobileFilterSheet();
                          }}
                        >
                          {direction}
                        </button>
                      ))}
                      {mobileFilterSheet === 'serviceDay' && availableServiceDays.map((day) => (
                        <button
                          key={day.key}
                          type="button"
                          className={selectedServiceDay === day.key ? 'active' : ''}
                          onClick={() => {
                            setSelectedServiceDay(day.key);
                            closeMobileFilterSheet();
                          }}
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {showTimetableAdRail && (
              <aside className="timetable-ad-rail">
                <AdSlot
                  adClient="ca-pub-6988683138579622"
                  adFormat="autorelaxed"
                  adSlot="2670138789"
                  className="ad-slot-rail"
                />
              </aside>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
