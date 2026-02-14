import { expect, test } from 'bun:test';
import { parseDerpMap } from '../services/network/contract';

test('parseDerpMap parses valid DERP map payload', (): void => {
  const parsed = parseDerpMap({
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
  });

  expect(parsed).not.toBeNull();
  expect(parsed?.Regions['1']?.Nodes[0]?.HostName).toBe('relay-1.example.com');
});

test('parseDerpMap rejects malformed payload', (): void => {
  expect(parseDerpMap({ Regions: [] })).toBeNull();
});
