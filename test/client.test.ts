import assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { isAuthError, isFault, VoltieApiError, VoltieClient, VoltieConnectionError } from '../src/client';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

describe('VoltieClient', () => {
  let server: Server;
  let port = 0;
  let handler: Handler = (_req, res) => res.end('{}');

  before(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => handler(req, res, body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const client = () => new VoltieClient('127.0.0.1', port);
  const json = (payload: unknown, status = 200): Handler => (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  it('returns the status record on error_code 0', async () => {
    handler = json({ evse_state: 1, is_charging: false, error_code: 0 });
    const status = await client().getStatus();
    assert.equal(status.evse_state, 1);
  });

  it('treats the spec 4.4 internal-error bodies as failures, not as an empty status', async () => {
    for (const status of ['internal timeout', 'internal error']) {
      handler = json({ status });
      await assert.rejects(client().getStatus(), VoltieConnectionError);
    }
  });

  it('maps a non-zero error_code to VoltieApiError with the code', async () => {
    handler = json({ error_code: 23 });
    await assert.rejects(client().stop(), (error: unknown) =>
      error instanceof VoltieApiError && error.code === 23 && /not master/.test(error.message));
  });

  it('flags 401/403 as an auth error', async () => {
    handler = (_req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    };
    await assert.rejects(client().getStatus(), (error: unknown) => isAuthError(error));
  });

  it('reports a missing endpoint as "not supported" (code 24), not a network error', async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    await assert.rejects(client().getConfig(), (error: unknown) =>
      error instanceof VoltieApiError && error.code === 24 && !isAuthError(error));
  });

  it('detects a silently rejected config key through "accepted"', async () => {
    handler = json({ accepted: 1, error_code: 0 });
    await assert.rejects(client().setConfig({ conf_current_limit: 16, conf_access_mode: 1 }), VoltieApiError);
    handler = json({ accepted: 2, error_code: 0 });
    await client().setConfig({ conf_current_limit: 16, conf_access_mode: 1 });
  });

  it('sends the rear LED colour in #RRGGBB form', async () => {
    let sent: Record<string, unknown> = {};
    handler = (req, res, body) => {
      sent = JSON.parse(body);
      json({ error_code: 0 })(req, res, body);
    };
    await client().setRearLed(0.5, 'ff8800', 60);
    assert.deepEqual(sent, {
      command: 'rear_led_set',
      params: { brightness: 0.5, color_rgb: '#FF8800', duration_sec: 60 },
    });
  });

  it('names the network cause instead of a bare "fetch failed"', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const freePort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const closed = new VoltieClient('127.0.0.1', freePort);
    await assert.rejects(closed.getStatus(), (error: unknown) =>
      error instanceof VoltieConnectionError && /ECONNREFUSED/.test(error.message));
  });
});

describe('isValidIdTag', () => {
  it('follows the spec 5.3 format', () => {
    assert.equal(VoltieClient.isValidIdTag('1A2B3C4D'), true);
    assert.equal(VoltieClient.isValidIdTag('card_01-ab'), true);
    assert.equal(VoltieClient.isValidIdTag('1A2B3C4'), false);
    assert.equal(VoltieClient.isValidIdTag('1A2B 3C4D'), false);
  });
});

describe('isFault', () => {
  it('flags the documented fault states only', () => {
    for (const state of [5, 9, 13, 15, 17, 20, 21]) {
      assert.equal(isFault({ evse_state: state }), true, `state ${state}`);
    }
    // 18 disabled, 19 boot, 24 undetermined, 25 VoltieMeter upload
    for (const state of [0, 1, 2, 3, 4, 18, 19, 24, 25]) {
      assert.equal(isFault({ evse_state: state }), false, `state ${state}`);
    }
    assert.equal(isFault({}), false);
  });
});
