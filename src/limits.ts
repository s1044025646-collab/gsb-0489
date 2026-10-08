import type { Limits } from './types.js';

export const DEFAULT_LIMITS: Limits = {
  maxBytes: 512 * 1024 * 1024,
  maxRecords: 20_000_000,
  maxRecordLength: 1_000_000
};
