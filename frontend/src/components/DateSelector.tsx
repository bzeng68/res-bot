import Calendar from 'react-calendar';
import dayjs from 'dayjs';

interface Props {
  value: Date | null;
  onChange: (date: Date) => void;
  minDate?: Date;
}

export default function DateSelector({ value, onChange, minDate }: Props) {
  const handleChange = (date: any) => {
    onChange(date);
  };

  return (
    <div className="bg-white rounded-lg p-4 shadow-sm border border-gray-200">
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
