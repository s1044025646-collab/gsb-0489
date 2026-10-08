import type { ValidationIssue } from './types.js';

export class AppError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function issueError(issues: ValidationIssue[]): AppError {
  return new AppError('FASTQ_VALIDATION_FAILED', 'FASTQ 结构或配对校验失败', issues);
}
