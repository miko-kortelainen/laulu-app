export const testGatewayURL = 'https://gateway.ai.cloudflare.com/v1/offline-account/offline-gateway';

export function configureTestGateway(): () => void {
  const values = {
    CF_AI_GATEWAY_ACCOUNT_ID: 'offline-account',
    CF_AI_GATEWAY_ID: 'offline-gateway',
    CF_AI_GATEWAY_TOKEN: 'offline-gateway-token',
    CF_AI_GATEWAY_NEBIUS_SLUG: 'nebius',
    CF_AI_GATEWAY_QWENCLOUD_SLUG: 'qwencloud',
  };
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  Object.assign(process.env, values);

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
