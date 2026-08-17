import { authConfigFromEnv } from '../auth/auth';
import { authenticateApiRequest } from '../auth/guard';

export function requireApiAuthentication(request: Request): void {
  const config = authConfigFromEnv(process.env);
  authenticateApiRequest(request, config, request.method);
}
