import React, { useState } from 'react';

const SchedulesDropdown = ({setRoute, schedules, setSelectedDirection}) => {
  const handleRouteSelect = (selectedOption) => {
    const routeObj = schedules.find(route => route.id === selectedOption.id);
    setRoute(routeObj);
    setSelectedDirection(routeObj.direction_1);
  };

  const [query, setQuery] = useState('');
  const [showOptions, setShowOptions] = useState(false);

  const filtered = schedules.filter(schedule =>
    schedule.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div className="dropdown">
      <input
        type="text"
        value={query}
        placeholder="Search route..."
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setShowOptions(true)}
        onBlur={() => setTimeout(() => setShowOptions(false), 100)}
      />
      {showOptions && (
        <ul className="dropdown-menu">
          {filtered.map(schedule => (
            <li
              key={schedule.id}
              onMouseDown={() => {
                handleRouteSelect(schedule);
                setQuery(schedule.name);
                setShowOptions(false);
              }}
            >
              {schedule.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default SchedulesDropdown;