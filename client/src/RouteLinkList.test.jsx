import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import RouteLinkList from './RouteLinkList';

const route = {
  id: 2,
  agency: 'GABS',
  code: '0002',
  name: 'CAPE TOWN - BLAAUWBERG',
};

test('uses compact endpoint tiles with operator and route code on operator pages', () => {
  render(<RouteLinkList routes={[route]} emptyMessage="" compact />);

  expect(screen.getByRole('link', { name: 'Golden Arrow 0002 Cape Town → Blaauwberg' })).toHaveAttribute('href', '/timetables/golden-arrow/route-0002-cape-town-blaauwberg');
  expect(screen.getByText('Golden Arrow')).toBeInTheDocument();
});

test('shows via places and one status badge in the default listing', () => {
  render(<RouteLinkList routes={[{ ...route, name: 'Bluedowns - Mowbray - Cape Town', timetableStatus: { label: 'Update pending', kind: 'pending' } }]} emptyMessage="" />);

  expect(screen.getByText('Bluedowns → Cape Town')).toBeInTheDocument();
  expect(screen.getByText('via Mowbray')).toBeInTheDocument();
  expect(screen.getByText('Update pending')).toBeInTheDocument();
});

test('supports in-app route selection while retaining normal modified links', () => {
  const onRouteSelect = jest.fn();
  render(<RouteLinkList routes={[route]} onRouteSelect={onRouteSelect} selectionSource="landing_search" />);
  const link = screen.getByRole('link');
  fireEvent.click(link);
  expect(onRouteSelect).toHaveBeenCalledWith(route, { source: 'landing_search' });
  fireEvent.click(link, { ctrlKey: true });
  expect(onRouteSelect).toHaveBeenCalledTimes(1);
});
