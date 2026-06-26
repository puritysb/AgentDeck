import { HookServer } from './hook-server';
import request from 'supertest';

describe('Protected endpoints reject unauthenticated requests', () => {
  let server: HookServer;
  let app: any;

  beforeAll(() => {
    server = new HookServer({ port: 0 });
    app = server.app;
  });

  afterAll(async () => {
    await server.close();
  });

  const protectedEndpoints = [
    { method: 'GET', path: '/usage' },
    { method: 'GET', path: '/devices' },
    { method: 'POST', path: '/hooks/test-event' },
    { method: 'GET', path: '/pixoo/stream' },
    { method: 'POST', path: '/pixoo/frame' },
    { method: 'GET', path: '/pixoo' }
  ];

  const authPayloads = [
    { description: 'missing token', token: null },
    { description: 'malformed token', token: 'invalid_token_123' },
    { description: 'expired JWT', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2MzAwMDAwMDB9.invalid' },
    { description: 'empty string token', token: '' },
    { description: 'valid token format but wrong secret', token: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' }
  ];

  test.each(protectedEndpoints)('$method $path rejects unauthenticated requests', async ({ method, path }) => {
    test.each(authPayloads)(`with $description`, async ({ token }) => {
      const req = request(app)[method.toLowerCase()](path);
      
      if (token !== null) {
        req.set('Authorization', token);
      }

      const response = await req;
      
      // Expect either 401 Unauthorized or 403 Forbidden
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect([401, 403]).toContain(response.status);
    });
  });
});