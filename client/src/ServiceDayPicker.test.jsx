import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ServiceDayPicker from './ServiceDayPicker';

const days = [{ key: 'monday', label: 'Monday' }, { key: 'public_holiday', label: 'Public Holiday' }];

test('drawer focuses the selected day, selects a holiday and restores the trigger focus', () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  const onChange = jest.fn();
  render(<ServiceDayPicker days={days} value="monday" onChange={onChange} />);
  const trigger = screen.getByRole('button', { name: 'Service day: Monday' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(trigger);
  const drawer = screen.getByRole('dialog', { name: 'Select service day' });
  expect(within(drawer).getByRole('button', { name: 'Monday', exact: true })).toHaveFocus();
  fireEvent.click(within(drawer).getByRole('button', { name: 'Public Holiday', exact: true }));
  expect(onChange).toHaveBeenCalledWith('public_holiday');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(trigger).toHaveFocus();
});
