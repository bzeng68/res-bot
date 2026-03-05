import { useState, Fragment, useEffect } from 'react';
import RestaurantSearch from './RestaurantSearch';
import DateSelector from './DateSelector';
import TimeSelector from './TimeSelector';
import { createReservation } from '../api/client';
import type { Restaurant, TimeRange, BookingWindow } from '../../../shared/src/types';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

interface Props {
  onSuccess: () => void;
}

export default function BookingForm({ onSuccess }: Props) {
  const [step, setStep] = useState(1);
  const [selectedRestaurant, setSelectedRestaurant] = useState<Restaurant | null>(null);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>({
    start: '18:00',
    end: '20:00',
    preferredTimes: [],
  });
  const [partySize, setPartySize] = useState(2);
  const [authToken, setAuthToken] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Booking window state with defaults
  const [bookingWindow, setBookingWindow] = useState<BookingWindow>({
    daysInAdvance: 30,
    releaseTime: '00:00', // Default to midnight
    timezone: 'America/New_York',
  });
  const [showBookingWindowEdit, setShowBookingWindowEdit] = useState(false);

  // Update booking window when restaurant is selected
  useEffect(() => {
    if (selectedRestaurant) {
      setBookingWindow(selectedRestaurant.bookingWindow);
    }
  }, [selectedRestaurant]);

  // Calculate when booking window opens
  const getBookingWindowOpenTime = () => {
    if (!selectedDate) return null;
    
    const targetDate = dayjs(selectedDate).tz(bookingWindow.timezone);
    const [hours, minutes] = bookingWindow.releaseTime.split(':').map(Number);
    
    return targetDate
      .subtract(bookingWindow.daysInAdvance, 'days')
      .hour(hours)
      .minute(minutes)
      .second(0);
  };

  const handleSubmit = async () => {
    if (!selectedRestaurant || !selectedDate) {
      alert('Please fill in all required fields');
      return;
    }

    setLoading(true);
    try {
      await createReservation({
        restaurantId: selectedRestaurant.id,
        restaurantName: selectedRestaurant.name,
        targetDate: selectedDate.toISOString().split('T')[0],
        timeRange,
        partySize,
        userEmail: 'user@resy.com',
        credentials: {
          platform: 'resy',
          authToken: authToken.trim(),
        },
        bookingWindow: bookingWindow,
      });

      alert('Reservation request created! The bot will attempt to book when slots open.');
      onSuccess();
      
      // Reset form
      setStep(1);
      setSelectedRestaurant(null);
      setSelectedDate(null);
      setBookingWindow({
        daysInAdvance: 30,
        releaseTime: '00:00',
        timezone: 'America/New_York',
      });
    } catch (error) {
      console.error('Failed to create reservation:', error);
      alert('Failed to create reservation request');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-gradient-to-br from-gray-50 to-gray-100 rounded-xl p-8 shadow-lg">
      {/* Progress steps */}
      <div className="flex items-center mb-8">
        {[1, 2, 3].map((s, index) => (
          <Fragment key={s}>
            <div
              className={`w-10 h-10 flex-shrink-0 rounded-full flex items-center justify-center font-semibold ${
                s <= step
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-300 text-gray-600'
              }`}
            >
              {s}
            </div>
            {index < 2 && (
              <div
                className={`flex-1 h-1 mx-2 ${
                  s < step ? 'bg-primary-600' : 'bg-gray-300'
                }`}
              />
            )}
          </Fragment>
        ))}
      </div>

      {/* Step 1: Restaurant */}
      {step === 1 && (
        <div className="space-y-6">
          <h2 className="text-2xl font-bold text-gray-900">Find Restaurant</h2>
          <RestaurantSearch onSelect={(r) => {
            setSelectedRestaurant(r);
            setStep(2);
          }} />
          {selectedRestaurant && (
            <div className="bg-white p-4 rounded-lg border-2 border-primary-500">
              <div className="font-medium text-gray-900">{selectedRestaurant.name}</div>
              <div className="text-sm text-gray-500">{selectedRestaurant.location}</div>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Date */}
      {step === 2 && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-900">Select Date</h2>
            <button
              onClick={() => setStep(1)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back
            </button>
          </div>
          <DateSelector
            value={selectedDate}
            onChange={setSelectedDate}
          />
          {selectedDate && (
            <button
              onClick={() => setStep(3)}
              className="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
            >
              Continue →
            </button>
          )}
        </div>
      )}

      {/* Step 3: Time & Party Size */}
      {step === 3 && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-900">Time & Party Details</h2>
            <button
              onClick={() => setStep(2)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back
            </button>
          </div>
          
          <TimeSelector value={timeRange} onChange={setTimeRange} />
          
          <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Party Size
            </label>
            <select
              value={partySize}
              onChange={(e) => setPartySize(Number(e.target.value))}
              className="w-full px-3 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900"
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(size => (
                <option key={size} value={size}>{size} {size === 1 ? 'person' : 'people'}</option>
              ))}
            </select>
          </div>

          {/* Booking Window Info */}
          <div className="bg-purple-50 border-2 border-purple-300 rounded-lg p-4">
            <div className="flex items-start justify-between mb-2">
              <div>
                <p className="font-bold text-purple-900 text-sm mb-1">📅 Booking Window</p>
                <p className="text-xs text-purple-700 mb-2">
                  When reservations are released by the restaurant
                </p>
              </div>
              <button
                onClick={() => setShowBookingWindowEdit(!showBookingWindowEdit)}
                className="text-xs text-purple-600 hover:text-purple-800 underline"
              >
                {showBookingWindowEdit ? 'Hide' : 'Edit'}
              </button>
            </div>
            
            {showBookingWindowEdit ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-purple-700 mb-1">Days in Advance</label>
                    <input
                      type="number"
                      min="1"
                      max="90"
                      value={bookingWindow.daysInAdvance}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === '') {
                          // Allow empty field while typing
                          setBookingWindow({ ...bookingWindow, daysInAdvance: '' as any });
                        } else {
                          const numValue = parseInt(value);
                          if (!isNaN(numValue)) {
                            setBookingWindow({ ...bookingWindow, daysInAdvance: numValue });
                          }
                        }
                      }}
                      onBlur={(e) => {
                        // On blur, ensure value is valid
                        const value = e.target.value;
                        const numValue = parseInt(value);
                        if (value === '' || isNaN(numValue) || numValue < 1) {
                          setBookingWindow({ ...bookingWindow, daysInAdvance: 1 });
                        } else if (numValue > 90) {
                          setBookingWindow({ ...bookingWindow, daysInAdvance: 90 });
                        }
                      }}
                      className="w-full px-3 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-purple-700 mb-1">Release Time</label>
                    <input
                      type="time"
                      value={bookingWindow.releaseTime}
                      onChange={(e) => setBookingWindow({ ...bookingWindow, releaseTime: e.target.value })}
                      className="w-full px-3 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-purple-700 mb-1">Timezone</label>
                  <select
                    value={bookingWindow.timezone}
                    onChange={(e) => setBookingWindow({ ...bookingWindow, timezone: e.target.value })}
                    className="w-full px-3 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-sm"
                  >
                    <option value="America/New_York">Eastern Time (ET)</option>
                    <option value="America/Chicago">Central Time (CT)</option>
                    <option value="America/Denver">Mountain Time (MT)</option>
                    <option value="America/Los_Angeles">Pacific Time (PT)</option>
                  </select>
                </div>
                <p className="text-xs text-purple-600 italic">
                  💡 If you're unsure, leave as default (30 days, midnight ET)
                </p>
              </div>
            ) : (
              <div className="text-sm text-purple-800">
                <span className="font-medium">{bookingWindow.daysInAdvance} days in advance</span> at{' '}
                <span className="font-medium">{bookingWindow.releaseTime}</span>
                {selectedDate && (
                  <div className="text-xs text-purple-700 mt-2 pt-2 border-t border-purple-200">
                    ⏰ Reservations for {dayjs(selectedDate).format('MMM D, YYYY')} will open:{' '}
                    <span className="font-semibold">
                      {getBookingWindowOpenTime()?.format('MMM D, YYYY [at] h:mm A')}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-4 text-sm space-y-3">
            <p className="font-bold text-blue-900">🔐 Resy Auth Token</p>
            <ol className="text-blue-800 text-xs list-decimal list-inside space-y-1">
              <li>Go to <a href="https://resy.com" target="_blank" rel="noopener noreferrer" className="underline font-semibold">resy.com</a> and log in</li>
              <li>Open DevTools → Network tab → reload the page</li>
              <li>Click any request to <code>api.resy.com</code></li>
              <li>Under <strong>Request Headers</strong>, copy the value of <code>x-resy-auth-token</code></li>
            </ol>
            <input
              type="password"
              placeholder="Paste your Resy auth token"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              className="w-full px-3 py-2 border border-blue-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white text-gray-900"
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={loading || !timeRange.start || !timeRange.end || !authToken.trim()}
            className="w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-semibold"
          >
            {loading ? 'Creating...' : '✓ Schedule Reservation'}
          </button>
        </div>
      )}
    </div>
  );
}
