import type {
  ModelStreamEvent,
  ModelStreamInput,
  ProviderAdapter,
} from "@/agent/models/ProviderAdapter";
import { DeepSeekProviderAdapter } from "@/agent/models/providers/deepseek";

export class ModelRouter {
  constructor(private readonly provider: ProviderAdapter = new DeepSeekProviderAdapter()) {}

  stream(input: ModelStreamInput): AsyncGenerator<ModelStreamEvent> {
    return this.provider.stream(input);
  }
}
