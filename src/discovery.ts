import { Bonjour } from 'bonjour-service';

/**
 * Voltie chargers advertise themselves as `_voltie-info._tcp` via avahi, with
 * the hostname `voltiecharger-XXXX` where XXXX is the last 4 hex digits of the
 * charger ID. mDNS browsing works from Docker too as long as the container is
 * on the host network (which HomeKit requires anyway); resolving `.local`
 * names often does not, so the discovered IPv4 address is used for API calls.
 */
export interface DiscoveredCharger {
  shortId: string;
  address: string;
}

export function discoverChargers(timeoutMs: number): Promise<DiscoveredCharger[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour();
    const found = new Map<string, DiscoveredCharger>();

    const finish = () => {
      clearTimeout(timer);
      try {
        browser.stop();
        bonjour.destroy();
      } catch {
        // mDNS socket teardown is best-effort
      }
      resolve([...found.values()]);
    };

    const browser = bonjour.find({ type: 'voltie-info', protocol: 'tcp' }, (service) => {
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

    const timer = setTimeout(finish, timeoutMs);
  });
}
