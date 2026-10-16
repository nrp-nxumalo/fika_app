import React, { useEffect, useRef, useState } from 'react';
import SiteFooter from './SiteFooter';
import {
  getSavedTimetables,
  isTimetableStorageAvailable,
  setTimetableSaved,
} from './timetableCache';
import {
  getTimetablePath,
} from './routeUtils';
import { RouteTileContent } from './RouteLinkList';
import { getOnlineState, trackEvent } from './analytics';

const formatStoredDate = (timestamp) => {
  if (!timestamp) {
    return '';
  }

  return new Intl.DateTimeFormat('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
};

export default function SavedTimetablesPage({ schedules, onViewRoute }) {
  const [savedTimetables, setSavedTimetables] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pendingRouteId, setPendingRouteId] = useState(null);
  const [removeError, setRemoveError] = useState('');
  const trackedSummary = useRef('');
  const storageAvailable = isTimetableStorageAvailable();

  useEffect(() => {
    let ignore = false;

    const loadSavedTimetables = async () => {
      const records = await getSavedTimetables(schedules);

      if (ignore) {
        return;
      }

      setSavedTimetables(records);
      setLoading(false);
      const summaryKey = `${records.length}|${getOnlineState()}`;

      if (trackedSummary.current !== summaryKey) {
        trackedSummary.current = summaryKey;
        trackEvent('saved_timetables_viewed', {
          saved_count: records.length,
          online_state: getOnlineState(),
        });
      }
    };

    loadSavedTimetables();
    return () => {
      ignore = true;
    };
  }, [schedules]);

  const removeSavedTimetable = async (record) => {
    const route = record.routeSnapshot;

    setPendingRouteId(record.routeId);
    setRemoveError('');
    const removed = await setTimetableSaved(route || record.routeId, false);

    if (removed) {
      setSavedTimetables((records) => records.filter((item) => item.routeId !== record.routeId));
      trackEvent('offline_save_changed', {
        agency: route?.agency || 'unknown',
        route_code: route?.code || 'unknown',
        saved_state: 'removed',
      });
    } else {
      setRemoveError('Fika could not update this saved timetable. Check your browser storage settings and try again.');
    }

    setPendingRouteId(null);
  };

  const viewSavedTimetable = (event, route) => {
    trackEvent('route_selected', {
      agency: route.agency,
      route_code: route.code || 'unknown',
      selection_source: 'saved_timetables',
    });

    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      onViewRoute(route);
    }
  };

  return (
    <main className="saved-page">
      <section className="saved-panel">
        <p className="info-eyebrow">Available in this browser</p>
        <h1>Saved timetables</h1>
        <p>
          These timetables are pinned in this browser for offline reference. They are not synced
          to other devices, and critical trips should still be confirmed with the operator.
        </p>

        {!storageAvailable ? (
          <div className="saved-empty" role="status">
            <h2>Offline storage is unavailable</h2>
            <p>Enable browser site storage to save and manage timetables on this device.</p>
          </div>
        ) : loading ? (
          <div className="saved-empty" role="status">
            <p>Loading saved timetables…</p>
          </div>
        ) : savedTimetables.length === 0 ? (
          <div className="saved-empty">
            <h2>No saved timetables yet</h2>
            <p>Open a timetable and select “Save offline” to keep it here.</p>
            <a href="/">Find a timetable</a>
          </div>
        ) : (
          <>
            <p className="saved-count" aria-live="polite">
              {savedTimetables.length} saved timetable{savedTimetables.length === 1 ? '' : 's'}
            </p>
            {removeError && <p className="saved-error" role="alert">{removeError}</p>}
            <div className="saved-grid">
              {savedTimetables.map((record) => {
                const route = record.routeSnapshot;
                const currentRoute = route && schedules.find((schedule) => route.agency && route.code
                  ? schedule.agency === route.agency && String(schedule.code) === String(route.code)
                  : String(schedule.id) === String(record.routeId));
                const tileRoute = route && {
                  ...route,
                  timetableStatus: currentRoute
                    ? currentRoute.timetableStatus
                    : route.timetableStatus && { ...route.timetableStatus, cached: true },
                };
                const pending = pendingRouteId === record.routeId;

                return (
                  <article className="saved-card route-saved-card" key={record.routeId}>
                    {route ? (
                      <>
                        <RouteTileContent route={tileRoute} titleAs="h2" />
                        <p className="saved-date">
                          {record.savedAt ? `Saved ${formatStoredDate(record.savedAt)}` : 'Saved for offline use'}
                          {record.lastViewedAt ? ` · Viewed ${formatStoredDate(record.lastViewedAt)}` : ''}
                        </p>
                        <div className="saved-card-actions">
                          <a
                            href={getTimetablePath(route)}
                            onClick={(event) => viewSavedTimetable(event, route)}
                          >
                            View timetable
                          </a>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => removeSavedTimetable(record)}
                          >
                            {pending ? 'Removing…' : 'Remove from saved'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="saved-operator">Saved timetable</p>
                        <h2>Route details unavailable offline</h2>
                        <p>
                          Fika will restore this route’s name when the route catalogue is available again.
                        </p>
                        <div className="saved-card-actions">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => removeSavedTimetable(record)}
                          >
                            {pending ? 'Removing…' : 'Remove from saved'}
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
      <SiteFooter />
    </main>
  );
}
