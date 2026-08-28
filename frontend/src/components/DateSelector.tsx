import Calendar from 'react-calendar';
import dayjs from 'dayjs';

interface Props {
  value: Date | null;
  onChange: (date: Date) => void;
  minDate?: Date;
  accent?: 'primary' | 'red';
}

export default function DateSelector({ value, onChange, minDate, accent = 'primary' }: Props) {
  const handleChange = (date: any) => {
    onChange(date);
  };

  const calendarVars = accent === 'red'
    ? { '--calendar-active-bg': '#b91c1c', '--calendar-active-hover-bg': '#991b1b' } as React.CSSProperties
    : { '--calendar-active-bg': '#0284c7', '--calendar-active-hover-bg': '#0369a1' } as React.CSSProperties;

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200" style={calendarVars}>
      <label className="block text-sm font-medium text-gray-700 mb-2">
        Select Reservation Date
      </label>
      <Calendar
        onChange={handleChange}
        value={value}
        minDate={minDate || new Date()}
        className="border-0"
      />
      {value && (
        <div className="mt-3 text-center text-sm text-gray-600">
          Selected: {dayjs(value).format('MMMM D, YYYY')}
        </div>
      )}
    </div>
  );
}
