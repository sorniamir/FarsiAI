import fs from 'node:fs';

const path = 'apps/api/src/ai/agent-v2.ts';
const source = fs.readFileSync(path, 'utf8');
const pattern = /function isDirectSimpleWriteTask\(task: string\): boolean \{[\s\S]*?\n\}\n\nfunction hasSuccessfulWrite/;
if (!pattern.test(source)) throw new Error('direct-write classifier target not found');

const replacement = `function isDirectSimpleWriteTask(task: string): boolean {
  const hasFile = /(?:فایل|file)\\s+(?:(?:به\\s*نام|بنام|named|called)\\s+)?["'\\\`“]?[^\\s"'\\\`”]+\\.[a-zA-Z0-9]{1,12}/iu.test(task);
  const hasWriteVerb = /(?:بنویس|بذار|بزار|قرار\\s+بده|write|containing)/iu.test(task);
  const hasContentTarget = /(?:داخل(?:ش|\\s+آن)?|محتوا(?:ی|یش)?|with\\s+(?:the\\s+)?content|containing)/iu.test(task);
  if (!hasFile || !hasWriteVerb || !hasContentTarget) return false;

  // A filename such as test.txt or literal content such as "FarsiAI Codex Test" must not
  // turn a simple create-file request into a complex testing task. Only explicit secondary
  // engineering actions make the request complex.
  const complexAction = /(?:\\b(?:fix|debug|refactor|build|run|install|verify|review|inspect|execute)\\b|برطرف|دیباگ|ریفکتور|بیلد|اجرا|نصب|بررسی|چک|تست\\s+(?:کن|بگیر|اجرا))/iu.test(task);
  return !complexAction;
}

function hasSuccessfulWrite`;

fs.writeFileSync(path, source.replace(pattern, replacement));
console.log('direct-write classifier fixed');
