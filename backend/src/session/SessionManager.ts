// 1. usuario ya tiene config?
//   1,1 si => continuar con ciclo basico de session
//   1.2 no => hacer trigger de proceso de configuracion
//  config
//  provider configuration and model

import { Provider } from "@/types/providers";
import { generateSessionId } from "@/utils/session";
// const CLASSIFICATION_PROMPT =
//   'Analiza el prompt del usuario y responde estrictamente en JSON con este formato: {\"is_image_generation\": boolean}."';

interface SessionManager {
  provider?: Provider;
  sessionId: string;
  // load default config
  initialize: () => Promise<void>;
  changeProvider: () => Promise<boolean>;
  changeModel: () => Promise<boolean>;
  compactSession: () => Promise<boolean>;
  ask(prompt: string): () => ReturnType<Provider["ask"]>;
  // internal
  // la idea es agharrar el propmt pasaarlo por un agent peque;o que no consuma mucho y preguntarle que tipo de accion es textGeneration or imageGeneration para luego enrutarlo a la accion correcta del provider (jev)
  // classifyAction:(prompt)=> Promise<ClassifiedAction>
}

class SessionManaager {
  // categori
  id = generateSessionId();
  // provider: Provider;

  async initialize() {
    // await provider.initialize();
  }

  changeProvider() {}
  changeModel() {}
  compactSession() {}
}
