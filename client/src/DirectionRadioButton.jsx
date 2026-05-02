function DirectionRadioButton({ route, setSelectedDirection, selectedDirection }) {
  const directions = [route?.direction_1, route?.direction_2].filter(Boolean);
  const singleDirection = directions[0];

  const handleOptionChange = (event) => {
    setSelectedDirection(event.target.value);
  };

  return (
    directions.length > 1 ? (
      <div className="direction-toggle-container">
        <label className="direction-toggle-label">Select Direction</label>
        <fieldset className="direction-toggle">
          <div className="toggle">
              <input
                id="direction_1"
                type="radio"
                value={route.direction_1}
                checked={selectedDirection === route.direction_1}
                onChange={handleOptionChange}
              />
            <label htmlFor="direction_1">
              {route.direction_1}
            </label>
              <input
                id="direction_2"
                type="radio"
                value={route.direction_2}
                checked={selectedDirection === route.direction_2}
                onChange={handleOptionChange}
              />
              <label htmlFor="direction_2">
              {route.direction_2}
            </label>
          </div>
        </fieldset>
      </div>
    ) : (
      <div className="direction-toggle-container">
        <label className="direction-toggle-label">Direction</label>
        <fieldset className="direction-toggle">
          <div className="toggle single-direction-toggle">
            <input
              id="direction_single"
              type="radio"
              value={singleDirection}
              checked
              readOnly
            />
            <label htmlFor="direction_single">
              {singleDirection}
            </label>
          </div>
        </fieldset>
      </div>
    )
  );
}

export default DirectionRadioButton;
