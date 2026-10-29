import React from 'react';
import '@testing-library/jest-dom';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import TimetableStatusNotice, { capeTownDay, capeTownDate, getRouteStatus, useTimetableStatus } from './TimetableStatus';
import { getCachedTimetableStatus, saveTimetableStatusToCache } from './timetableCache';

jest.mock('./timetableCache', () => ({
  getCachedTimetableStatus: jest.fn(), saveTimetableStatusToCache: jest.fn(),
}));

const route = { agency: 'GABS', code: '0098' };
const contribution = { name: 'Bluedowns - Cape Town', service_days: ['monday'], valid_until: '2026-10-14', pending: true, pending_effective_date: '2026-10-19', official_source_url: 'https://www.gabs.co.za/example.pdf' };
const report = { checked_at: '2026-10-14T01:00:00Z', routes: [{ ...route, directions: [contribution] }] };

beforeEach(() => {
  getCachedTimetableStatus.mockResolvedValue(null);
  saveTimetableStatusToCache.mockResolvedValue();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

test('uses Johannesburg date boundaries and exact day/direction scopes', () => {
  expect(capeTownDay(new Date('2026-10-14T22:30:00Z'))).toBe('thursday');
  expect(capeTownDate(new Date('2026-10-14T22:30:00Z'))).toBe('2026-10-15');
  expect(getRouteStatus(report, route, { today: '2026-10-14' }).kind).toBe('upcoming');
  expect(getRouteStatus(report, route, { today: '2026-10-15' }).kind).toBe('expired');
  expect(getRouteStatus(report, route, { serviceDay: 'public_holiday' })).toBeNull();
  expect(getRouteStatus(report, route, { direction: 'Cape Town - Bluedowns' })).toBeNull();
  expect(getRouteStatus(report, route, { direction: 'TO BLUEDOWNS - CAPE TOWN' })).not.toBeNull();
});

test('combines expiry and a pending update and identifies last-known notices', () => {
  const status = getRouteStatus(report, route, { today: '2026-10-15', cached: true });
  render(<TimetableStatusNotice status={status} />);
  expect(screen.getByText('Timetable needs updating')).toBeInTheDocument();
  expect(screen.getByText(/published timetable end date was 14 Oct 2026/)).toBeInTheDocument();
  expect(screen.getByText(/update is due from 19 Oct 2026/)).toBeInTheDocument();
  expect(screen.getByText(/Last-known update information/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Operator timetables' })).toHaveAttribute('href', 'https://www.gabs.co.za/Timetable.aspx');
});

test.each([
  ['GABS', 'https://www.gabs.co.za/Timetable.aspx'],
  ['MyCiti', 'https://www.myciti.org.za/en/timetables/timetable-downloads/'],
])('uses the current %s catalogue even when cached notices contain retired PDF links', (agency, url) => {
  const selectedRoute = { ...route, agency };
  const cachedReport = { ...report, routes: [{ ...selectedRoute, directions: [
    { ...contribution, official_source_url: 'https://example.com/retired.pdf', pending_source_url: 'https://example.com/new.pdf' },
    { ...contribution, official_source_url: null, pending_source_url: null },
  ] }] };
  render(<TimetableStatusNotice status={getRouteStatus(cachedReport, selectedRoute, { cached: true, today: '2026-10-15' })} />);
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Operator timetables' })).toHaveAttribute('href', url);
});

test('unknown dates and nonpending evidence do not create a warning', () => {
  const quiet = { ...report, routes: [{ ...route, directions: [{ ...contribution, pending: false, valid_until: null }] }] };
  expect(getRouteStatus(quiet, route)).toBeNull();
  expect(getRouteStatus(null, route)).toBeNull();
});

test('cached status survives a network failure and refreshes independently on reconnect and route opening', async () => {
  getCachedTimetableStatus.mockResolvedValue(report);
  const fetchJson = jest.fn().mockRejectedValueOnce(new Error('offline'));
  const { result, rerender } = renderHook(({ routeKey }) => useTimetableStatus(routeKey, fetchJson), { initialProps: { routeKey: 'GABS:0098' } });
  await waitFor(() => expect(result.current.report).toEqual(report));
  expect(result.current.cached).toBe(true);
  const current = { checked_at: '2026-10-15T03:00:00Z', routes: [] };
  fetchJson.mockResolvedValue(current);
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(result.current.report).toEqual(current));
  expect(result.current.cached).toBe(false);
  expect(saveTimetableStatusToCache).toHaveBeenCalledWith(current);
  rerender({ routeKey: 'MyCiti:214A' });
  await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(3));
});

test('does not clear a pending notice until displayed times refresh, and retains it on failure', async () => {
  const current = { checked_at: '2026-10-15T03:00:00Z', routes: [] };
  const fetchJson = jest.fn().mockResolvedValue(report);
  const refreshTimetableRef = { current: jest.fn().mockResolvedValue(true) };
  const { result } = renderHook(() => useTimetableStatus('GABS:0098', fetchJson, refreshTimetableRef));
  await waitFor(() => expect(result.current.report).toEqual(report));
  fetchJson.mockResolvedValue(current);
  refreshTimetableRef.current.mockResolvedValueOnce(false);
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(result.current.cached).toBe(true));
  expect(result.current.report).toEqual(report);
  let complete;
  refreshTimetableRef.current.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  act(() => window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(complete).toBeDefined());
  expect(result.current.report).toEqual(report);
  await act(async () => complete(true));
  await waitFor(() => expect(result.current.report).toEqual(current));
  expect(result.current.cached).toBe(false);
});
