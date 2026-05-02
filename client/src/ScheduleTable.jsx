import React from 'react';

const SERVICE_DAYS = [
  { key: 'monday', short: 'Mon' },
  { key: 'tuesday', short: 'Tue' },
  { key: 'wednesday', short: 'Wed' },
  { key: 'thursday', short: 'Thu' },
  { key: 'friday', short: 'Fri' },
  { key: 'saturday', short: 'Sat' },
  { key: 'sunday', short: 'Sun' },
];

const AGENCY_LOGOS = {
  GABS: '/agency-logos/gabs.png',
  MyCiti: '/agency-logos/myciti.png',
};

const LOGO_PATTERN_ROWS = 5;
const LOGOS_PER_PATTERN_ROW = 4;

const formatStopTime = (stopTime) => {
  if (!stopTime || stopTime.stop_time_type === 'not_served') {
    return '--';
  }

  if (stopTime.stop_time_type === 'via' && !stopTime.arrival) {
    return 'via';
  }

  return stopTime.arrival ? stopTime.arrival.substring(0, 5) : '--';
};

const getServiceBadge = (trip) => {
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

    ranges.push(rangeStart.index === previousDay.index ? rangeStart.short : `${rangeStart.short}-${previousDay.short}`);
    rangeStart = day;
    previousDay = day;
  });

  if (rangeStart) {
    ranges.push(rangeStart.index === previousDay.index ? rangeStart.short : `${rangeStart.short}-${previousDay.short}`);
  }

  if (trip.public_holiday) {
    ranges.push('Public Holiday');
  }

  return ranges.join(', ') || 'No Service Days';
};

const getVisibleTrips = (rows, selectedServiceDay) => {
  const trips = new Map();

  rows.forEach((row) => {
    row.stop_times?.forEach((stopTime) => {
      if (selectedServiceDay && !stopTime[selectedServiceDay]) {
        return;
      }

      if (!trips.has(stopTime.trip_id)) {
        trips.set(stopTime.trip_id, stopTime);
      }
    });
  });

  return [...trips.values()].sort((firstTrip, secondTrip) => {
    const firstArrival = firstTrip.first_arrival || '';
    const secondArrival = secondTrip.first_arrival || '';

    return (
      secondTrip.service_pattern.localeCompare(firstTrip.service_pattern) ||
      firstArrival.localeCompare(secondArrival) ||
      firstTrip.trip_id - secondTrip.trip_id
    );
  });
};

const getTimesByTripId = (row) => {
  return (row.stop_times || []).reduce((result, stopTime) => {
    result[stopTime.trip_id] = stopTime;
    return result;
  }, {});
};

const getAgencyLogo = (agency) => {
  return AGENCY_LOGOS[agency] || null;
};

const ScheduleTable = ({
  selectedDirection,
  selectedServiceDay,
  scheduleData,
  route,
  savedOffline,
  onSaveOfflineChange,
}) => {
  if (!scheduleData) {
    return (
      <div className='schedule-table'>
        <div className='route-title'>
          <h1>{route ? `${route.agency}: ${route.name}` : 'Timetable'}</h1>
        </div>
        <p>Loading schedule data...</p>
      </div>
    );
  }

  const defaultDirection = Object.keys(scheduleData)[0];
  const directionData = selectedDirection !== '' ? scheduleData[selectedDirection] : scheduleData[defaultDirection];
  const visibleTrips = directionData ? getVisibleTrips(directionData, selectedServiceDay) : [];
  const agencyLogo = getAgencyLogo(route?.agency);
  const columnCount = visibleTrips.length;

  return (
    <div className='schedule-table'>
      <div className='route-title'>
        <h1>{route ? `${route.agency}: ${route.name}` : 'Table'}</h1>
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
      {directionData !== undefined ? (
        <div className="table-container">
          {agencyLogo && (
            <div className="agency-logo-pattern" aria-hidden="true">
              {Array.from({ length: LOGO_PATTERN_ROWS }, (_, rowIndex) => (
                <div className="agency-logo-pattern-row" key={rowIndex}>
                  {Array.from({ length: LOGOS_PER_PATTERN_ROW }, (_, logoIndex) => (
                    <img key={logoIndex} src={agencyLogo} alt="" />
                  ))}
                </div>
              ))}
            </div>
          )}
          <table
            className={`timetable ${agencyLogo ? 'has-agency-watermark' : ''}`}
            style={{
              '--column-count': columnCount,
            }}
          >
            <thead>
              <tr>
                <th className="stop-heading">Stops</th>
                {visibleTrips.map((trip) => (
                  <th key={trip.trip_id}>
                    {getServiceBadge(trip)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {directionData.map((row, rowIndex) => {
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
    </div>
  );
};

export default ScheduleTable;
