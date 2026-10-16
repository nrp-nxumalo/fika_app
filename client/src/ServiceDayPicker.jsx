import React, { useEffect, useId, useRef } from 'react';

export default function ServiceDayPicker({ days, value, onChange }) {
  const id = useId();
  const dialogRef = useRef(null);
  const triggerRef = useRef(null);
  const selectedDayRef = useRef(null);
  const label = days.find(day => day.key === value)?.label || 'Choose day';

  useEffect(() => {
    const viewport = window.matchMedia?.('(max-width: 680px)');
    const closeOnDesktop = event => { if (!event.matches) dialogRef.current?.close(); };
    viewport?.addEventListener('change', closeOnDesktop);
    return () => viewport?.removeEventListener('change', closeOnDesktop);
  }, []);

  return (
    <>
      <label className="route-day-control" htmlFor={`${id}-select`}>
        Service day
        <select id={`${id}-select`} value={value} onChange={event => onChange(event.target.value)}>
          {days.map(day => <option key={day.key} value={day.key}>{day.label}</option>)}
        </select>
      </label>
      <button ref={triggerRef} type="button" className="route-day-trigger"
        aria-haspopup="dialog" aria-controls={`${id}-drawer`} aria-label={`Service day: ${label}`}
        onClick={() => {
          dialogRef.current.showModal();
          selectedDayRef.current?.focus();
        }}>
        <span>Service day</span><strong>{label}</strong>
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16"><path d="m3 6 5 5 5-5" /></svg>
      </button>
      <dialog ref={dialogRef} id={`${id}-drawer`} className="route-day-drawer" aria-labelledby={`${id}-title`}
        onClose={() => triggerRef.current?.focus()}
        onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
        <div className="route-day-drawer-content">
          <div className="route-day-drawer-header">
            <h2 id={`${id}-title`}>Select service day</h2>
            <button type="button" onClick={() => dialogRef.current.close()}>Close</button>
          </div>
          <div className="route-day-options">
            {days.map(day => <button key={day.key} type="button" aria-pressed={value === day.key}
              ref={value === day.key ? selectedDayRef : null}
              onClick={() => { onChange(day.key); dialogRef.current.close(); }}>
              {day.label}
            </button>)}
          </div>
        </div>
      </dialog>
    </>
  );
}
