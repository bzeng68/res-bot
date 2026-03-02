import { useState } from 'react';
import { Search } from 'lucide-react';
import { searchRestaurants } from '../api/client';
import type { Restaurant } from '../../../shared/src/types';

interface Props {
  onSelect: (restaurant: Restaurant) => void;
}

export default function RestaurantSearch({ onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [results, setResults] = useState<Restaurant[]>([]);
  const [loading, setLoading] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const handleSearch = async () => {
    if (!query || !location) return;
    
    setLoading(true);
    try {
      const data = await searchRestaurants(query, location);
      setResults(data.restaurants);
      setShowResults(true);
    } catch (error) {
      console.error('Search failed:', error);
      alert('Failed to search restaurants');
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (restaurant: Restaurant) => {
    onSelect(restaurant);
    setShowResults(false);
    setQuery(restaurant.name);
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Restaurant name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="flex-1 px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 placeholder:text-gray-500"
        />
        <input
          type="text"
          placeholder="Location (e.g., NYC)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          className="w-48 px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500 text-gray-900 placeholder:text-gray-500"
        />
        <button
          onClick={handleSearch}
          disabled={loading || !query || !location}
          className="px-6 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          <Search size={20} />
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {showResults && results.length > 0 && (
        <div className="bg-white rounded-lg shadow-lg border border-gray-200 max-h-80 overflow-y-auto">
          {results.map((restaurant) => (
            <button
              key={restaurant.id}
              onClick={() => handleSelect(restaurant)}
              className="w-full px-4 py-3 text-left hover:bg-gray-50 border-b border-gray-100 last:border-b-0"
            >
              <div className="font-medium text-gray-900">{restaurant.name}</div>
              <div className="text-sm text-gray-500">{restaurant.location}</div>
              {restaurant.cuisine && (
                <div className="text-xs text-gray-400 mt-1">{restaurant.cuisine}</div>
              )}
            </button>
          ))}
        </div>
      )}

      {showResults && results.length === 0 && !loading && (
        <div className="text-center py-8 text-gray-500">
          No restaurants found. Try a different search.
        </div>
      )}
    </div>
  );
}
