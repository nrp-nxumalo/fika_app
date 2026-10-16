import React, { useEffect, useState } from 'react';
import { getCachedTimetableStatus, saveTimetableStatusToCache } from './timetableCache';

export const capeTownDay = (date = new Date()) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Johannesburg', weekday: 'long',
}).format(date).toLowerCase();

export const capeTownDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(date);

export const formatNoticeDate = (value) => new Intl.DateTimeFormat('en-ZA', {
  timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'short', year: 'numeric',
}).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));

const directionKey = (value) => String(value || '').replace(/^to\s+/i, '').trim().toLowerCase().replace(/\s+/g, ' ');
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

export const getRouteStatus = (report, route, { direction, serviceDay, today = capeTownDate(), cached = false } = {}) => {
  if (!route || !Array.isArray(report?.routes)) return null;
  const entry = report.routes.find((item) => item.agency === route.agency && String(item.code).toLowerCase() === String(route.code).toLowerCase());
  const contributions = (entry?.directions || []).filter((item) =>
    (!direction || directionKey(item.name) === directionKey(direction)) &&
    (!serviceDay || item.service_days?.includes(serviceDay))
  );
  const expired = contributions.filter((item) => validDate(item.valid_until) && item.valid_until < today);
  const pending = contributions.filter((item) => item.pending);
  if (!expired.length && !pending.length) return null;
  const futureOnly = pending.length > 0 && pending.every((item) => validDate(item.pending_effective_date) && item.pending_effective_date > today);
  const dueDate = futureOnly ? pending.map((item) => item.pending_effective_date).sort()[0] : null;
  const kind = expired.length ? 'expired' : futureOnly ? 'upcoming' : 'pending';
  const label = kind === 'expired' ? 'Timetable needs updating'
    : kind === 'upcoming' ? `Update due ${formatNoticeDate(dueDate)}` : 'Update pending';
  return { kind, label, expired, pending, dueDate, cached, checkedAt: report.checked_at };
};

export function useTimetableStatus(routeKey, fetchJson) {
  const [status, setStatus] = useState({ report: null, cached: true, today: capeTownDate() });
  useEffect(() => {
    let active = true;
    let fetched = false;
    let request = 0;
    getCachedTimetableStatus().then((report) => {
      if (active && report && !fetched) setStatus({ report, cached: true, today: capeTownDate() });
    });
    const refresh = async () => {
      const currentRequest = ++request;
      if (navigator.onLine === false) {
        setStatus((previous) => ({ ...previous, cached: true, today: capeTownDate() }));
        return;
      }
      try {
        const report = await fetchJson('/api/timetable-status', 'Unable to check timetable updates');
        if (!Array.isArray(report?.routes) || !report.checked_at) throw new Error('Invalid status response');
        if (!active || currentRequest !== request) return;
        fetched = true;
        setStatus({ report, cached: false, today: capeTownDate() });
        await saveTimetableStatusToCache(report);
      } catch {
        if (active && currentRequest === request) setStatus((previous) => ({ ...previous, cached: true, today: capeTownDate() }));
      }
    };
    const offline = () => {
      request += 1;
      setStatus((previous) => ({ ...previous, cached: true, today: capeTownDate() }));
    };
    refresh();
    const timer = window.setInterval(refresh, 5 * 60 * 1000);
    window.addEventListener('online', refresh);
    window.addEventListener('offline', offline);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', offline);
    };
  }, [routeKey, fetchJson]);
  return status;
}

export default function TimetableStatusNotice({ status }) {
  if (!status) return null;
  const endDates = [...new Set(status.expired.map((item) => item.valid_until))].sort();
  const sourceLinks = [...new Set([...status.expired, ...status.pending].map((item) => item.official_source_url || item.pending_source_url))]
    .filter((url) => /^https?:\/\//i.test(url || ''));
  return (
    <aside className={`timetable-status-notice status-${status.kind}`} aria-label="Timetable update">
      <strong>{status.label}</strong>
      {endDates.length > 0 && <p>The published timetable {endDates.length > 1 ? 'end dates were' : 'end date was'} {endDates.map(formatNoticeDate).join(' and ')}. Fika is showing its last approved times. Confirm your trip with the operator.</p>}
      {status.pending.length > 0 && <p>{status.dueDate
        ? `An update is due from ${formatNoticeDate(status.dueDate)}. Showing the previous timetable until the update is published on Fika.`
        : 'A newer timetable is being checked. Showing the previous timetable.'}</p>}
      {status.cached && <p className="status-last-known">Last-known update information{status.checkedAt && !Number.isNaN(Date.parse(status.checkedAt)) ? ` · checked ${formatNoticeDate(capeTownDate(new Date(status.checkedAt)))}` : ''}. Connect to refresh.</p>}
      {sourceLinks.length > 0 && <div className="status-source-links">{sourceLinks.map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">Operator timetable{sourceLinks.length > 1 ? ` ${index + 1}` : ''}</a>)}</div>}
    </aside>
  );
}
