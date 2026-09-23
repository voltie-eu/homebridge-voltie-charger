import { Bonjour, Browser } from 'bonjour-service';

/**
 * Voltie chargers advertise themselves as `_voltie-info._tcp` via avahi, with
 * the hostname `voltiecharger-XXXX` where XXXX is the last 4 hex digits of the
 * charger ID. mDNS browsing works from Docker too as long as the container is
 * on the host network (which HomeKit requires anyway); resolving `.local`
 * names often does not, so the discovered IPv4 address is used for API calls.
 */
// Moments within the browse window to ask again: a single mDNS query is
// often missed by a charger on Wi-Fi power save (measured on a home network:
// one of three chargers missing in about every fourth single-query browse,
// none missing with two repeats).
const REQUERY_AT_MS = [1500, 4000];

export interface DiscoveredCharger {
  shortId: string;
  address: string;
}

export function discoverChargers(
  timeoutMs: number,
  onError?: (error: unknown) => void,
): Promise<DiscoveredCharger[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredCharger>();
    let bonjour: Bonjour | undefined;
    let browser: Browser | undefined;
    let timer: NodeJS.Timeout | undefined;
    let requeries: NodeJS.Timeout[] = [];
    let done = false;

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timer);
      requeries.forEach(clearTimeout);
      try {
        browser?.stop();
        bonjour?.destroy();
      } catch {
        // mDNS socket teardown is best-effort
      }
      resolve([...found.values()]);
    };

    // Socket-level failures (EACCES/EADDRINUSE on UDP 5353, IPv6-only hosts)
    // arrive through this callback; without it they would crash the process.
    bonjour = new Bonjour(undefined, (error: unknown) => {
      onError?.(error);
      finish();
    });

    browser = bonjour.find({ type: 'voltie-info', protocol: 'tcp' }, (service) => {
      const label = `${service.name ?? ''} ${service.host ?? ''}`.toLowerCase();
      const match = label.match(/voltiecharger-([0-9a-f]{4})/);
      if (!match) {
        return;
      }
      const address = (service.addresses ?? []).find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a));
      if (!address) {
        return;
      }
      found.set(match[1], { shortId: match[1], address });
    });

    requeries = REQUERY_AT_MS
      .filter((at) => at < timeoutMs)
      .map((at) => setTimeout(() => {
        try {
          browser?.update();
        } catch {
          // a failed re-query just leaves the first answers
        }
      }, at));
    timer = setTimeout(finish, timeoutMs);
  });
}
