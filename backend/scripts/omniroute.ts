import { OpenAiProvider } from "@/providers/openai";
import dotenv from "dotenv";
dotenv.config();

const url = "https://api.cheaperinference.com/v1";
const apikey = process.env.OMNIROUTE_API_KEY!;
const model = "deepseek-v4.1-flash-1017";

const provider = new OpenAiProvider(url, apikey, model);

(async () => {
  await provider.getAvailableModels();

  console.log(await provider.ask("listame los archivos de este dir"));
})();
