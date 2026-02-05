import { styleText } from 'node:util';

const CLEAR = '\r\x1b[K';
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function startSpinner(message: string): () => void {
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${styleText("gray", `${FRAMES[i++ % FRAMES.length]} ${message}`)}`);
  }, 80);

  return () => {
    clearInterval(interval);
    process.stdout.write(CLEAR);
  };
}
