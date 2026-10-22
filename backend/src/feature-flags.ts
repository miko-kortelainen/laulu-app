import { getClient, type IConfigCatClient } from '@configcat/sdk/node';

let client: IConfigCatClient | undefined;

export async function paidTiersEnabled(): Promise<boolean> {
  const sdkKey = process.env.CONFIGCAT_SDK_KEY;
  if (!sdkKey) return false;

  try {
    client ??= getClient(sdkKey);
    return await client.getValueAsync('paidTiersEnabled', false);
  } catch {
    console.error('could not evaluate the paid tiers flag.');
    return false;
  }
}
