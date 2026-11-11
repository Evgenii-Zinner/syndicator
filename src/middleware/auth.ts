import type { MiddlewareHandler } from 'hono';
import type { Bindings } from '../types';

/**
 * Validates the inbound Authorization Bearer header against configured API_SECRET.
 */
export const requireApiSecret: MiddlewareHandler<{ Bindings: Bindings }> = async (c, next) => {
  const authHeader = c.req.header('Authorization');

  if (!authHeader?.startsWith('Bearer ')) {
    return c.json(
      { error: 'Missing or malformed Authorization header (Bearer token required).' },
      401
    );
  }

  const token = authHeader.slice(7).trim();
  const secret = c.env.API_SECRET;

  if (!secret) {
    return c.json({ error: 'Server misconfigured: API_SECRET is not set.' }, 500);
  }

  if (token !== secret) {
    return c.json({ error: 'Unauthorized: Invalid API secret.' }, 401);
  }

  await next();
};
