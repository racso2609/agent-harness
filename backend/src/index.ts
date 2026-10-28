import { input, printLogo } from "./utils/stdin";

const handleSession = async () => {
  printLogo();
  while (true) {
    const answer = await input("Type your prompt: ");
    console.log(answer);
  }
};

const cleanup = () => {
  // ASCII for Ctrl+L
  console.log("Ctrl+L detected");
  // Handle your custom logic here, e.g., clear screen manually
  process.stdout.write("\x1Bc");
  printLogo();
  process.stdout.write("Type your prompt: ");
};

process.stdin.setRawMode(true);
process.stdin.resume();

process.stdin.on("data", (buf) => {
  const char = buf.toString().charCodeAt(0);

  if (char === 0x0c) cleanup();
});

handleSession();
