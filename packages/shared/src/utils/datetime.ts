// UTC timestamp normalization utilities
// Ensures all timestamps are properly converted to UTC and validated

export interface ParsedDateTime {
  date: Date | null;
  isValid: boolean;
  wasUTC: boolean;
  originalValue: any;
  errorMessage?: string;
}

/**
 * Parse and normalize timestamp to UTC
 * Handles: ISO strings, Unix timestamps (ms or seconds), Date objects
 * Always returns UTC Date or null
 */
export function parseUTCDate(value: unknown, fieldName: string = 'timestamp'): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  try {
    let date: Date;

    // Handle different input types
    if (value instanceof Date) {
      date = value;
    } else if (typeof value === 'number') {
      // Handle Unix timestamp (assume milliseconds if > 10^10, else seconds)
      const timestamp = value > 10000000000 ? value : value * 1000;
      date = new Date(timestamp);
    } else if (typeof value === 'string') {
      // Parse ISO string
      date = new Date(value);
    } else {
      console.warn(`[DATETIME] Invalid type for ${fieldName}:`, typeof value);
      return null;
    }

    // Validate date
    if (isNaN(date.getTime())) {
      console.warn(`[DATETIME] Invalid date for ${fieldName}:`, value);
      return null;
    }

    // Check if date is reasonable (not too far in past or future)
    const now = Date.now();
    const diffYears = Math.abs(date.getTime() - now) / (1000 * 60 * 60 * 24 * 365);
    
    if (diffYears > 100) {
      console.warn(`[DATETIME] Date is ${diffYears.toFixed(0)} years away from now for ${fieldName}:`, value);
      // Still return it, but log warning
    }

    return date;
  } catch (error) {
    console.error(`[DATETIME] Exception parsing ${fieldName}:`, value, error);
    return null;
  }
}

/**
 * Parse with detailed result (for debugging/logging)
 */
export function parseUTCDateDetailed(value: unknown, fieldName: string = 'timestamp'): ParsedDateTime {
  const date = parseUTCDate(value, fieldName);
  
  const result: ParsedDateTime = {
    date,
    isValid: date !== null,
    wasUTC: false,
    originalValue: value,
  };

  if (date) {
    // Check if original was already UTC
    if (typeof value === 'string') {
      result.wasUTC = value.endsWith('Z') || value.includes('+00:00') || value.includes('UTC');
    } else {
      result.wasUTC = true; // Timestamps and Date objects are implicitly UTC
    }

    if (!result.wasUTC) {
      console.info(`[DATETIME] Non-UTC timestamp for ${fieldName}, converted to UTC:`, value, '→', date.toISOString());
    }
  } else {
    result.errorMessage = 'Failed to parse date';
  }

  return result;
}

/**
 * Ensure date is valid and in reasonable range
 */
export function validateDateRange(
  date: Date | null,
  fieldName: string,
  minDate?: Date,
  maxDate?: Date
): Date | null {
  if (!date) return null;

  if (minDate && date < minDate) {
    console.warn(`[DATETIME] ${fieldName} is before minimum date:`, date.toISOString(), '<', minDate.toISOString());
    return null;
  }

  if (maxDate && date > maxDate) {
    console.warn(`[DATETIME] ${fieldName} is after maximum date:`, date.toISOString(), '>', maxDate.toISOString());
    return null;
  }

  return date;
}

/**
 * Parse start and end dates, ensuring end is after start
 */
export function parseDateRange(
  startValue: unknown,
  endValue: unknown
): { start: Date | null; end: Date | null } {
  const start = parseUTCDate(startValue, 'start_time');
  const end = parseUTCDate(endValue, 'end_time');

  // Validate that end is after start
  if (start && end && end <= start) {
    console.warn('[DATETIME] End time is before or equal to start time:', {
      start: start.toISOString(),
      end: end.toISOString(),
    });
    // Still return both, but log warning
  }

  return { start, end };
}

/**
 * Get current UTC timestamp as ISO string
 */
export function nowUTC(): string {
  return new Date().toISOString();
}

/**
 * Check if two timestamps are the same (within tolerance)
 */
export function areSameTime(
  date1: Date | null,
  date2: Date | null,
  toleranceMs: number = 1000
): boolean {
  if (!date1 || !date2) return false;
  return Math.abs(date1.getTime() - date2.getTime()) <= toleranceMs;
}

/**
 * Format duration between two dates
 */
export function formatDuration(start: Date, end: Date): string {
  const diffMs = end.getTime() - start.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) return `${diffDays}d ${diffHours % 24}h`;
  if (diffHours > 0) return `${diffHours}h ${diffMinutes % 60}m`;
  if (diffMinutes > 0) return `${diffMinutes}m ${diffSeconds % 60}s`;
  return `${diffSeconds}s`;
}

