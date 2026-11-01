import fs from "node:fs";
import path from "node:path";
import { OpenAiProvider } from "@/providers/openai";
import { env } from "@/utils/env";

const url = "https://api.cheaperinference.com/v1";
const apikey = env.OMNIROUTE_API_KEY!;
const imageModel = "qwen-image";
const outDir = path.join(process.cwd(), "omniroute-out");

const provider = new OpenAiProvider(url, apikey, imageModel);

(async () => {
  await provider.getAvailableModels();

  const data = await provider.generateImage("crea una imagen de un bosque");
  fs.mkdirSync(outDir, { recursive: true });

  data.images.forEach((image, index) => {
    const base64 = image.url.replace(/^data:image\/\w+;base64,/, "");
    const file = path.join(outDir, `image-${index + 1}.png`);
    fs.writeFileSync(file, Buffer.from(base64, "base64"));
    process.stdout.write(`Wrote ${file}\n`);
  });
})();
