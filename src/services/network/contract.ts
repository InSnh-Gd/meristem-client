export type DerpNode = Readonly<{
  Name: string;
  RegionID: number;
  HostName: string;
  IPv4?: string;
  STUNPort: number;
  RelayPort: number;
}>;

export type DerpRegion = Readonly<{
  RegionID: number;
  RegionCode: string;
  Nodes: DerpNode[];
}>;

export type DerpMap = Readonly<{
  Regions: Record<string, DerpRegion>;
}>;

export type NetworkBootstrap = Readonly<{
  mode: 'DIRECT' | 'OVERLAY';
  provider?: string;
  coreIpv4?: string;
  coreIpv6?: string;
  authKey?: string;
  derpMap?: DerpMap | null;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseDerpMap = (input: unknown): DerpMap | null => {
  if (!isRecord(input) || !isRecord(input.Regions)) {
    return null;
  }

  const regions: Record<string, DerpRegion> = {};
  for (const [regionKey, rawRegion] of Object.entries(input.Regions)) {
    if (!isRecord(rawRegion) || !Array.isArray(rawRegion.Nodes)) {
      return null;
    }

    const parsedNodes: DerpNode[] = [];
    for (const rawNode of rawRegion.Nodes) {
      if (!isRecord(rawNode)) {
        return null;
      }

      if (
        typeof rawNode.Name !== 'string' ||
        typeof rawNode.RegionID !== 'number' ||
        typeof rawNode.HostName !== 'string' ||
        typeof rawNode.STUNPort !== 'number' ||
        typeof rawNode.RelayPort !== 'number'
      ) {
        return null;
      }

      parsedNodes.push({
        Name: rawNode.Name,
        RegionID: rawNode.RegionID,
        HostName: rawNode.HostName,
        IPv4: typeof rawNode.IPv4 === 'string' ? rawNode.IPv4 : undefined,
        STUNPort: rawNode.STUNPort,
        RelayPort: rawNode.RelayPort,
      });
    }

    if (typeof rawRegion.RegionID !== 'number' || typeof rawRegion.RegionCode !== 'string') {
      return null;
    }

    regions[regionKey] = {
      RegionID: rawRegion.RegionID,
      RegionCode: rawRegion.RegionCode,
      Nodes: parsedNodes,
    };
  }

  return {
    Regions: regions,
  };
};

export const parseJoinNetworkBootstrap = (
  payload: unknown,
  defaultCoreIpv4?: string,
): NetworkBootstrap => {
  const source = isRecord(payload) ? payload : {};
  const networkPlan = isRecord(source.network_plan) ? source.network_plan : {};
  const rawMode =
    (typeof networkPlan.mode === 'string' ? networkPlan.mode : undefined) ??
    (typeof source.network_mode === 'string' ? source.network_mode : 'DIRECT');
  const normalizedMode = rawMode === 'DIRECT' ? 'DIRECT' : 'OVERLAY';

  const coreIpv4 =
    (typeof networkPlan.core_ip_v4 === 'string' ? networkPlan.core_ip_v4 : undefined) ??
    (typeof source.core_ip === 'string' ? source.core_ip : defaultCoreIpv4);
  const coreIpv6 =
    (typeof networkPlan.core_ip_v6 === 'string' ? networkPlan.core_ip_v6 : undefined) ??
    (typeof source.core_ip_v6 === 'string' ? source.core_ip_v6 : undefined);
  const authKey =
    (typeof networkPlan.auth_key === 'string' ? networkPlan.auth_key : undefined) ??
    (typeof source.auth_key === 'string' ? source.auth_key : undefined);
  const derpMap =
    parseDerpMap(networkPlan.derp_map) ?? parseDerpMap(source.derp_map) ?? null;
  const provider =
    (typeof networkPlan.provider === 'string' ? networkPlan.provider : undefined) ??
    (typeof source.network_provider === 'string' ? source.network_provider : undefined);

  return {
    mode: normalizedMode,
    provider,
    coreIpv4,
    coreIpv6,
    authKey,
    derpMap,
  };
};
