import React, { useEffect, useId, useMemo, useState } from 'react';
import { formatRoutePlace, getAgencyDisplayName, getDirectionDestination, getRoutePresentation } from './routeUtils';
import { formatDayOffset, formatDuration, formatTripTime, getBoardingStops, getServiceBadge, getVisibleTrips } from './tripListUtils';
import './TripList.css';

export { getServiceBadge, getTripDetails, getVisibleRows, getVisibleTrips } from './tripListUtils';

const TripTime = ({ minutes }) => (
  <>
    <strong className={minutes === null ? 'trip-unpublished-time' : 'trip-clock'}>{formatTripTime(minutes)}</strong>
    {formatDayOffset(minutes) && <span className="trip-day-offset">{formatDayOffset(minutes)}</span>}
  </>
);

const TripRow = ({ trip, boardingStop, dayLabel }) => {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const buttonId = useId();
  const { details } = trip;
  return (
    <li className={`trip-row${expanded ? ' is-expanded' : ''}`}>
      <h3 className="trip-summary-heading">
        <button id={buttonId} type="button" className="trip-summary-button" aria-expanded={expanded}
          aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          <span className="trip-summary-cell">
            <span className="trip-cell-label">Departs</span>
            <TripTime minutes={details.departureMinutes} />
            <span className="trip-place">{details.departureStop?.name || 'First listed stop'}</span>
          </span>
          <span className="trip-summary-cell">
            <span className="trip-cell-label">Arrives</span>
            <TripTime minutes={details.arrivalMinutes} />
            <span className="trip-place">{details.lastStop?.name || 'Last listed stop'}</span>
          </span>
          <span className="trip-summary-cell trip-duration">
            <span className="trip-cell-label">Duration</span>
            <strong>{formatDuration(details.durationMinutes)}</strong>
          </span>
          <span className="trip-expand-label">{expanded ? 'Hide stops' : 'Show stops'}
            <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="m3 6 5 5 5-5" /></svg>
          </span>
        </button>
      </h3>
      <div id={detailsId} className="trip-expanded-details" hidden={!expanded} aria-labelledby={buttonId}>
        <p className="trip-service-days">Shown for {dayLabel}. <strong>Runs {getServiceBadge(trip)}.</strong></p>
        {details.hasTimingIssues && <p className="trip-timing-notice">Some published stop times are out of order. Check the operator timetable before travelling.</p>}
        <ol className="trip-timeline" aria-label="Trip stops and times">
          {details.stops.map((stop, index) => (
            <li key={`${stop.sequence}-${index}`} className={boardingStop && stop === details.departureStop ? 'is-boarding-stop' : ''}>
              <span className="trip-timeline-stop">{stop.name}
                {boardingStop && stop === details.departureStop && <span className="trip-boarding-label">Selected stop</span>}
              </span>
              <span className="trip-timeline-time">{stop.minutes === null
                ? <span className="trip-via-time">{stop.stop_time_type === 'via' ? 'Via · time not published' : 'Time not published'}</span>
                : <TripTime minutes={stop.minutes} />}
                {stop.timingIssue && <span className="trip-timing-label">Published time needs checking</span>}
              </span>
            </li>
          ))}
        </ol>
        {!details.stops.length && <p>Stop details are not available for this trip.</p>}
        {details.stops.some(stop => stop.stop_time_type === 'via' && stop.minutes === null) && (
          <p className="trip-via-explanation">Via indicates a point on the route. A time and boarding availability are not published.</p>
        )}
      </div>
    </li>
  );
};

