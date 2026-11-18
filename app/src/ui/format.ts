import type { FileFormat, RecurringItem } from '../import';

const MONTHS = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

/** 1999 -> "19.99 AUD". Integer arithmetic only: money never goes through floats. */
export function formatMoney(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, '0');
  return `${sign}${major}.${minor} ${currency}`;
}

/** "2026-10-01" -> "1 октября 2026". Anything else is shown as received. */
export function formatDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : isoDate;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function formatName(format: FileFormat): string {
  return format === 'pdf' ? 'PDF' : 'CSV';
}

export function cadenceLabel(cadence: string): string {
  return cadence === 'monthly' ? 'ежемесячно' : cadence;
}

/** Sum of the monthly items, in minor units. */
export function monthlyTotal(items: RecurringItem[]): number {
  return items.filter(item => item.cadence === 'monthly').reduce((sum, item) => sum + item.amountMinor, 0);
}
