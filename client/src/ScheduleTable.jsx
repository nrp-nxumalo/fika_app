import React from 'react';

const ScheduleTable = ({ selectedDirection, scheduleData, route }) => {
  const defaultDirection = Object.keys(scheduleData)[0]

  const directionData = selectedDirection !== '' ? scheduleData[selectedDirection] : scheduleData[defaultDirection]
  return (
    <div>
      <div className='route-title'>
        <h1>{route !== undefined ? route?.name : 'Table' }</h1>
      </div>
      {directionData !== undefined ? (
        <div className="table-container">
          <div className='side'></div>
          <div>
            <table className='stop-column'>
              <tbody>
                {directionData.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                      <td key={rowIndex}>{row['name']}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="time-table">
            <table>
              <tbody>
                {directionData.map((row, rowIndex) => (
                  <tr key={rowIndex} data-id={rowIndex}>
                    {Object.values(row['stop_times']).map((value, colIndex) => (
                      <td key={colIndex}>{value === null ? "--" : value.substring(0,5)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className='side'></div>
        </div>
      ) : (
        <p>Loading schedule data...</p>
      )}
    </div>
  );
};

export default ScheduleTable;