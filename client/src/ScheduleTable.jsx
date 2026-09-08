import React, { useEffect, useId, useRef, useState } from 'react';
import { getAgencyDisplayName, getRouteSeoTitle } from './routeUtils';

const SERVICE_DAYS = [
  { key: 'monday', short: 'Mon' },
  { key: 'tuesday', short: 'Tue' },
  { key: 'wednesday', short: 'Wed' },
  { key: 'thursday', short: 'Thu' },
  { key: 'friday', short: 'Fri' },
  { key: 'saturday', short: 'Sat' },
  { key: 'sunday', short: 'Sun' },
];

const formatStopTime = (stopTime) => {
  if (!stopTime || stopTime.stop_time_type === 'not_served') {
    return '--';
  }

  if (stopTime.stop_time_type === 'via' && !stopTime.arrival) {
    return 'via';
  }

  return stopTime.arrival ? stopTime.arrival.substring(0, 5) : '--';
};

export const getServiceBadge = (trip) => {
  const activeDays = SERVICE_DAYS
    .map((day, index) => ({ ...day, index }))
    .filter((day) => trip[day.key]);

  const ranges = [];
  let rangeStart = null;
  let previousDay = null;

  activeDays.forEach((day) => {
    if (!rangeStart) {
      rangeStart = day;
      previousDay = day;
      return;
    }

    if (day.index === previousDay.index + 1) {
      previousDay = day;
      return;
    }

    ranges.push(rangeStart.index === previousDay.index ? rangeStart.short : `${rangeStart.short}–${previousDay.short}`);
    rangeStart = day;
    previousDay = day;
  });

  if (rangeStart) {
    ranges.push(rangeStart.index === previousDay.index ? rangeStart.short : `${rangeStart.short}–${previousDay.short}`);
  }

  if (trip.public_holiday) {
    ranges.push('Public Holiday');
  }

  return ranges.join(', ') || 'No Service Days';
};

export const getTripDetails = (trip, rows) => {
  const stops = (rows || []).flatMap((row) => {
    const cell = (row.stop_times || []).find((item) => Number(item.trip_id) === Number(trip.trip_id));
    return cell && cell.stop_time_type !== 'not_served' && (cell.arrival || cell.stop_time_type === 'via')
      ? [{ name: row.name, sequence: row.sequence, ...cell }] : [];
  }).sort((a, b) => a.sequence - b.sequence);
  const firstTimedStop = stops.find((stop) => stop.arrival);
  return { stops, firstTimedStop, lastStop: stops.at(-1), firstTime: firstTimedStop?.arrival || trip.first_arrival || '' };
};

export const getVisibleTrips = (trips, selectedServiceDay, rows) => {
  if (!selectedServiceDay) {
    return [];
  }

  return (trips || []).filter((trip) => trip[selectedServiceDay])
    .map((trip) => ({ ...trip, details: getTripDetails(trip, rows) }))
    .sort((firstTrip, secondTrip) => {
    const firstArrival = firstTrip.details.firstTime || '99:99';
    const secondArrival = secondTrip.details.firstTime || '99:99';

    return (
      firstArrival.localeCompare(secondArrival) ||
      firstTrip.trip_id - secondTrip.trip_id
    );
  });
};

const TripDetails = ({ trip, day, onClose }) => {
  const dialog = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement;
    element.showModal();
    element.querySelector('button').focus();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog ref={dialog} className="trip-details-dialog" aria-labelledby={titleId} onClose={onClose}>
      <button type="button" className="trip-details-close" onClick={onClose}>Close</button>
      <h2 id={titleId}>{trip.details.firstTime.slice(0, 5) || 'Untimed'} trip details</h2>
      <p>Shown in the <strong>{day} timetable</strong>. Runs {getServiceBadge(trip)}.</p>
      {trip.details.firstTimedStop && <p>First timed stop: <strong>{trip.details.firstTimedStop.name}</strong> at {trip.details.firstTime.slice(0, 5)}.</p>}
      <ol className="trip-stop-list">
        {trip.details.stops.map((stop, index) => (
          <li key={`${stop.sequence}-${index}`}><span>{stop.name}</span><strong>{formatStopTime(stop)}</strong></li>
        ))}
      </ol>
      <p className="trip-legend"><strong>via</strong>: passes through; no time listed. <strong>--</strong> in the table: this trip does not serve that stop.</p>
    </dialog>
  );
};

export const getVisibleRows = (rows, visibleTrips) => {
  const visibleTripIds = new Set(
    (visibleTrips || []).map((trip) => Number(trip.trip_id))
  );

  if (visibleTripIds.size === 0) {
    return [];
  }

  return (rows || []).filter((row) =>
    (row.stop_times || []).some((stopTime) =>
      visibleTripIds.has(Number(stopTime.trip_id))
    )
  );
};

