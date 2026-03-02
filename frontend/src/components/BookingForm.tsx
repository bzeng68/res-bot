import { useState, useEffect } from 'react';
import RestaurantSearch from './RestaurantSearch';
import DateSelector from './DateSelector';
import TimeSelector from './TimeSelector';
import { createReservation } from '../api/client';
import type { Restaurant, TimeRange } from '../../../shared/src/types';

const RESY_TOKEN_KEY = 'resy_auth_token';

// Decode JWT to extract expiration
function decodeJWT(token: string): { exp?: number } | null {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    return JSON.parse(jsonPayload);
  } catch (error) {
    return null;
  }
}

function getTokenExpiration(token: string): Date | null {
  const decoded = decodeJWT(token);
  if (decoded && decoded.exp) {
    return new Date(decoded.exp * 1000);
  }
  return null;
}

function isTokenExpired(token: string): boolean {
  const expiration = getTokenExpiration(token);
  if (!expiration) return false;
  return expiration.getTime() <= Date.now();
}

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
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resyAuthToken, setResyAuthToken] = useState('');
  const [tokenExpiration, setTokenExpiration] = useState<Date | null>(null);
  const [loading, setLoading] = useState(false);

  // Load saved token on mount
  useEffect(() => {
    const savedToken = localStorage.getItem(RESY_TOKEN_KEY);
    if (savedToken) {
      setResyAuthToken(savedToken);
      setTokenExpiration(getTokenExpiration(savedToken));
    }
  }, []);

  // Update expiration when token changes
  useEffect(() => {
    if (resyAuthToken) {
      setTokenExpiration(getTokenExpiration(resyAuthToken));
      // Save to localStorage
      localStorage.setItem(RESY_TOKEN_KEY, resyAuthToken);
    } else {
      setTokenExpiration(null);
    }
  }, [resyAuthToken]);

  const handleSubmit = async () => {
    if (!selectedRestaurant || !selectedDate) {
      alert('Please fill in all required fields');
      return;
    }

    // Validate platform-specific credentials
    if (selectedRestaurant.platform === 'resy') {
      if (!resyAuthToken) {
        alert('Please enter your Resy auth token');
        return;
      }
      if (isTokenExpired(resyAuthToken)) {
        alert('Your Resy auth token has expired. Please get a new token from resy.com.');
        return;
      }
    }

    if (selectedRestaurant.platform === 'opentable' && (!email || !password)) {
      alert('Please enter your OpenTable credentials');
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
        userEmail: email || 'user@resy.com',
        credentials: {
          platform: selectedRestaurant.platform,
          ...(selectedRestaurant.platform === 'resy' 
            ? { authToken: resyAuthToken }
            : { email, password }
          ),
        },
      });

      alert('Reservation request created! The bot will attempt to book when slots open.');
      onSuccess();
      
      // Reset form
      setStep(1);
      setSelectedRestaurant(null);
      setSelectedDate(null);
      setEmail('');
      setPassword('');
      setResyAuthToken('');
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
      <div className="flex justify-between mb-8">
        {[1, 2, 3, 4].map((s) => (
          <div key={s} className="flex items-center flex-1">
            <div
              className={`w-10 h-10 rounded-full flex items-center justify-center font-semibold ${
                s <= step
                  ? 'bg-primary-600 text-white'
                  : 'bg-gray-300 text-gray-600'
              }`}
            >
              {s}
            </div>
            {s < 4 && (
              <div
                className={`flex-1 h-1 mx-2 ${
                  s < step ? 'bg-primary-600' : 'bg-gray-300'
                }`}
              />
            )}
          </div>
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

          <button
            onClick={() => setStep(4)}
            disabled={!timeRange.start || !timeRange.end}
            className="w-full py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
          >
            Continue →
          </button>
        </div>
      )}

      {/* Step 4: Credentials */}
      {step === 4 && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold text-gray-900">
              {selectedRestaurant?.platform === 'resy' ? 'Resy' : 'OpenTable'} Authentication
            </h2>
            <button
              onClick={() => setStep(3)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back
            </button>
          </div>

          {selectedRestaurant?.platform === 'resy' ? (
            /* Resy Auth Token */
            <div className="space-y-4">
              <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-4 text-sm">
                <p className="font-bold text-blue-900 mb-3">📋 How to get your Resy auth token:</p>
                <ol className="list-decimal list-inside space-y-2 text-blue-900">
                  <li>Go to <a href="https://resy.com" target="_blank" rel="noopener noreferrer" className="underline font-semibold">resy.com</a> and log in</li>
                  <li>Press <kbd className="bg-blue-100 px-1.5 py-0.5 rounded font-mono text-xs">F12</kbd> to open Developer Tools</li>
                  <li>Click the <strong>Network</strong> tab</li>
                  <li>Type <code className="bg-blue-100 px-1 rounded font-mono text-xs">api.resy.com</code> in the filter box</li>
                  <li>Click on any restaurant or go to your <a href="https://resy.com/user" target="_blank" className="underline">profile</a> (triggers API calls)</li>
                  <li>Click any request that appears → <strong>Headers</strong> → <strong>Request Headers</strong></li>
                  <li>Find <code className="bg-blue-100 px-1 rounded font-mono text-xs">X-Resy-Auth-Token</code> and copy its value</li>
                </ol>
                <p className="text-xs text-blue-800 mt-3 pt-3 border-t border-blue-200">
                  💡 The token starts with "ey..." and is 200-500 characters long.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Resy Auth Token <span className="text-red-500">*</span>
                  </label>
                  {resyAuthToken && (
                    <button
                      type="button"
                      onClick={() => {
                        setResyAuthToken('');
                        localStorage.removeItem(RESY_TOKEN_KEY);
                      }}
                      className="text-xs text-red-600 hover:text-red-700 hover:underline"
                    >
                      Clear saved token
                    </button>
                  )}
                </div>
                <textarea
                  value={resyAuthToken}
                  onChange={(e) => setResyAuthToken(e.target.value)}
                  className="w-full px-4 py-3 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 placeholder:text-gray-500 font-mono text-xs"
                  placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                  rows={4}
                />
                {resyAuthToken && (
                  <div className="mt-2 space-y-2">
                    <p className="text-xs text-green-600 font-medium">
                      ✅ Token entered ({resyAuthToken.length} characters)
                    </p>
                    {tokenExpiration && (
                      <div className={`text-xs font-medium ${
                        isTokenExpired(resyAuthToken) 
                          ? 'text-red-600 bg-red-50 border border-red-200' 
                          : new Date(tokenExpiration).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000
                          ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                          : 'text-blue-600 bg-blue-50 border border-blue-200'
                      } px-3 py-2 rounded-lg`}>
                        {isTokenExpired(resyAuthToken) ? (
                          <>
                            ⚠️ Token expired on {tokenExpiration.toLocaleDateString()} - Please get a new token
                          </>
                        ) : (
                          <>
                            🔑 Token expires: {tokenExpiration.toLocaleDateString()} at {tokenExpiration.toLocaleTimeString()}
                            {new Date(tokenExpiration).getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000 && (
                              <span className="block mt-1">⚠️ Token expires in less than 7 days</span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    <p className="text-xs text-gray-500">
                      💾 Token is saved automatically and will be reused for future reservations
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* OpenTable Email/Password Authentication */
            <div className="space-y-4">
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 text-sm text-yellow-800">
                ⚠️ OpenTable integration is limited - automated booking may not work due to anti-bot protection.
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  OpenTable Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 placeholder:text-gray-500"
                  placeholder="your@email.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  OpenTable Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 placeholder:text-gray-500"
                  placeholder="••••••••"
                />
              </div>
            </div>
          )}

          <button
            onClick={handleSubmit}
            disabled={loading || (selectedRestaurant?.platform === 'resy' ? !resyAuthToken : !email || !password)}
            className="w-full py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 font-semibold"
          >
            {loading ? 'Creating...' : '✓ Schedule Reservation'}
          </button>
        </div>
      )}
    </div>
  );
}
