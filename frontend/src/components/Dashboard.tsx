import { useEffect, useState } from 'react';
import { Clock, Calendar, Users, Trash2, CheckCircle, XCircle, Loader, Edit2, Save, X, ChevronDown, ChevronUp, Copy, Check, RefreshCw, AlertTriangle } from 'lucide-react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getAllReservations, deleteReservation, updateReservation, connectWebSocket } from '../api/client';
import type { ReservationRequest } from '../../../shared/src/types';

dayjs.extend(relativeTime);

interface Props {
  refreshTrigger: number;
}

export default function Dashboard({ refreshTrigger }: Props) {
  const [reservations, setReservations] = useState<ReservationRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');
  const [expandedLogs, setExpandedLogs] = useState<Record<string, boolean>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadReservations();
  }, [refreshTrigger]);

  useEffect(() => {
    // Connect to WebSocket for real-time updates
    const ws = connectWebSocket((message) => {
      console.log('WebSocket message:', message);
      // Refresh reservations on any update
      loadReservations();
    });

    return () => {
      ws.close();
    };
  }, []);

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadReservations();
    setRefreshing(false);
  };

  const loadReservations = async () => {
    try {
      const data = await getAllReservations();
      setReservations(data);
    } catch (error) {
      console.error('Failed to load reservations:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    const reservation = reservations.find(r => r.id === id);
    const action = reservation?.status === 'booked'
      ? 'Delete this confirmed reservation from the list?'
      : reservation?.status === 'scheduled' || reservation?.status === 'polling'
      ? 'Cancel this reservation attempt?'
      : 'Delete this reservation?';
    
    if (!confirm(action)) return;

    try {
      await deleteReservation(id);
      loadReservations();
    } catch (error) {
      console.error('Failed to delete reservation:', error);
      alert('Failed to delete reservation');
    }
  };

  const handleStartEdit = (reservation: ReservationRequest) => {
    setEditingId(reservation.id);
    setEditStart(reservation.timeRange.start);
    setEditEnd(reservation.timeRange.end);
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditStart('');
    setEditEnd('');
  };

  const toggleLogExpanded = (id: string) => {
    setExpandedLogs(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'found_slot': return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'getting_book_token': return 'bg-purple-100 text-purple-700 border-purple-200';
      case 'booking': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'success': return 'bg-green-100 text-green-700 border-green-200';
      case 'error': return 'bg-red-100 text-red-700 border-red-200';
      default: return 'bg-gray-100 text-gray-700 border-gray-200';
    }
  };

  const handleSaveEdit = async (id: string) => {
    try {
      await updateReservation(id, {
        timeRange: {
          start: editStart,
          end: editEnd,
          preferredTimes: [],
        },
      });
      setEditingId(null);
      loadReservations();
    } catch (error) {
      console.error('Failed to update reservation:', error);
      alert('Failed to update time range');
    }
  };

  const parseAvailableTimes = (errorMsg: string): string[] | null => {
    // Extract available times from error message
    const match = errorMsg.match(/Available times: ([^.]+)/);
    if (!match) return null;
    
    const timesStr = match[1];
    // Remove "... (+X more)" suffix and split by comma
    const cleanStr = timesStr.replace(/\.\.\. \(\+\d+ more\)/, '');
    return cleanStr.split(', ').map(t => t.trim()).filter(Boolean);
  };

  const isTimeRangeMismatch = (errorMsg: string): boolean => {
    return errorMsg.includes('No slots match your') && errorMsg.includes('Available times:');
  };

  const isBookingWindowNotOpen = (errorMsg: string): boolean => {
    return errorMsg.includes('NOT_RELEASED_YET:') || errorMsg.includes("haven't opened yet");
  };

  const parseBookingWindowMessage = (errorMsg: string): string => {
    // Remove the "NOT_RELEASED_YET: " prefix if present
    return errorMsg.replace('NOT_RELEASED_YET: ', '').replace('Reservations for ', '');
  };

  const formatTimeToBook = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.round((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  };

  const getCountdown = (scheduledTime: string | undefined) => {
    if (!scheduledTime) return null;
    
    const now = dayjs();
    const scheduled = dayjs(scheduledTime);
    const diff = scheduled.diff(now, 'seconds');
    
    if (diff <= 0) return 'Polling now...';
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
    return `${Math.floor(diff / 86400)}d ${Math.floor((diff % 86400) / 3600)}h`;
  };

  const getStatusBadge = (status: string) => {
    const badges = {
      scheduled: { color: 'bg-blue-100 text-blue-800', icon: Clock, label: 'Scheduled' },
      polling: { color: 'bg-yellow-100 text-yellow-800', icon: Loader, label: 'Polling...' },
      booked: { color: 'bg-green-100 text-green-800', icon: CheckCircle, label: 'Booked!' },
      failed: { color: 'bg-red-100 text-red-800', icon: XCircle, label: 'Failed' },
      cancelled: { color: 'bg-gray-100 text-gray-800', icon: XCircle, label: 'Cancelled' },
    };

    const badge = badges[status as keyof typeof badges] || badges.scheduled;
    const Icon = badge.icon;

    return (
      <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-medium ${badge.color}`}>
        <Icon size={16} className={status === 'polling' ? 'animate-spin' : ''} />
        {badge.label}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-12">
        <Loader className="animate-spin text-primary-600" size={32} />
      </div>
    );
  }

  if (reservations.length === 0) {
    return (
      <div className="text-center py-12 bg-white rounded-lg shadow-sm border border-gray-200">
        <Calendar className="mx-auto text-gray-400 mb-4" size={48} />
        <h3 className="text-lg font-medium text-gray-900 mb-2">
          No Reservations
        </h3>
        <p className="text-gray-500">
          Create your first reservation request above to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-bold text-white">All Reservations</h2>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="p-1.5 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>
      
      <div className="grid gap-4">
        {reservations.map((reservation) => (
          <div
            key={reservation.id}
            className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow"
          >
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3 mb-2">
                  <h3 className="text-xl font-semibold text-gray-900">
                    {reservation.restaurantName}
                  </h3>
                  {getStatusBadge(reservation.status)}
                </div>

                <div className="flex flex-wrap gap-4 text-sm text-gray-600 mb-3">
                  <div className="flex items-center gap-1">
                    <Calendar size={16} />
                    {dayjs(reservation.targetDate).format('MMM D, YYYY')}
                  </div>
                  <div className="flex items-center gap-1">
                    <Clock size={16} />
                    {reservation.timeRange.start} - {reservation.timeRange.end}
                  </div>
                  <div className="flex items-center gap-1">
                    <Users size={16} />
                    {reservation.partySize} {reservation.partySize === 1 ? 'person' : 'people'}
                  </div>
                </div>

                {reservation.scheduledPollTime && reservation.status === 'scheduled' && (
                  <div className="bg-blue-50 rounded-lg p-3 text-sm">
                    <div className="font-medium text-blue-900">
                      {getCountdown(reservation.scheduledPollTime) === 'Polling now...'
                        ? 'Booking window is open — attempting now...'
                        : `Booking window opens in: ${getCountdown(reservation.scheduledPollTime)}`}
                    </div>
                    <div className="text-blue-700 text-xs mt-1">
                      {dayjs(reservation.scheduledPollTime).format('MMM D, YYYY [at] h:mm A')}
                    </div>
                  </div>
                )}

                {reservation.tokenStatus === 'invalid' && reservation.status === 'scheduled' && (
                  <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm flex items-start gap-2 mt-2">
                    <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium text-orange-900">Auth token may be expired</div>
                      <div className="text-orange-700 text-xs mt-0.5">Re-paste your Resy token before the booking window opens — go to resy.com, open DevTools → Application → Local Storage and copy the <code className="bg-orange-100 px-1 rounded">authToken</code> value.</div>
                    </div>
                  </div>
                )}

                {reservation.status === 'polling' && (
                  <div className="bg-yellow-50 rounded-lg p-3 text-sm">
                    {reservation.result?.error && isBookingWindowNotOpen(reservation.result.error) ? (
                      <>
                        <div className="font-medium text-yellow-900 flex items-center gap-2">
                          <Clock size={16} />
                          Waiting for booking window to open...
                        </div>
                        <div className="text-yellow-700 text-xs mt-1">
                          {parseBookingWindowMessage(reservation.result.error)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="font-medium text-yellow-900 flex items-center gap-2">
                          <Loader size={16} className="animate-spin" />
                          Checking for availability...
                        </div>
                        <div className="text-yellow-700 text-xs mt-1">
                          Polling started {dayjs(reservation.scheduledPollTime).fromNow()}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {reservation.status === 'booked' && reservation.result && (
                  <div className="bg-green-50 rounded-lg p-3 text-sm">
                    <div className="font-medium text-green-900">
                      ✓ Reservation confirmed!
                    </div>
                    {reservation.result.confirmationCode && (
                      <div className="text-green-700 text-xs mt-1 flex items-center gap-1">
                        <span className="shrink-0">Confirmation:</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(reservation.result!.confirmationCode!);
                            setCopiedId(reservation.id);
                            setTimeout(() => setCopiedId(null), 2000);
                          }}
                          className="flex items-center gap-1 text-green-700 hover:text-green-900 transition-colors"
                          title={reservation.result.confirmationCode}
                        >
                          {copiedId === reservation.id ? (
                            <><Check size={12} className="shrink-0" /><span>Copied!</span></>
                          ) : (
                            <><Copy size={12} className="shrink-0" /><span>Copy code</span></>
                          )}
                        </button>
                      </div>
                    )}
                    {reservation.result.timeToBookMs != null && (
                      <div className="text-green-600 text-xs mt-1">
                        Booked in {formatTimeToBook(reservation.result.timeToBookMs)} after window opened
                      </div>
                    )}
                  </div>
                )}

                {reservation.status === 'failed' && reservation.result?.error && (
                  <div className="space-y-3">
                    {isBookingWindowNotOpen(reservation.result.error) ? (
                      <div className="bg-blue-50 rounded-lg p-4 text-sm">
                        <div className="font-medium text-blue-900 mb-2 flex items-center gap-2">
                          <Clock size={18} />
                          Reservations Not Released Yet
                        </div>
                        <div className="text-blue-700">
                          {parseBookingWindowMessage(reservation.result.error)}
                        </div>
                        <div className="text-blue-600 text-xs mt-2">
                          The bot will automatically retry once the booking window opens.
                        </div>
                      </div>
                    ) : (
                      <div className="bg-red-50 rounded-lg p-3 text-sm text-red-700">
                        {reservation.result.error}
                      </div>
                    )}
                    
                    {isTimeRangeMismatch(reservation.result.error) && (
                      <div className="bg-blue-50 rounded-lg p-4">
                        {editingId === reservation.id ? (
                          <div className="space-y-3">
                            <div className="font-medium text-blue-900 text-sm mb-2">
                              Edit Time Range
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="block text-xs text-blue-700 mb-1">Start Time</label>
                                <input
                                  type="time"
                                  value={editStart}
                                  onChange={(e) => setEditStart(e.target.value)}
                                  className="w-full px-3 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                              </div>
                              <div>
                                <label className="block text-xs text-blue-700 mb-1">End Time</label>
                                <input
                                  type="time"
                                  value={editEnd}
                                  onChange={(e) => setEditEnd(e.target.value)}
                                  className="w-full px-3 py-2 border border-blue-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                />
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleSaveEdit(reservation.id)}
                                className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                              >
                                <Save size={14} />
                                Save & Retry
                              </button>
                              <button
                                onClick={handleCancelEdit}
                                className="flex items-center gap-1 px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm"
                              >
                                <X size={14} />
                                Cancel
                              </button>
                            </div>
                            {parseAvailableTimes(reservation.result.error) && (
                              <div className="text-xs text-blue-700 mt-2">
                                <div className="font-medium mb-1">Available times:</div>
                                <div className="flex flex-wrap gap-1">
                                  {parseAvailableTimes(reservation.result.error)!.map((time, idx) => (
                                    <button
                                      key={idx}
                                      onClick={() => {
                                        setEditStart(time);
                                        setEditEnd(time);
                                      }}
                                      className="px-2 py-0.5 bg-white border border-blue-200 rounded hover:bg-blue-100 transition-colors"
                                    >
                                      {time}
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <div className="text-sm text-blue-700">
                              No matching times found. Try a different time range?
                            </div>
                            <button
                              onClick={() => handleStartEdit(reservation)}
                              className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm"
                            >
                              <Edit2 size={14} />
                              Edit Time Range
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Booking Attempts Log */}
              {reservation.bookingAttempts && reservation.bookingAttempts.length > 0 && (
                <div className="mt-3 border-t border-gray-200 pt-3">
                  <button
                    onClick={() => toggleLogExpanded(reservation.id)}
                    className="flex items-center gap-2 text-sm text-gray-600 hover:text-gray-800 transition-colors"
                  >
                    {expandedLogs[reservation.id] ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    <span className="font-medium">
                      Booking Attempts Log ({reservation.bookingAttempts.length})
                    </span>
                  </button>
                  
                  {expandedLogs[reservation.id] && (
                    <div className="mt-2 space-y-2 max-h-96 overflow-y-auto">
                      {[...reservation.bookingAttempts].reverse().map((attempt, idx) => (
                        <div key={idx} className="text-xs border rounded-lg p-3 bg-white">
                          <div className="flex items-center justify-between mb-2">
                            <span className={`px-2 py-0.5 rounded border font-medium ${getActionColor(attempt.action)}`}>
                              {attempt.action.replace(/_/g, ' ').toUpperCase()}
                            </span>
                            <span className="text-gray-500">
                              {dayjs(attempt.timestamp).format('MMM D, h:mm:ss A')}
                            </span>
                          </div>
                          
                          {/* Main message */}
                          <div className="text-gray-800 font-medium mb-1">{attempt.message}</div>
                          
                          {/* Slot info if available */}
                          {(attempt.slotTime || attempt.slotDate) && (
                            <div className="text-gray-600 text-xs">
                              {attempt.slotTime && <span>🕐 {attempt.slotTime}</span>}
                              {attempt.slotTime && attempt.slotDate && <span className="mx-1">•</span>}
                              {attempt.slotDate && <span>📅 {attempt.slotDate}</span>}
                            </div>
                          )}
                          
                          {/* Details section */}
                          {attempt.details && Object.keys(attempt.details).length > 0 && (
                            <details className="mt-2">
                              <summary className="text-gray-600 cursor-pointer hover:text-gray-800 font-medium">
                                📋 View details
                              </summary>
                              <div className="mt-2 p-2 bg-gray-50 rounded border border-gray-200">
                                {/* Show key details inline */}
                                <div className="space-y-1">
                                  {attempt.details.httpStatus && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">HTTP Status:</span>{' '}
                                      <span className={attempt.details.httpStatus >= 400 ? 'text-red-600 font-bold' : 'text-green-600'}>
                                        {attempt.details.httpStatus}
                                      </span>
                                    </div>
                                  )}
                                  {(attempt.details.errorMessage || attempt.details.error || attempt.details.fullError) && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Error:</span>{' '}
                                      <span className="text-red-600 break-all">
                                        {attempt.details.errorMessage || attempt.details.error || attempt.details.fullError}
                                      </span>
                                    </div>
                                  )}
                                  {attempt.details.confirmationCode && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Confirmation:</span>{' '}
                                      <span className="text-green-600 font-mono">{attempt.details.confirmationCode}</span>
                                    </div>
                                  )}
                                  {attempt.details.venueName && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Venue:</span>{' '}
                                      <span>{attempt.details.venueName}</span>
                                    </div>
                                  )}
                                  {attempt.details.slotCount !== undefined && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Slots Found:</span>{' '}
                                      <span>{attempt.details.slotCount}</span>
                                    </div>
                                  )}
                                  {attempt.details.availableTimes && attempt.details.availableTimes.length > 0 && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Available Times:</span>{' '}
                                      <span>{attempt.details.availableTimes.join(', ')}</span>
                                    </div>
                                  )}
                                  {attempt.details.reason && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Reason:</span>{' '}
                                      <span className="text-orange-600">{attempt.details.reason}</span>
                                    </div>
                                  )}
                                  {attempt.details.bookingOpensAt && (
                                    <div className="text-xs">
                                      <span className="font-semibold text-gray-700">Booking Opens:</span>{' '}
                                      <span>{dayjs(attempt.details.bookingOpensAt).format('MMM D, YYYY h:mm A')}</span>
                                    </div>
                                  )}
                                </div>
                                
                                {/* Full JSON for debugging */}
                                <details className="mt-2">
                                  <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                                    Show raw JSON
                                  </summary>
                                  <pre className="mt-1 p-2 bg-white rounded text-xs overflow-x-auto border border-gray-300">
                                    {JSON.stringify(attempt.details, null, 2)}
                                  </pre>
                                </details>
                              </div>
                            </details>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button
                onClick={() => handleDelete(reservation.id)}
                className="ml-4 p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors shrink-0"
                title={reservation.status === 'booked' ? 'Delete reservation' : 'Cancel'}
              >
                <Trash2 size={20} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
