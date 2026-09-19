import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

/**
 * Per-email costs are fractions of a cent, so small amounts get more decimals
 * rather than collapsing to `$0.00`.
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  if (abs === 0) return '$0.00';
  if (abs < 0.01) return `$${value.toFixed(4)}`;
  if (abs < 1) return `$${value.toFixed(3)}`;
  return usd.format(value);
}

export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return '--';
  return Math.round(value).toLocaleString('en-US');
}

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '--';
  return `${value.toFixed(digits)}%`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Safe division that returns null instead of Infinity/NaN. */
export function ratio(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${formatInt(count)} ${count === 1 ? singular : pluralForm}`;
}

/** Two-letter avatar text for an email address or name. */
export function initials(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return '?';
  const local = cleaned.includes('@') ? cleaned.split('@')[0] : cleaned;
  const words = local.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/** Deterministic hue for colouring an account chip from its address. */
export function hueFor(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

export function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