const ScheduleTable = ({
  selectedDirection, selectedServiceDay, scheduleData, route, savedOffline,
  onSaveOfflineChange, offlineSaveMessage, statusNotice,
}) => {
  const directionKey = selectedDirection || Object.keys(scheduleData || {})[0] || '';
  const directionData = scheduleData?.[directionKey];
  const scope = `${route?.id || `${route?.agency || ''}:${route?.code || ''}:${route?.name || ''}`}|${directionKey}`;
  const [boarding, setBoarding] = useState({ scope, key: '' });
  const [announcement, setAnnouncement] = useState('');
  const boardingId = useId();
  const dayTrips = useMemo(() => getVisibleTrips(directionData?.trips, selectedServiceDay, directionData?.rows), [directionData, selectedServiceDay]);
  const boardingStops = useMemo(() => getBoardingStops(dayTrips), [dayTrips]);
  const storedBoardingStop = boarding.scope === scope ? boarding.key : '';
  const boardingStop = boardingStops.some(stop => stop.key === storedBoardingStop) ? storedBoardingStop : '';

  useEffect(() => {
    if (boarding.scope !== scope) {
      setBoarding({ scope, key: '' });
      setAnnouncement('');
    } else if (storedBoardingStop && !boardingStop) {
      setBoarding({ scope, key: '' });
      setAnnouncement('The selected stop is not listed on this day. Showing all stops and whole trips.');
    }
  }, [boarding.scope, boardingStop, scope, storedBoardingStop]);

  const visibleTrips = useMemo(() => boardingStop
    ? getVisibleTrips(directionData?.trips, selectedServiceDay, directionData?.rows, boardingStop)
    : dayTrips, [boardingStop, dayTrips, directionData, selectedServiceDay]);
  const timedTrips = visibleTrips.filter(trip => trip.details.departureMinutes !== null);
  const untimedTrips = visibleTrips.filter(trip => trip.details.departureMinutes === null);
  const serviceDayText = selectedServiceDay?.replace(/_/g, ' ') || 'the selected service day';
  const dayLabel = serviceDayText.charAt(0).toUpperCase() + serviceDayText.slice(1);
  const presentation = getRoutePresentation(route, directionData?.name || directionKey);
  const destination = getDirectionDestination(route, directionData?.name || directionKey);
  const listKey = `${scope}|${selectedServiceDay}|${boardingStop}`;
  const renderTrips = trips => <ul className="trip-list">{trips.map(trip => (
    <TripRow key={`${listKey}|${trip.trip_id}`} trip={trip} boardingStop={boardingStop} dayLabel={dayLabel} />
  ))}</ul>;

  return (
    <section className="schedule-table trip-schedule" aria-label="Route timetable">
      <div className="trip-route-heading">
        <div>
          {route && <p className="trip-route-operator">{getAgencyDisplayName(route.agency)}{route.code && ` · ${route.code}`}{route.name && ` · ${formatRoutePlace(route.name).replace(/\s+[-–—]\s+/g, '–')}`}</p>}
          <h1>{destination ? `→ ${destination}` : 'Timetable'}</h1>
          {presentation.via && <p className="trip-route-via">via {presentation.via}</p>}
        </div>
        {route && onSaveOfflineChange && (
          <label className="save-offline-toggle">
            <input type="checkbox" checked={Boolean(savedOffline)} onChange={event => onSaveOfflineChange(event.target.checked)} />
            <span>Save offline</span>
          </label>
        )}
      </div>
      {statusNotice}
      {offlineSaveMessage && <p className="offline-save-error" role="alert">{offlineSaveMessage}</p>}
      <p className="trip-announcement" role="status">{announcement}</p>
      {!scheduleData || !directionData ? <p>Loading schedule data...</p> : (
        <>
          <div className="trip-list-controls">
            <div className="trip-day-summary">
              <h2>{selectedServiceDay ? `${dayLabel} timetable` : 'Choose a service day'}</h2>
              {selectedServiceDay && <p>{visibleTrips.length} trip{visibleTrips.length === 1 ? '' : 's'}{boardingStop ? ' through your selected stop' : ''} · Scheduled times</p>}
            </div>
            <div className="trip-boarding-filter">
              <label htmlFor={boardingId}>Boarding at</label>
              <select id={boardingId} value={boardingStop} disabled={!boardingStops.length} onChange={event => {
                setBoarding({ scope, key: event.target.value });
                setAnnouncement('');
              }}>
                <option value="">All stops / whole trips</option>
                {boardingStops.map(stop => <option key={stop.key} value={stop.key}>{stop.name}</option>)}
              </select>
            </div>
          </div>
          {!!visibleTrips.length && <p className="trip-list-instruction">Choose <strong>Show stops</strong> to see the stops and times.</p>}
          {selectedServiceDay && !visibleTrips.length && (
            <div className="trip-empty-state"><h3>No trips listed for {dayLabel}</h3><p>Choose another service day or direction to see its timetable.</p></div>
          )}
          {!!timedTrips.length && renderTrips(timedTrips)}
          {!!untimedTrips.length && (
            <section className="trip-untimed-group" aria-label={boardingStop ? 'No published boarding time' : 'No published departure time'}>
              <h3>{boardingStop ? 'No published boarding time' : 'No published departure time'}</h3>
              <p>{boardingStop ? 'These trips include this point, but no boarding time is published.' : 'A departure time is not published for the first listed stop on these trips.'}</p>
              {renderTrips(untimedTrips)}
            </section>
          )}
        </>
      )}
    </section>
  );
};

export default ScheduleTable;