const getTimesByTripId = (row) => {
  return (row.stop_times || []).reduce((result, stopTime) => {
    result[stopTime.trip_id] = stopTime;
    return result;
  }, {});
};

const ScheduleTable = ({
  selectedDirection,
  selectedServiceDay,
  scheduleData,
  route,
  savedOffline,
  onSaveOfflineChange,
  offlineSaveMessage,
}) => {
  const [selectedTripId, setSelectedTripId] = useState(null);
  useEffect(() => { setSelectedTripId(null); }, [selectedDirection, selectedServiceDay, scheduleData]);
  if (!scheduleData) {
    return (
      <div className='schedule-table'>
        <div className='route-title'>
          <h1>{route ? getRouteSeoTitle(route) : 'Timetable'}</h1>
        </div>
        <p>Loading schedule data...</p>
      </div>
    );
  }

  const defaultDirection = Object.keys(scheduleData)[0];
  const directionData = selectedDirection !== '' ? scheduleData[selectedDirection] : scheduleData[defaultDirection];
  const visibleTrips = directionData ? getVisibleTrips(directionData.trips, selectedServiceDay, directionData.rows) : [];
  const visibleRows = directionData ? getVisibleRows(directionData.rows, visibleTrips) : [];
  const columnCount = visibleTrips.length;
  const agencyName = getAgencyDisplayName(route?.agency);
  const stopCount = visibleRows.length;
  const serviceDayText = selectedServiceDay
    ? selectedServiceDay.replace(/_/g, ' ')
    : 'the selected service day';
  const dayLabel = serviceDayText.charAt(0).toUpperCase() + serviceDayText.slice(1);
  const selectedTrip = visibleTrips.find((trip) => trip.trip_id === selectedTripId);

  return (
    <div className='schedule-table'>
      <div className='route-title'>
        <h1>{route ? getRouteSeoTitle(route) : 'Table'}</h1>
        {route && onSaveOfflineChange && (
          <label className="save-offline-toggle">
            <input
              type="checkbox"
              checked={Boolean(savedOffline)}
              onChange={(event) => onSaveOfflineChange(event.target.checked)}
            />
            <span>Save offline</span>
          </label>
        )}
      </div>
      {offlineSaveMessage && <p className="offline-save-error" role="alert">{offlineSaveMessage}</p>}
      {selectedServiceDay && (
        <div className="selected-day-summary" aria-live="polite">
          <h2>{dayLabel} timetable</h2>
          <p>{visibleTrips.length ? `All trips shown run on ${dayLabel}. Each column also shows its full operating days.` : `No trips listed for ${dayLabel}.`}</p>
        </div>
      )}
      {route && directionData && (
        <p className="route-summary">
          This {agencyName} timetable lists {stopCount} stops for {directionData.name || selectedDirection || 'this direction'}
          {' '}and {visibleTrips.length} trips for {serviceDayText}. Fika is independent, so confirm urgent service changes with the operator.
        </p>
      )}
      {directionData !== undefined ? (
        <div className="table-container">
          <table
            className="timetable"
            style={{
              '--column-count': columnCount,
            }}
          >
            <thead>
              <tr>
                <th className="stop-heading">Stops</th>
                {visibleTrips.map((trip) => (
                  <th key={trip.trip_id} scope="col" className="trip-heading">
                    <button type="button" className="trip-heading-button" aria-haspopup="dialog"
                      aria-label={`${trip.details.firstTime.slice(0, 5) || 'Untimed'} to ${trip.details.lastStop?.name || 'last listed stop'}, runs ${getServiceBadge(trip)}. Trip details`}
                      onClick={() => setSelectedTripId(trip.trip_id)}>
                      <strong>{trip.details.firstTime.slice(0, 5) || '--'}</strong>
                      <span className="trip-destination">To {trip.details.lastStop?.name || 'last listed stop'}</span>
                      <span className="trip-operating-days">Runs {getServiceBadge(trip)}</span>
                      <span className="trip-details-hint">Trip details</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => {
                const timesByTripId = getTimesByTripId(row);

                return (
                  <tr key={`${row.name}-${rowIndex}`} data-id={rowIndex}>
                    <td className="stop-cell">{row.name}</td>
                    {visibleTrips.map((trip) => (
                      <td
                        key={trip.trip_id}
                        className={timesByTripId[trip.trip_id]?.stop_time_type || ''}
                      >
                        {formatStopTime(timesByTripId[trip.trip_id])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p>Loading schedule data...</p>
      )}
      {selectedTrip && <TripDetails trip={selectedTrip} day={dayLabel} onClose={() => setSelectedTripId(null)} />}
    </div>
  );
};

export default ScheduleTable;
