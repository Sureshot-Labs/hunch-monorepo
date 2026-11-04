import { BlockList, isIP } from "node:net";

const privateProxyAddresses = new BlockList();
for (const [network, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) {
  privateProxyAddresses.addSubnet(network, prefix, "ipv4");
}
privateProxyAddresses.addAddress("::1", "ipv6");
privateProxyAddresses.addSubnet("fc00::", 7, "ipv6");

// Hunch's ingress and web proxy reach the API over private Docker networks or
// loopback. This is transport trust, NOT authentication: signed Hunch headers
// still require their existing secret checks. Fastify no longer accepts a
// numeric hop count because it alone cannot validate the connecting peer.
export function resolveTrustedProxy(enabled: boolean, hops: number) {
  if (!enabled) return false;
  return (address: string, hop: number): boolean => {
    if (
      !Number.isInteger(hops) ||
      !Number.isInteger(hop) ||
      hop < 0 ||
      hop >= hops ||
      address.includes("%")
    ) {
      return false;
    }
    const family = isIP(address);
    return (
      family !== 0 &&
      privateProxyAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
    );
  };
}
