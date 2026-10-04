type GatewayProvider = 'nebius' | 'google-ai-studio' | 'qwencloud';

interface AiGateway {
  baseURL: string;
  fetch: typeof globalThis.fetch;
}

// USD per token, converted from the user's rates per million tokens.
const customPrices: Record<string, { per_token_in: number; per_token_out: number }> = {
  'nebius/nvidia/nemotron-3-super-120b-a12b': { per_token_in: 0.00000030, per_token_out: 0.00000090 },
  'nebius/zai-org/GLM-5.3-Flash': { per_token_in: 0.00000015, per_token_out: 0.00000050 },
  'qwencloud/qwen3.8-omni-flash': { per_token_in: 0.00000015, per_token_out: 0.00000047 },
};

export function getAiGateway(provider: GatewayProvider, modelId?: string): AiGateway {
  const accountId = process.env.CF_AI_GATEWAY_ACCOUNT_ID?.trim();
  const gatewayId = process.env.CF_AI_GATEWAY_ID?.trim();
  const token = process.env.CF_AI_GATEWAY_TOKEN?.trim();
  if (!accountId || !gatewayId || !token) {
    throw new Error('set CF_AI_GATEWAY_ACCOUNT_ID, CF_AI_GATEWAY_ID, and CF_AI_GATEWAY_TOKEN in backend/.env.');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId) || !/^[a-zA-Z0-9_-]+$/.test(gatewayId)) {
    throw new Error('cloudflare account and gateway IDs must contain only letters, numbers, underscores, and hyphens.');
  }

  let route: string = provider;
  if (provider !== 'google-ai-studio') {
    const slug = (provider === 'nebius'
      ? process.env.CF_AI_GATEWAY_NEBIUS_SLUG
      : process.env.CF_AI_GATEWAY_QWENCLOUD_SLUG)?.trim() || provider;
    if (!/^[a-zA-Z0-9-]+$/.test(slug)) {
      throw new Error('cloudflare custom provider slugs must contain only letters, numbers, and hyphens.');
    }
    route = `custom-${slug}/${provider === 'nebius' ? 'v1' : 'compatible-mode/v1'}`;
  }
  const baseURL = `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${route}`;
  const price = modelId ? customPrices[`${provider}/${modelId}`] : undefined;

  return {
    baseURL,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (!request.url.startsWith(`${baseURL}/`)) {
        throw new Error('AI request does not match the configured cloudflare provider endpoint.');
      }
      // SDKs require a key and add its header. BYOK resolves stored keys only when that header is absent.
      request.headers.delete('authorization');
      request.headers.delete('x-goog-api-key');
      request.headers.set('cf-aig-authorization', `Bearer ${token}`);
      request.headers.set('cf-aig-skip-cache', 'true');
      request.headers.set('cf-aig-max-attempts', '1');
      request.headers.set('cf-aig-no-wholesale', 'true');
      if (price) {
        request.headers.set('cf-aig-custom-cost', JSON.stringify(price));
      }
      return await globalThis.fetch(request);
    },
  };
}
