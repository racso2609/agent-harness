import { Provider } from "@/types/providers";
import { logger } from "@/utils/logger";

export const CLASSIFICATION_PROMPT = `Analiza el prompt del usuario y responde estrictamente en JSON con este formato: {"is_image_generation": boolean}.`;

export type ClassifiedAction = "imageGeneration" | "textGeneration";

const IMAGE_KEYWORDS =
  /\b(image|imagen|picture|foto|photo|illustration|ilustraci[oó]n|draw|dibuja|render|logo|wallpaper|avatar|banner|poster|thumbnail|portada)\b/i;

const normalize = (raw: string) => {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as { is_image_generation?: unknown };
  } catch {
    return null;
  }
};

const heuristic = (prompt: string): ClassifiedAction =>
  IMAGE_KEYWORDS.test(prompt) ? "imageGeneration" : "textGeneration";

export const classifyAction = async (
  prompt: string,
  provider: Provider,
): Promise<ClassifiedAction> => {
  try {
    const { text } = await provider.ask(
      `${CLASSIFICATION_PROMPT}\n\nPrompt: ${prompt}`,
    );
    const parsed = normalize(text);

    if (typeof parsed?.is_image_generation === "boolean")
      return parsed.is_image_generation ? "imageGeneration" : "textGeneration";

    return heuristic(prompt);
  } catch (err) {
    logger.debug({ err }, "classification failed, falling back to heuristic");
    return heuristic(prompt);
  }
};
