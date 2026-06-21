import { Context } from 'hono';

export class AppError extends Error {
  public status: number;
  
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

/**
 * Global Hono error handler.
 */
export const errorHandler = (err: Error, c: Context) => {
  // Log the full error server-side (with stack) for diagnosis.
  console.error(`[Error] ${err.name}: ${err.message}`, err.stack);

  // AppError messages are intentional + safe to surface to the client.
  if (err instanceof AppError) {
    return c.json({ success: false, error: err.message, type: err.name }, err.status as never);
  }

  // Unexpected errors: never leak internal messages/stack to clients — return a generic 500.
  return c.json(
    { success: false, error: 'An unexpected server error occurred.', type: 'InternalServerError' },
    500,
  );
};
