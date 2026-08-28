import { useState } from 'react';
import { Link2 } from 'lucide-react';

export interface OpenTableRestaurant {
  slug: string;
  name: string;
}

interface Props {
  onSelect: (restaurant: OpenTableRestaurant) => void;
}

function parseSlug(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/opentable\.com\/r\/([^/?#]+)/i);
  if (match) return match[1];
  // Assume they pasted the slug directly rather than a full URL.
  return trimmed.replace(/^\/+|\/+$/g, '');
}

function slugToName(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default function OpenTableLinkInput({ onSelect }: Props) {
  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);

  const slug = link.trim() ? parseSlug(link) : '';

  const handleLinkChange = (value: string) => {
    setLink(value);
    if (!nameEdited) {
      const parsedSlug = value.trim() ? parseSlug(value) : '';
      setName(parsedSlug ? slugToName(parsedSlug) : '');
    }
  };

  const handleContinue = () => {
    if (!slug || !name.trim()) return;
    onSelect({ slug, name: name.trim() });
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          OpenTable Link
        </label>
        <div className="relative">
          <Link2 size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="https://www.opentable.com/r/restaurant-slug"
            value={link}
            onChange={(e) => handleLinkChange(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 text-gray-900 placeholder:text-gray-500"
          />
        </div>
        {link.trim() && !slug && (
          <p className="text-xs text-red-600 mt-1">Couldn't find a restaurant slug in that link.</p>
        )}
      </div>

      {slug && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Restaurant Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
            className="w-full px-4 py-2 bg-white border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-500 text-gray-900"
          />
        </div>
      )}

      <button
        onClick={handleContinue}
        disabled={!slug || !name.trim()}
        className="w-full py-2.5 bg-red-700 text-white rounded-lg hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
      >
        Continue →
      </button>
    </div>
  );
}
