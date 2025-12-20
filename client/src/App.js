import React, { useState, useEffect } from 'react';
import SchedulesDropdown from './SchedulesDropdown';
import ScheduleTable from './ScheduleTable';
import DirectionRadioButton from './DirectionRadioButton';
import Navbar from './Navbar';

function App() {
  const [scheduleData, setScheduleData] = useState(null);
  const [schedules, setSchedules] = useState([])
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedDirection, setSelectedDirection] = useState('');

  const groupBy = (array, key) => {
    return array.reduce((result, currentValue) => {
    
      const keyValue = currentValue[key];

      if (!result[keyValue]) {
        result[keyValue] = [];
      }

      result[keyValue].push(currentValue);
      
      return result;
    }, {}); 
  };

  useEffect(()=> {
    const fetchSchedules = async () => {
      try {
        const response = await fetch('http://localhost:4000/schedules');
        const data = await response.json();
        setSchedules(data);
        setRoute(data[0])
        setSelectedDirection(data[0].direction_1)
      } catch (error) {
        console.error("Error fetching schedules:", error);
      } finally {
        setLoading(false);
      }
    };

    const fecthWeekdayTimes = async () => {
      try {
        const response = await fetch(`http://localhost:4000/weekday_times/${route.id}`);
        const data = await response.json();
        const grouped_data = groupBy(data, 'direction_name') 
        setScheduleData(grouped_data)
      } catch (error) {
        console.error("Error fetching schedules:", error);
      } finally {
        setLoading(false);
      }
    }

    if (!route) {
      fetchSchedules();
    }
    fecthWeekdayTimes();
  }, [route]);


  return (
    <div className="App">
      <Navbar />
      {!loading && scheduleData ? (
        <div className='container'>
          <div className='side-bar'>
            <SchedulesDropdown setRoute={setRoute} schedules={schedules} setSelectedDirection={setSelectedDirection}/>
            {route && (
              <DirectionRadioButton
                className="directions"
                route={route}
                setSelectedDirection={setSelectedDirection}
                selectedDirection={selectedDirection}
              />
            )}
          </div>
          <div className='table'>
            <ScheduleTable
              selectedDirection={selectedDirection}
              scheduleData={scheduleData}
              route={route}
            />
          </div>
        </div>
      ) : (
        <p>Loading schedules...</p>
      )}
    </div>
  );
}

export default App;
