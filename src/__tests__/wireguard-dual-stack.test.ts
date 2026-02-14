import { expect, test } from 'bun:test';
import { createTunnelPlanner } from '../services/network/tunnel-planner';

test('tunnel planner prefers ipv6 endpoint in ipv6-first mode', (): void => {
  const planner = createTunnelPlanner('ipv6-first');
  const plan = planner.plan({
    coreIpv4: '10.25.0.1',
    coreIpv6: 'fd7a:115c:a1e0::1',
    authKey: 'k1',
  });

  expect(plan).not.toBeNull();
  expect(plan).toMatchObject({
    mode: 'P2P',
    endpoint: 'fd7a:115c:a1e0::1',
    family: 'ipv6',
    hasAuthKey: true,
  });
});

test('tunnel planner supports ipv6-only scenario', (): void => {
  const planner = createTunnelPlanner('ipv6-first');
  const plan = planner.plan({
    coreIpv6: 'fd7a:115c:a1e0::1',
    authKey: 'k2',
  });

  expect(plan?.mode).toBe('P2P');
  expect(plan?.family).toBe('ipv6');
});

test('tunnel planner falls back to relay when no direct endpoint exists', (): void => {
  const planner = createTunnelPlanner('dual-stack');
  const plan = planner.plan({
    authKey: 'k3',
    derpMap: {
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
  });

  expect(plan).toMatchObject({
    mode: 'RELAY',
    endpoint: 'relay-1.example.com',
    family: 'ipv4',
  });
});
