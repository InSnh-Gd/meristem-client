import type { DerpMap, NetworkBootstrap } from './contract';

export type AddressFamilyPreference = 'ipv6-first' | 'ipv4-first' | 'dual-stack';

export type TunnelPlan = Readonly<{
  mode: 'P2P' | 'RELAY';
  endpoint: string;
  family: 'ipv4' | 'ipv6';
  hasAuthKey: boolean;
}>;

const pickEndpointByPreference = (
  context: NetworkBootstrap,
  preference: AddressFamilyPreference,
): { endpoint: string; family: 'ipv4' | 'ipv6' } | null => {
  const ipv4 = typeof context.coreIpv4 === 'string' && context.coreIpv4.length > 0 ? context.coreIpv4 : null;
  const ipv6 = typeof context.coreIpv6 === 'string' && context.coreIpv6.length > 0 ? context.coreIpv6 : null;

  if (preference === 'ipv6-first') {
    if (ipv6) {
      return { endpoint: ipv6, family: 'ipv6' };
    }
    if (ipv4) {
      return { endpoint: ipv4, family: 'ipv4' };
    }
    return null;
  }

  if (preference === 'ipv4-first') {
    if (ipv4) {
      return { endpoint: ipv4, family: 'ipv4' };
    }
    if (ipv6) {
      return { endpoint: ipv6, family: 'ipv6' };
    }
    return null;
  }

  if (ipv6) {
    return { endpoint: ipv6, family: 'ipv6' };
  }
  if (ipv4) {
    return { endpoint: ipv4, family: 'ipv4' };
  }
  return null;
};

const resolveRelayEndpoint = (derpMap: DerpMap | null | undefined): string | null => {
  if (!derpMap) {
    return null;
  }

  for (const region of Object.values(derpMap.Regions)) {
    if (region.Nodes.length === 0) {
      continue;
    }

    const node = region.Nodes[0];
    if (node && node.HostName.length > 0) {
      return node.HostName;
    }
  }

  return null;
};

export const createTunnelPlanner = (preference: AddressFamilyPreference) =>
  Object.freeze({
    plan(context: NetworkBootstrap): TunnelPlan | null {
      const primary = pickEndpointByPreference(context, preference);
      if (primary) {
        return {
          mode: 'P2P',
          endpoint: primary.endpoint,
          family: primary.family,
          hasAuthKey: typeof context.authKey === 'string' && context.authKey.length > 0,
        };
      }

      const relayEndpoint = resolveRelayEndpoint(context.derpMap);
      if (!relayEndpoint) {
        return null;
      }

      return {
        mode: 'RELAY',
        endpoint: relayEndpoint,
        family: 'ipv4',
        hasAuthKey: typeof context.authKey === 'string' && context.authKey.length > 0,
      };
    },
  });
