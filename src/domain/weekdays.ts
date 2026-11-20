export const calendarWeekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function calendarDayName(date: string): string {
  const midnight = new Date(`${date}T00:00:00Z`);
  const index = (midnight.getUTCDay() + 1) % calendarWeekdays.length;
  return calendarWeekdays[index];
}
