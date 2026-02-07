import { deepbook } from '@mysten/deepbook-v3';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443',
})['$extend'](deepbook({ address: process.env.SUI_ADDRESS || '0x0' }));

const data = await client.deepbook.getLevel2Range('SUI_DBUSDC', 0.01, 1000, true);
console.log(data);
