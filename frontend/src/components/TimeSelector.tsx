import { useState } from 'react';
import type { TimeRange } from '../../../shared/src/types';

interface Props {
  value: TimeRange;
  onChange: (timeRange: TimeRange) => void;
}

const TIME_OPTIONS = [
  '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
  '16:00', '16:30', '17:00', '17:30', '18:00', '18:30',
  '19:00', '19:30', '20:00', '20:30', '21:00', '21:30',
  '22:00', '22:30', '23:00', '23:30', '00:00',
];

export default function TimeSelector({ value, onChange }: Props) {
  const [showPreferred, setShowPreferred] = useState(true);

  const handleStartChange = (start: string) => {
    onChange({ ...value, start });
  };

  const handleEndChange = (end: string) => {
    onChange({ ...value, end });
  };

  const togglePreferredTime = (time: string) => {
    const current = value.preferredTimes || [];
    const newPreferred = current.includes(time)
      ? current.filter(t => t !== time)
      : [...current, time].sort();
    
    onChange({ ...value, preferredTimes: newPreferred });
  };

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200 space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Time Range
        </label>
        <div className="flex gap-3 items-center">
          <select
            value={value.start}
            onChange={(e) => handleStartChange(e.target.value)}
            className="flex-1 px-3 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
          >
            <option value="" disabled>Start time</option>
            {TIME_OPTIONS.map(time => (
              <option key={time} value={time}>{time}</option>
            ))}
          </select>
          <span className="text-gray-500">to</span>
          <select
            value={value.end}
            onChange={(e) => handleEndChange(e.target.value)}
            className="flex-1 px-3 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
          >
            <option value="" disabled>End time</option>
            {TIME_OPTIONS.map(time => (
              <option key={time} value={time}>{time}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <button
          onClick={() => setShowPreferred(!showPreferred)}
          className="text-sm text-primary-600 hover:text-primary-700"
        >
          {showPreferred ? '− Hide' : '+ Set'} preferred times (optional)
        </button>
      </div>

      {showPreferred && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Preferred Times (in priority order)
          </label>
          <div className="grid grid-cols-4 gap-2">
            {TIME_OPTIONS
              .filter(time => time >= value.start && time <= value.end)
              .map(time => (
                <button
                  key={time}
                  onClick={() => togglePreferredTime(time)}
                  className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                    value.preferredTimes?.includes(time)
                      ? 'bg-primary-600 text-white border-primary-600'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-primary-500'
                  }`}
                >
                  {time}
                </button>
              ))}
          </div>
          {value.preferredTimes && value.preferredTimes.length > 0 && (
            <div className="mt-2 text-xs text-gray-500">
              Priority order: {value.preferredTimes.join(' → ')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
