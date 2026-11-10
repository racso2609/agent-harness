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
  signal?: AbortSignal,
): Promise<ClassifiedAction> => {
  // Already cancelled: do not spend a classification request either.
  if (signal?.aborted) throw signal.reason;
  try {
    const { turn } = await provider.chat(
      [
        {
          role: "user",
          content: `${CLASSIFICATION_PROMPT}\n\nPrompt: ${prompt}`,
        },
      ],
      { signal },
    );
    const parsed = normalize(turn.text);

    if (typeof parsed?.is_image_generation === "boolean")
      return parsed.is_image_generation ? "imageGeneration" : "textGeneration";

    return heuristic(prompt);
  } catch (err) {
    // An abort is not a classification failure: it is re-thrown
    // instead of being swallowed by the heuristic, so a cancelled
    // turn never continues on a guess.
    if (signal?.aborted) throw signal.reason ?? err;

    logger.debug({ err }, "classification failed, falling back to heuristic");
    return heuristic(prompt);
  }
};
