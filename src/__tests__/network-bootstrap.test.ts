import { expect, test } from 'bun:test';
import { parseJoinNetworkBootstrap } from '../services/network/contract';

test('parseJoinNetworkBootstrap resolves overlay plan from generic network_plan', (): void => {
  const bootstrap = parseJoinNetworkBootstrap(
    {
      network_plan: {
        mode: 'OVERLAY',
        provider: 'com.example.overlay',
        core_ip_v4: '10.25.0.1',
        core_ip_v6: 'fd7a:115c:a1e0::1',
        auth_key: 'k1',
        derp_map: {
          Regions: {
            '1': {
              RegionID: 1,
              RegionCode: 'region-1',
              Nodes: [
                {
                  Name: 'relay-1',
                  RegionID: 1,
                  HostName: 'relay-1.example.com',
                  STUNPort: 3478,
                  RelayPort: 443,
                },
              ],
            },
          },
        },
      },
    },
    '10.25.0.9',
  );

  expect(bootstrap.mode).toBe('OVERLAY');
  expect(bootstrap.provider).toBe('com.example.overlay');
  expect(bootstrap.coreIpv4).toBe('10.25.0.1');
  expect(bootstrap.coreIpv6).toBe('fd7a:115c:a1e0::1');
  expect(bootstrap.authKey).toBe('k1');
  expect(bootstrap.derpMap?.Regions['1']?.Nodes[0]?.HostName).toBe('relay-1.example.com');
});

test('parseJoinNetworkBootstrap remains compatible with legacy direct response', (): void => {
  const bootstrap = parseJoinNetworkBootstrap(
    {
      network_mode: 'DIRECT',
      core_ip_v6: 'fd7a:115c:a1e0::2',
    },
    '10.25.0.2',
  );

  expect(bootstrap.mode).toBe('DIRECT');
  expect(bootstrap.coreIpv4).toBe('10.25.0.2');
  expect(bootstrap.coreIpv6).toBe('fd7a:115c:a1e0::2');
});
