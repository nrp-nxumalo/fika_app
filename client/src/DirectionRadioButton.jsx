function DirectionRadioButton({ route, setSelectedDirection, selectedDirection }) {
  

  const handleOptionChange = (event) => {
    setSelectedDirection(event.target.value);
  };

  return (
      (route?.direction_1 && route?.direction_2) !== undefined ? (
      <div className="direction-toggle-container">
        <label className="direction-toggle-label">Select Direction</label>
        <fieldset className="direction-toggle">
          <div class="toggle">
              <input
                id="direction_1"
                type="radio"
                value={route.direction_1}
                checked={selectedDirection === route.direction_1}
                onChange={handleOptionChange}
              />
            <label for="direction_1">
              {route.direction_1}
            </label>
              <input
                id="direction_2"
                type="radio"
                value={route.direction_2}
                checked={selectedDirection === route.direction_2}
                onChange={handleOptionChange}
              />
              <label for="direction_2">
              {route.direction_2}
            </label>
          </div>
        </fieldset>
      </div>
    ) : <div><p>{route?.direction_1 ? route?.direction_1 : route?.direction_2 }</p></div>
  );
}

export default DirectionRadioButton;