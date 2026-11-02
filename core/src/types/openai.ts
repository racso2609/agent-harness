export interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface OpenAIFunctionCall {
  name?: string;
  arguments?: string;
}

export interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: "function";
  function?: OpenAIFunctionCall;
}

export interface OpenAIStreamDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAIToolCallDelta[];
}

export interface OpenAIStreamChoice {
  delta?: OpenAIStreamDelta;
  finish_reason?: string | null;
}

export interface OpenAIStreamChunk {
  choices?: OpenAIStreamChoice[];
  usage?: OpenAIChatUsage;
}

export interface OpenAIToolCallPayload {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OpenAIToolCallPayload[];
  tool_call_id?: string;
}

export interface OpenAIToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface OpenAIModelsResponse {
  object: string;
  data: Datum[];
  pricing_version: string;
  pricing_checked_at: Date;
  pricing_updated_at: Date;
}

export interface OpenAIImageResponse {
  created: number;
  data: ({ url: string; revised_prompt: string } | { b64_json: string })[];
  request_id: string;
  billing: {
    status: "settled";
    billed_cost_usd: `${number}`;
    currency: "USD";
    zero_data_retention: boolean;
    effective_discount_percent: number;
  };
}

export interface Datum {
  id: string;
  context_length: number | null;
  max_output_tokens: number | null;
  object: Object;
  owned_by: string;
  provider: string;
  type: Type;
  endpoint: Endpoint;
  supported_endpoints: Endpoint[];
  capabilities: Capabilities;
  is_free: boolean;
  available_until: null;
  pricing: Pricing;
}

export interface Capabilities {
  vision: boolean;
  video: boolean;
  reasoning: boolean;
  streaming: boolean;
  image_generation: boolean;
  image_edit: boolean;
}

export type Endpoint =
  | "/v1/chat/completions"
  | "/v1/videos/generations"
  | "/v1/images/generations"
  | "/v1/responses"
  | "/v1/completions"
  | "/v1/messages";

export type Object = "model";

export interface Pricing {
  currency: Currency;
  input_per_million: string;
  cache_read_input_per_million: string;
  cache_write_input_per_million: string;
  output_per_million: string;
  image_output_per_million: null | string;
  media_input_unit_price: null;
  media_unit_price: null | string;
  media_unit: Unit | null;
  resolution_prices: ResolutionPrices;
  reference_resolution_prices: ResolutionPrices;
  image_pricing_unit: Unit;
  discount_percent: string;
  input_token_price_threshold: number | null;
  above_threshold: AboveThreshold | null;
  source: Source;
  list_input_per_million: string;
  list_output_per_million: string;
  zero_data_retention: boolean;
  zero_data_retention_route: ZeroDataRetentionRoute;
  default_scope: DefaultScopeClass;
  scopes: ScopeElement[];
}

export interface AboveThreshold {
  input_token_price_threshold: number;
  applies_when: AppliesWhen;
  input_per_million: string;
  cache_read_input_per_million: string;
  cache_write_input_per_million: string;
  output_per_million: string;
  list_input_per_million: string;
  list_cache_read_input_per_million: string;
  list_cache_write_input_per_million: string;
  list_output_per_million: string;
}

export type AppliesWhen = "prompt_tokens_above_threshold";

export type Currency = "USD";

export interface DefaultScopeClass {
  zdr: boolean;
  model: string;
  region: null;
  protocol: Protocol;
  serviceTier: ServiceTier;
  pricingVariant: PricingVariant;
}

export type PricingVariant = "default" | "1080p" | "480p" | "4k" | "720p";

export type Protocol =
  | "chat_completions"
  | "video_generations"
  | "images_generations"
  | "responses"
  | "completions"
  | "messages";

export type ServiceTier = "standard" | "flex" | "priority" | "ultrafast";

export type Unit = "token" | "second" | "image";

export interface ResolutionPrices {
  "1080P"?: string;
  "480P"?: string;
  "4K"?: string;
  "720P"?: string;
}

export interface ScopeElement {
  id: string;
  version: string;
  scope: DefaultScopeClass;
  discount: string;
  tiers: Tier[];
  makerTiers: Tier[];
  effectiveAt: number;
  expiresAt: number;
}

export interface Tier {
  id: string;
  rates: Rates;
  maxContext: number | null;
  minContext: number;
}

export interface Rates {
  input_tokens?: string;
  output_tokens?: string;
  cache_read_tokens?: string;
  cache_write_1h_tokens?: string;
  cache_write_5m_tokens?: string;
  seconds?: string;
  images?: string;
  image_output_tokens?: string;
}

export type Source = "catalog";

export type ZeroDataRetentionRoute = "none" | "discounted" | "rail_only";

export type Type = "text" | "video" | "image";
