import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import {
  __resetAnalyticsForTests,
  initializeAnalytics,
} from './analytics';
import SchedulesDropdown from './SchedulesDropdown';

const dataLayerEntries = () => (window.dataLayer || []).map((entry) => Array.from(entry));

beforeEach(() => {
  jest.useFakeTimers();
  __resetAnalyticsForTests();
  window.localStorage.clear();
  window.__FIKA_CONFIG__ = { ga4MeasurementId: 'G-TEST123' };
  document.getElementById('fika-ga4-script')?.remove();
  delete window.gtag;
  delete window.dataLayer;
  initializeAnalytics();
});

const routes = [
  { id: 1, agency: 'GABS', code: '0098', name: 'Bluedowns - Cape Town', direction_1: 'Bluedowns - Mowbray - Cape Town' },
  { id: 2, agency: 'MyCiti', code: '214A', name: 'Atlantis - Cape Town' },
];

test('offers friendly operators and accessible keyboard route selection', () => {
  const onRouteSelect = jest.fn();
  render(<SchedulesDropdown schedules={routes} onRouteSelect={onRouteSelect} />);
  expect(screen.getByRole('combobox', { name: 'Operator' })).toHaveValue('');
  expect(screen.getByRole('option', { name: 'All operators' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Golden Arrow' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'MyCiTi' })).toBeInTheDocument();
  const input = screen.getByRole('combobox', { name: 'Search routes' });
  fireEvent.focus(input);
  expect(input).toHaveAttribute('aria-expanded', 'true');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: /Golden Arrow 0098/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  const secondOption = screen.getByRole('option', { name: /MyCiTi 214A/ });
  expect(input).toHaveAttribute('aria-activedescendant', secondOption.id);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onRouteSelect).toHaveBeenCalledWith(routes[1], { source: 'timetable_search' });
  expect(input).toHaveAttribute('aria-expanded', 'false');
});

test('searches via places, supports pointer selection and dismisses results with Escape', () => {
  const onRouteSelect = jest.fn();
  render(<SchedulesDropdown schedules={routes} onRouteSelect={onRouteSelect} />);
  const input = screen.getByRole('combobox', { name: 'Search routes' });
  fireEvent.change(input, { target: { value: 'Mowbray' } });
  const result = screen.getByRole('option', { name: /Bluedowns → Cape Town via Mowbray/ });
  fireEvent.mouseDown(result);
  fireEvent.click(result);
  expect(onRouteSelect).toHaveBeenCalledWith(routes[0], { source: 'timetable_search' });
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: 'ArrowUp' });
  expect(screen.getByRole('option', { name: /MyCiTi 214A/ })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
});

test('announces when no routes match and never selects an absent result', () => {
  const onRouteSelect = jest.fn();
  render(<SchedulesDropdown schedules={routes} onRouteSelect={onRouteSelect} />);
  const input = screen.getByRole('combobox', { name: 'Search routes' });
  fireEvent.change(input, { target: { value: 'Unknown place' } });
  expect(screen.getByRole('status')).toHaveTextContent('No routes found');
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onRouteSelect).not.toHaveBeenCalled();
});

test('supports a shared home search state without a second popup and keeps search text on operator changes', () => {
  const onQueryChange = jest.fn();
  const onAgencyChange = jest.fn();
  const onRouteSelect = jest.fn();
  const { rerender } = render(<SchedulesDropdown schedules={routes} query="Cape" onQueryChange={onQueryChange} onAgencyChange={onAgencyChange} onRouteSelect={onRouteSelect} showResults={false} />);
  const input = screen.getByRole('searchbox', { name: 'Search routes' });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'Atlantis' } });
  expect(onQueryChange).toHaveBeenCalledWith('Atlantis');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('combobox', { name: 'Operator' }), { target: { value: 'MyCiti' } });
  expect(onAgencyChange).toHaveBeenCalledWith('MyCiti');
  expect(onQueryChange).toHaveBeenCalledTimes(1);
  rerender(<SchedulesDropdown schedules={routes} query="Atlantis" selectedAgency="MyCiti" onRouteSelect={onRouteSelect} showResults={false} />);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onRouteSelect).toHaveBeenCalledWith(routes[1], { source: 'timetable_search' });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

test('debounces search metrics without sending raw search text', () => {
  render(
    <SchedulesDropdown
      schedules={[{
        id: 1,
        agency: 'GABS',
        code: '0004',
        name: 'ATLANTIS - CAPE TOWN',
      }]}
      selectedAgency="GABS"
      onAgencyChange={() => {}}
      onRouteSelect={() => {}}
      route={null}
      searchLocation="landing_search"
    />
  );

  fireEvent.change(screen.getByPlaceholderText('Search route...'), {
    target: { value: 'Private unmatched search' },
  });
  jest.advanceTimersByTime(749);
  expect(dataLayerEntries().some((entry) => entry[1] === 'route_search')).toBe(false);
  jest.advanceTimersByTime(1);

  const searchEvents = dataLayerEntries().filter((entry) =>
    entry[1] === 'route_search' || entry[1] === 'no_search_results'
  );
  expect(searchEvents).toHaveLength(2);
  searchEvents.forEach((entry) => {
    expect(entry[2]).toEqual({
      agency: 'GABS',
      search_location: 'landing_search',
      result_count: 0,
      query_length_bucket: '8+',
    });
    expect(JSON.stringify(entry[2])).not.toMatch(/private|unmatched|search_term/i);
  });
});
