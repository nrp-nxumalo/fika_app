const SERVICE_DAYS = [
  ['monday', 'Mon'], ['tuesday', 'Tue'], ['wednesday', 'Wed'],
  ['thursday', 'Thu'], ['friday', 'Fri'], ['saturday', 'Sat'], ['sunday', 'Sun'],
];

export const normalizeStopName = (name) => String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-ZA');

export const getServiceBadge = (trip) => {
  const activeDays = SERVICE_DAYS.map(([key, short], index) => ({ key, short, index })).filter(day => trip[day.key]);
  const ranges = [];
  let start;
  let end;
  const addRange = () => { if (start) ranges.push(start === end ? start.short : `${start.short}–${end.short}`); };
  activeDays.forEach(day => {
    if (end && day.index !== end.index + 1) { addRange(); start = null; }
    if (!start) start = day;
    end = day;
  });
  addRange();
  if (trip.public_holiday) ranges.push('Public Holiday');
  return ranges.join(', ') || 'No Service Days';
};

export const parseTimeMinutes = (time) => {
  const match = String(time || '').match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export const formatTripTime = (minutes) => minutes === null || minutes === undefined
  ? 'Time not published'
  : `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export const formatDayOffset = (minutes) => {
  const days = Math.floor((minutes || 0) / 1440);
  return days > 1 ? `${days} days later` : days === 1 ? 'Next day' : '';
};

export const formatDuration = (minutes) => {
  if (minutes === null || minutes === undefined) return 'Not available';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours} hr${remainder ? ` ${remainder} min` : ''}` : `${remainder} min`;
};

export const getTripDetails = (trip, rows, boardingStop = '') => {
  let previousTime = null;
  let dayOffset = 0;
  let inferredMidnight = false;
  const stops = (rows || []).flatMap(row => {
    const cell = (row.stop_times || []).find(item => String(item.trip_id) === String(trip.trip_id));
    return cell && cell.stop_time_type !== 'not_served' && (cell.arrival || ['via', 'scheduled'].includes(cell.stop_time_type))
      ? [{ ...cell, name: row.name, sequence: row.sequence, key: normalizeStopName(row.name) }] : [];
  }).sort((a, b) => Number(a.sequence) - Number(b.sequence)).map(stop => {
    let minutes = parseTimeMinutes(stop.arrival);
    let timingIssue = false;
    if (minutes !== null) {
      if (minutes < 1440) minutes += dayOffset;
      if (previousTime !== null && minutes < previousTime) {
        // A clock crossing midnight jumps back by most of a day. Small backward
        // steps are inconsistent source times, including MyCiTi loop stops whose
        // PDF repeats the time of their first visit. They must not create extra days.
        if (!inferredMidnight && dayOffset === 0 && previousTime - minutes > 720) {
          dayOffset = 1440;
          minutes += dayOffset;
          inferredMidnight = true;
        } else {
          timingIssue = true;
        }
      }
      previousTime = Math.max(previousTime ?? minutes, minutes);
      dayOffset = Math.floor(previousTime / 1440) * 1440;
    }
    return { ...stop, minutes, timingIssue };
  });
  const firstStop = stops[0];
  const lastStop = stops[stops.length - 1];
  const departureStop = boardingStop ? stops.find(stop => stop.key === boardingStop) : firstStop;
  const departureMinutes = departureStop?.minutes ?? null;
  const arrivalMinutes = lastStop?.minutes ?? null;
  return {
    stops, firstStop, firstTimedStop: stops.find(stop => stop.minutes !== null), lastStop, departureStop,
    firstTime: firstStop?.arrival || '', departureMinutes, arrivalMinutes,
    hasTimingIssues: stops.some(stop => stop.timingIssue),
    durationMinutes: departureMinutes !== null && arrivalMinutes !== null && arrivalMinutes >= departureMinutes
      && !departureStop?.timingIssue && !lastStop?.timingIssue ? arrivalMinutes - departureMinutes : null,
  };
};

export const getVisibleTrips = (trips, selectedServiceDay, rows, boardingStop = '') => {
  if (!selectedServiceDay) return [];
  return (trips || []).filter(trip => trip[selectedServiceDay])
    .map(trip => ({ ...trip, details: getTripDetails(trip, rows, boardingStop) }))
    .filter(trip => !boardingStop || trip.details.departureStop)
    .sort((a, b) => (a.details.departureMinutes ?? Infinity) - (b.details.departureMinutes ?? Infinity)
      || String(a.trip_id).localeCompare(String(b.trip_id), undefined, { numeric: true }));
};

export const getBoardingStops = (trips) => {
  const names = new Map();
  trips.forEach(trip => trip.details.stops.forEach(stop => {
    if (stop.key && !names.has(stop.key)) names.set(stop.key, { key: stop.key, name: stop.name });
  }));
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-ZA'));
};

// Kept as an export for callers using the previous timetable helpers.
export const getVisibleRows = (rows, trips) => {
  const ids = new Set((trips || []).map(trip => String(trip.trip_id)));
  return (rows || []).filter(row => (row.stop_times || []).some(stop => ids.has(String(stop.trip_id))
    && stop.stop_time_type !== 'not_served' && (stop.arrival || stop.stop_time_type === 'via')));
};
