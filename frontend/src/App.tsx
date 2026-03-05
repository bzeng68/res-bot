import { useState } from 'react';
import { Utensils } from 'lucide-react';
import BookingForm from './components/BookingForm';
import Dashboard from './components/Dashboard';

function App() {
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleBookingSuccess = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <header className="mb-12 text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Utensils size={48} className="text-primary-400" />
            <h1 className="text-5xl font-bold bg-gradient-to-r from-primary-400 to-primary-600 bg-clip-text text-transparent">
              Res-Bot
            </h1>
          </div>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Automated restaurant reservation bot for Resy.
            Never miss a hot reservation again.
          </p>
          <div className="mt-4 text-sm text-yellow-400">
            ⚠️ For personal educational use only
          </div>
        </header>

        {/* Main Content */}
        <div className="max-w-6xl mx-auto space-y-8">
          {/* Booking Form */}
          <section>
            <BookingForm onSuccess={handleBookingSuccess} />
          </section>

          {/* Dashboard */}
          <section>
            <Dashboard refreshTrigger={refreshTrigger} />
          </section>
        </div>

        {/* Footer */}
        <footer className="mt-16 text-center text-sm text-gray-500">
          <p>
            Built with React + TypeScript + Node.js
          </p>
          <p className="mt-2">
            Using automated bots violates platform ToS. Use responsibly.
          </p>
        </footer>
      </div>
    </div>
  );
}

export default App;
