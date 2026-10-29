import { OpenAiProvider } from "@/providers/openai";
import { printImage } from "@/utils/stdin";
import dotenv from "dotenv";
dotenv.config();

const url = "https://api.cheaperinference.com/v1";
const apikey = process.env.OMNIROUTE_API_KEY!;
const model = "deepseek-v4.1-flash-1017";
const imageModel = "qwen-image";

const provider = new OpenAiProvider(url, apikey, imageModel);

(async () => {
  await provider.getAvailableModels();

  const data = await provider.generateImage("crea una imagen de un bosque");
  for (const image of data.images) {
    await printImage(image.url);
  }
})();
