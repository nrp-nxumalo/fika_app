import React, { useState } from 'react';

const getRouteLabel = (route) => {
  return route.code ? `${route.code} - ${route.name}` : route.name;
};

const SchedulesDropdown = ({
  className = '',
  placeholder = 'Search route...',
  onRouteSelect,
  onAgencyChange,
  route,
  schedules,
  selectedAgency,
  setRoute,
  setSelectedAgency,
  setSelectedDirection,
}) => {
  const [query, setQuery] = useState('');
  const [showOptions, setShowOptions] = useState(false);

  const agencies = [...new Set(schedules.map((schedule) => schedule.agency))].filter(Boolean);

  const handleAgencyChange = (event) => {
    const agency = event.target.value;

    if (onAgencyChange) {
      onAgencyChange(agency);
    } else {
      setSelectedAgency(agency);
    }

    setQuery('');
  };

  const handleRouteSelect = (selectedOption) => {
    const routeObj = schedules.find((schedule) => schedule.id === selectedOption.id);

    setRoute(routeObj);
    setSelectedAgency(routeObj.agency);
    setSelectedDirection(routeObj.direction_1 || routeObj.direction_2 || '');
    onRouteSelect?.(routeObj);
  };

  const filtered = schedules.filter((schedule) =>
    (!selectedAgency || schedule.agency === selectedAgency) &&
    getRouteLabel(schedule).toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className={`schedule-picker ${className}`.trim()}>
      {agencies.length > 0 && (
        <select
          className="agency-select"
          value={selectedAgency}
          onChange={handleAgencyChange}
        >
          {agencies.map((agency) => (
            <option key={agency} value={agency}>
              {agency}
            </option>
          ))}
        </select>
      )}
      <div className="dropdown">
        <input
          type="text"
          value={query}
          placeholder={route ? getRouteLabel(route) : placeholder}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => setShowOptions(true)}
          onBlur={() => setTimeout(() => setShowOptions(false), 100)}
        />
        {showOptions && (
          <ul className="dropdown-menu">
            {filtered.map((schedule) => (
              <li
                key={schedule.id}
                onMouseDown={() => {
                  handleRouteSelect(schedule);
                  setQuery('');
                  setShowOptions(false);
                }}
              >
                <span>{getRouteLabel(schedule)}</span>
                <small>{schedule.agency}</small>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default SchedulesDropdown;
